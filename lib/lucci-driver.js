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

// How long to hold a reconstructed frame while hoping for a full-length one,
// in milliseconds.
//
// Pairing is the one caller that cannot check an address after the fact: every
// other path compares a received frame against the address it already has, and
// pairing is what establishes that address. A reconstructed 24-symbol frame has
// one inferred symbol — and under the leading-bit reading that symbol *is*
// address bit 0 (see completeFrame) — so pairing on one risks an address off by
// a bit, which gives a device that is added, looks fine and never works.
//
// It is a preference rather than a requirement, because a receiver that only
// ever delivers 24 symbols would otherwise be impossible to pair, which is the
// failure the 24-symbol allowance exists to avoid. On the observed hardware the
// full frame followed the short one by 38ms within a single press, so this costs
// nothing in practice: 750ms covers a whole 423ms press and then some, and is
// imperceptible inside a 30-second window.
const FULL_FRAME_GRACE = 750;

// Ambient 433 MHz traffic occasionally fits our timings. The unrecognised-frame
// log exists to diagnose a silent receiver, not to narrate the airwaves, so it
// is throttled to one line per minute with a count of what it skipped.
const UNRECOGNISED_LOG_INTERVAL = 60000;

class LucciDriver extends Homey.Driver {
    async onInit() {
        this.learnAttempts = 0;
        this.unrecognisedSinceLog = 0;
        this.lastUnrecognisedLog = 0;

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

        // Bit 24 is unresolved: even parity and a constant zero fit all sixteen
        // recorded codes equally (RF_PROTOCOL.md). This is the line that would
        // settle it — it can only appear for a handset whose address has odd
        // weight, and it means the bit is a constant zero. The frame is acted on
        // either way; see identifyFrame on why a mismatch is not a rejection.
        if (frame.parityOk === false) {
            this.log(`rx ${frame.key}: ${describeFrame(payload)} — bit 24 is not even parity`);
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
                let grace = null;
                // A reconstructed frame's address, held in case a full-length
                // one follows. Resolved with if none does.
                let fallback = null;

                const settle = (fn, arg) => {
                    for (const pending of [timer, grace]) {
                        if (pending !== null) clearTimeout(pending);
                    }
                    timer = null;
                    grace = null;
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
                    if (!frame.restored) {
                        log(`matched ${frame.key} on a full frame; address:`, frame.address.join(''));
                        settle(resolve, frame.address);
                        return;
                    }

                    // One symbol of this frame was inferred rather than heard,
                    // and in the leading-bit case that symbol is part of the
                    // address. Worth waiting a moment for a frame that needed no
                    // inferring; see FULL_FRAME_GRACE.
                    if (fallback !== null) return;
                    fallback = frame.address;
                    log(`matched ${frame.key} on a restored frame; holding ${FULL_FRAME_GRACE}ms for a full one`);

                    grace = setTimeout(() => {
                        log('no full frame arrived; pairing on the restored one:', fallback.join(''));
                        settle(resolve, fallback);
                    }, FULL_FRAME_GRACE);
                };

                timer = setTimeout(() => {
                    log(`timed out after ${LEARN_TIMEOUT}ms; ${heard} frame(s) heard`);
                    settle(reject, new Error(this.homey.__('pair.timeout')));
                }, LEARN_TIMEOUT);

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
