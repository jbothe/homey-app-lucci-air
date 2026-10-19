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
const { SIGNAL_ID, identifyFrame, describeFrame } = require('./lucci-protocol');

// How long to listen for a button press before giving up, in milliseconds.
const LEARN_TIMEOUT = 30000;

// Pairing takes an address only from a frame whose every bit was heard.
//
// It is the one caller that cannot check an address afterwards — it is what
// establishes the address — and this receiver drops the leading bit of a burst's
// first frame, which is address bit 0. That bit was briefly recoverable from bit
// 24, until the radio showed bit 24 is not parity (see RF_PROTOCOL.md), so it is
// now a guess with a one-in-two chance of being wrong.
//
// Requiring a full frame costs nothing observed: the full-length twin of that
// first frame arrived 70ms later, well inside a single press. It would make a
// receiver that only ever delivers 24 symbols unpairable — and that is the
// better failure, because it is loud and says so, while a wrong address gives a
// device that is added, looks right and never works.

// Ambient 433 MHz traffic occasionally fits our timings. The unrecognised-frame
// log exists to diagnose a silent receiver, not to narrate the airwaves, so it
// is throttled to one line per minute with a count of what it skipped.
const UNRECOGNISED_LOG_INTERVAL = 60000;

class LucciDriver extends Homey.Driver {
    async onInit() {
        this.learnAttempts = 0;
        this.unrecognisedSinceLog = 0;
        this.lastUnrecognisedLog = 0;
        this.unparitySinceLog = 0;
        this.lastUnparityLog = 0;

        // How long a learn step listens. An instance field rather than the
        // constant directly, so a test can wait a few milliseconds for the
        // timeout path instead of thirty seconds.
        this.learnTimeout = LEARN_TIMEOUT;

        // RX is shared, and reference counted because Homey's enableRX is
        // per-signal rather than per-listener: pairing finishing must not switch
        // RX off for whatever else is listening. So far only pairing listens —
        // the device transmits and does not yet follow the handset.
        this.rxListeners = new Set();
        this.signal = this.homey.rf.getSignal433(SIGNAL_ID);
        this.signal.on('payload', this.onPayload.bind(this));
    }

    onPayload(payload, isFirst, deviation) {
        const frame = identifyFrame(payload);
        if (frame === null) {
            // Log rather than drop silently. Homey gives the identical symptom —
            // enableRX() resolving while no payload ever reaches a listener —
            // whether frames are not arriving at all or arriving and failing to
            // decode, and this line is what tells those two apart. On the
            // sibling apps it found every one of the receive bugs listed under
            // "Receiving" in RF_PROTOCOL.md.
            this.unrecognisedSinceLog += 1;
            const now = Date.now();
            if (now - this.lastUnrecognisedLog < UNRECOGNISED_LOG_INTERVAL) return;

            const skipped = this.unrecognisedSinceLog - 1;
            this.log(`rx unrecognised: ${describeFrame(payload)}`
                + ` [${Array.isArray(payload) ? payload.join('') : payload}]`
                + `${deviation === undefined ? '' : ` dev ${deviation}`}`
                + (skipped > 0 ? ` (+${skipped} more in the last minute)` : ''));
            this.lastUnrecognisedLog = now;
            this.unrecognisedSinceLog = 0;
            return;
        }

        // **This line settled bit 24, and settled it against the hypothesis.**
        // It means bits 0-23 held an even number of ones and bit 24 was 1, so
        // the bit is neither even parity nor the constant zero all 33
        // recordings showed — see RF_PROTOCOL.md. It appeared in thousands, off
        // a transmitter whose address is not this one's.
        //
        // Throttled for the same reason the unrecognised-frame log is: a held
        // button is dozens of frames a second, and a diagnostic that drowns the
        // log it is written in is worse than none. The payload and the address
        // go with it, which the first version of this line omitted and which is
        // exactly what was needed to tell a second handset from a broken rule.
        if (frame.parityOk === false) {
            this.unparitySinceLog += 1;
            const now = Date.now();
            if (now - this.lastUnparityLog >= UNRECOGNISED_LOG_INTERVAL) {
                const skipped = this.unparitySinceLog - 1;
                this.log(`rx ${frame.key} with bit 24 set where even parity wants 0`
                    + ` — so bit 24 is not parity; address ${frame.address.join('')}`
                    + ` [${payload.join('')}]`
                    + (skipped > 0 ? ` (+${skipped} more in the last minute)` : ''));
                this.lastUnparityLog = now;
                this.unparitySinceLog = 0;
            }
        }

        for (const listener of this.rxListeners) {
            try {
                listener(frame, isFirst);
            } catch (err) {
                this.error('RX listener failed:', err.message);
            }
        }
    }

    async registerRXListener(listener) {
        if (this.rxListeners.has(listener)) return;
        this.rxListeners.add(listener);

        if (this.rxListeners.size === 1) {
            await this.signal.enableRX();
            this.log(`RX enabled on signal '${SIGNAL_ID}'`);
        }
    }

    async unregisterRXListener(listener) {
        if (!this.rxListeners.delete(listener)) return;

        if (this.rxListeners.size === 0) {
            await this.signal.disableRX();
            this.log('RX disabled');
        }
    }

    async onPair(session) {
        // The address learned from the handset in this pairing session.
        let address = null;

        session.setHandler('learn', async () => {
            address = null;
            address = await this.learnAddress(session);
        });

        session.setHandler('list_devices', async () => {
            if (address === null) {
                // Reachable: the learn step asks for Homey's nav bar, so its
                // Continue button is live under the view from the moment it
                // opens, before any handset has been heard. Saying so beats
                // handing back an empty list, which reads as "you have no
                // devices".
                this.log('[pair] list_devices called with no learned address');
                throw new Error(this.homey.__('pair.not_learned'));
            }

            return this.devicesFor(address);
        });
    }

    // What this driver offers once an address is learned. One device here, but
    // the shape is a list because that is what Homey wants and because the
    // sibling Bear app offers five.
    //
    // The id is built from the address, which makes it stable across re-pairs
    // and unique if a household has more than one Lucci handset. The name comes
    // from the driver manifest, so it stays in step with it and in the user's
    // language.
    devicesFor(address) {
        return [
            {
                name: this.homey.__(this.manifest.name),
                data: { id: `${this.deviceIdPrefix}-${address.join('')}` },
                store: { address },
            },
        ];
    }

    // Listens for a frame from a physical Lucci handset and returns the address
    // it carries, so Homey can transmit as that handset.
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

                listener = (frame, isFirst) => {
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
                    if (frame.addressSure) {
                        log(`matched ${frame.key}; address:`, frame.address.join(''));
                        settle(resolve, frame.address);
                        return;
                    }

                    // **A bit of this address was guessed rather than heard**,
                    // so it is not pairable. It used to be: the leading bit was
                    // recovered from bit 24, exactly, on the assumption that bit
                    // 24 is parity — which the radio has since disproved. The
                    // guess is now a coin toss on one address bit, and pairing
                    // on it gives a device that is added, looks right and never
                    // works. Counted and said once, because "heard plenty,
                    // paired nothing" needs an explanation in the log.
                    restoredOnly += 1;
                    if (restoredOnly === 1) {
                        log(`heard ${frame.key} on a frame missing its leading bit;`
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

module.exports = LucciDriver;
