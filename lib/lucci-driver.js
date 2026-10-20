'use strict';

// What the fan and the light drivers share: one 433 MHz signal, one receiver to
// reference count, and one way to learn an address off the handset.
//
// They share it because the handset does. Every frame carries the same 16-bit
// address whichever selector it has, so a light button pairs a fan and a fan
// button pairs a light — and the pairing logic has enough judgement in it (the
// full-frame preference, what counts as a press) that two copies would drift
// apart on exactly the parts that took hardware to settle.

const Homey = require('homey');
const { describeFrame, sameAddress } = require('./lucci-protocol');

// How long to listen for a button press before giving up, in milliseconds.
const LEARN_TIMEOUT = 30000;

// Pairing takes an address only from a frame whose every symbol was heard.
//
// It is the one caller with nothing stored to check a result against — it is
// what establishes both the address and bit 24 — and this receiver truncates a
// burst's first frame. The two truncations lose opposite ends: the leading one
// drops address bit 0, the trailing one drops bit 24. Neither is recoverable,
// bit 24 being no rule and address bit 0 having been recoverable only from that
// rule, so neither frame is enough to pair on.
//
// It costs nothing observed: the full-length twin of that first frame arrived
// 70ms later, well inside a single press. It would make a receiver that only
// ever delivers 24 symbols unpairable — and that is the better failure, because
// it is loud and says so, while a guessed address or a guessed bit 24 gives a
// device that is added, looks right and drives nothing.

class LucciAirDriver extends Homey.Driver {
    async onInit() {
        this.learnAttempts = 0;

        // How long a learn step listens. An instance field rather than the
        // constant directly, so a test can wait a few milliseconds for the
        // timeout path instead of thirty seconds.
        this.learnTimeout = LEARN_TIMEOUT;

        // The receiver belongs to the app, because Homey's enableRX acts on
        // the signal rather than on the caller — so the count of who wants it
        // has to be one count, not one per driver. See app.js.
    }

    // Both of these are the app's, and are here because devices reach their
    // driver rather than the app. Reference counted there, once.
    registerRXListener(listener) {
        return this.homey.app.registerRXListener(listener);
    }

    unregisterRXListener(listener) {
        return this.homey.app.unregisterRXListener(listener);
    }

    async onPair(session) {
        // What was learned from the handset in this pairing session.
        let learned = null;

        session.setHandler('learn', async () => {
            learned = null;
            learned = await this.learnAddress(session);
        });

        session.setHandler('list_devices', async () => {
            if (learned === null) {
                // Reachable: the learn step asks for Homey's nav bar, so its
                // Continue button is live under the view from the moment it
                // opens, before any handset has been heard. Saying so beats
                // handing back an empty list, which reads as "you have no
                // devices".
                this.log('[pair] list_devices called with no learned address');
                throw new Error(this.homey.__('pair.not_learned'));
            }

            this.reportLearned(learned);
            return this.devicesFor(learned);
        });
    }

    // Says what was learned relative to what is already paired.
    //
    // **There are no channels in this protocol.** The 16-bit address is the
    // whole of a unit's identity, so a second fan is a second address and
    // nothing else — and whether two handsets can share an address is an open
    // caveat in RF_PROTOCOL.md, not a settled fact. This is where that would
    // show up, so it says which case the user is in rather than leaving a
    // collision to look like "no new devices found".
    //
    // Diagnostic only. It decides nothing.
    reportLearned({ address, bit24 }) {
        const paired = typeof this.getDevices === 'function' ? this.getDevices() : [];
        const mine = paired.map(device => ({
            name: typeof device.getName === 'function' ? device.getName() : '?',
            address: device.getStoreValue('address'),
            bit24: device.getStoreValue('bit24'),
        }));

        const same = mine.filter(d => sameAddress(d.address, address));
        if (mine.length === 0) {
            this.log('[pair] the first of this kind');
            return;
        }
        if (same.length === 0) {
            this.log(`[pair] a different handset from the ${mine.length} already paired;`
                + ' separate address, so separate devices');
            return;
        }

        const differs = same.filter(d => d.bit24 !== bit24);
        if (differs.length > 0) {
            // The case that would matter: two units sharing an address and
            // telling themselves apart by bit 24, which the device id does not
            // include — so Homey would see them as one device. Nothing has shown
            // this yet, and it would be a finding about the protocol rather than
            // a bug in the app.
            this.error(`[pair] same address as ${differs[0].name} but bit 24 ${bit24}`
                + ` where that one has ${differs[0].bit24}: two units are sharing an address,`
                + ' and the device id does not distinguish them. See RF_PROTOCOL.md.');
            return;
        }

        this.log(`[pair] this is ${same[0].name}, already paired;`
            + ' Homey will offer it as already added');
    }

    // What this driver offers once an address is learned. One device here, but
    // the shape is a list because that is what Homey wants and because the
    // sibling Bear app offers five.
    //
    // The id is built from the address, which makes it stable across re-pairs
    // and unique if a household has more than one Lucci Air handset. The name comes
    // from the driver manifest, so it stays in step with it and in the user's
    // language.
    devicesFor({ address, bit24 }) {
        return [
            {
                name: this.nameFor(),
                data: { id: `${this.deviceIdPrefix}-${address.join('')}` },
                // bit24 may be null, when the frame that carried the address was
                // one the receiver truncated at the other end. buildFrame then
                // falls back, as it does for a device paired before this field
                // existed.
                store: { address, bit24 },
            },
        ];
    }

    // What to call a newly offered device.
    //
    // The driver manifest's name, so it stays in step with it and in the user's
    // language — numbered once there is more than one, because two fans in a
    // house would otherwise both arrive called "Ceiling fan" and picking the
    // right one in the list would be guesswork. The user renames it anyway; this
    // only has to be distinguishable at the moment of adding.
    nameFor() {
        const base = this.homey.__(this.manifest.name);
        const paired = typeof this.getDevices === 'function' ? this.getDevices() : [];
        return paired.length === 0 ? base : `${base} ${paired.length + 1}`;
    }

    // Listens for a frame from a physical Lucci Air handset and returns what Homey
    // needs to transmit as that handset: the address, and the bit 24 it sent.
    //
    // This clones the handset rather than inventing an address and teaching it
    // to the fan, so it needs only the remote the user already has and leaves
    // the fan's own pairing untouched.
    async learnAddress(session) {
        const attempt = ++this.learnAttempts;
        const log = (...args) => this.log(`[pair #${attempt}]`, ...args);
        let heard = 0;

        log('listening for a button press');

        let listener = null;
        const stop = async () => {
            if (listener !== null) {
                await this.unregisterRXListener(listener).catch(() => {});
                listener = null;
            }
        };

        try {
            return await new Promise((resolve, reject) => {
                let timer = null;
                // Frames heard whose address had a guessed bit, so none of them
                // could be paired on.
                let restoredOnly = 0;

                const settle = (fn, arg) => {
                    if (timer !== null) clearTimeout(timer);
                    timer = null;
                    stop().then(() => fn(arg));
                };

                listener = (frame, isFirst, payload) => {
                    // Counted per frame Homey reports as the start of a burst,
                    // which is not the same as per press: on this receiver one
                    // press of Fan Off came through as a restored frame and then
                    // a full one 70ms later, both flagged first, and the view
                    // showed two. That is why the view's label says signals
                    // rather than presses — two signals is what was heard.
                    //
                    // Every frame is considered below either way, because the
                    // full-length one can arrive as a later frame of the same
                    // burst.
                    if (isFirst !== false) {
                        heard += 1;
                        log(`heard #${heard}: ${frame.key}`);

                        // The progress counter is the view's, and the view may
                        // have navigated away. Guarded rather than awaited,
                        // because a failure to update a number on screen must
                        // not cost the user the press it was counting —
                        // onPayload catches what a listener throws and logs it,
                        // so the frame would be dropped and pairing would look
                        // as though nothing had been heard.
                        try {
                            session.emit('rx', { heard, command: frame.key })?.catch?.(() => {});
                        } catch (err) {
                            log('could not update the view:', err.message);
                        }
                    }

                    // Any button will do. identifyFrame has already held the
                    // frame to the layout — 24 or 25 bits, a selector of 10 or
                    // 01, one of the sixteen known command tails — and that
                    // structural check is what stops pairing latching onto an
                    // unrelated 433 MHz device in range. A light button carries
                    // the same address as a fan button, so pressing one is no
                    // less valid.
                    if (!frame.restored) {
                        // Bit 24 comes from the handset because it cannot be
                        // computed from anything else. One press is one sample
                        // of it, which is all a learn step ever sees; whether it
                        // is constant across a handset's sixteen commands is
                        // checked at runtime instead, where there are thousands
                        // of frames to check it against. See LucciAirDevice.
                        log(`matched ${frame.key}; address ${frame.address.join('')},`
                            + ` bit 24 ${frame.bit24 === null ? 'not heard' : frame.bit24}`);
                        settle(resolve, { address: frame.address, bit24: frame.bit24 });
                        return;
                    }

                    // **A symbol of this frame never arrived**, and pairing
                    // needs every one: the whole address, so it knows whose fan
                    // this is, and bit 24, which cannot be derived from anything
                    // else. The two truncations lose opposite ends, so neither
                    // is enough. Counted and said once, because "heard plenty,
                    // paired nothing" needs an explanation in the log.
                    restoredOnly += 1;
                    if (restoredOnly === 1) {
                        log(`heard ${frame.key} on an incomplete frame (${describeFrame(payload)});`
                            + ' waiting for a full-length one, which this receiver sends'
                            + ' within a press. See "Bit 24" in RF_PROTOCOL.md.');
                    }
                };

                timer = setTimeout(() => {
                    log(`timed out after ${this.learnTimeout}ms; ${heard} frame(s) heard,`
                        + ` ${restoredOnly} of them missing a leading bit`);
                    // A different message when frames were arriving and none was
                    // usable: that is a radio that needs moving closer, not a
                    // handset that was never pressed.
                    const reason = restoredOnly > 0 && heard === restoredOnly
                        ? 'pair.timeout_restored'
                        : 'pair.timeout';
                    settle(reject, new Error(this.homey.__(reason)));
                }, this.learnTimeout);

                this.registerRXListener(listener).catch(err => {
                    log('could not enable RX:', err.message);
                    settle(reject, err);
                });
            });
        } finally {
            await stop();
        }
    }
}

module.exports = LucciAirDriver;
