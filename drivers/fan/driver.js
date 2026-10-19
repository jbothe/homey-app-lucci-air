'use strict';

const Homey = require('homey');
const { SIGNAL_ID, identifyFrame, describeFrame } = require('../../lib/lucci-protocol');

// How long to listen for a button press before giving up, in milliseconds.
const LEARN_TIMEOUT = 30000;

// Ambient 433 MHz traffic occasionally fits our timings. The unrecognised-frame
// log exists to diagnose a silent receiver, not to narrate the airwaves, so it
// is throttled to one line per minute with a count of what it skipped.
const UNRECOGNISED_LOG_INTERVAL = 60000;

class LucciFanDriver extends Homey.Driver {
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
                // handing back an empty list, which reads as "you have no fans".
                this.log('[pair] list_devices called with no learned address');
                throw new Error(this.homey.__('pair.not_learned'));
            }

            return [
                {
                    // Take the name from the driver manifest so it stays in step
                    // with it, and in the user's language.
                    name: this.homey.__(this.manifest.name),
                    // The address makes this stable across re-pairs, and unique
                    // if a household has more than one Lucci handset.
                    data: { id: `lucci-fan-${address.join('')}` },
                    store: { address },
                },
            ];
        });
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

                const settle = (fn, arg) => {
                    if (timer !== null) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    stop().then(() => fn(arg));
                };

                listener = (frame, isFirst) => {
                    // Each press is transmitted nine times; only count it once.
                    if (isFirst === false) return;

                    heard += 1;
                    log(`heard #${heard}: ${frame.key}`);
                    session.emit('rx', { heard, command: frame.key }).catch(() => {});

                    // Any button will do. identifyFrame has already held the
                    // frame to the layout — 24 or 25 bits, a selector of 10 or
                    // 01, one of the sixteen known command tails, and parity —
                    // and that structural check is what stops pairing latching
                    // onto an unrelated 433 MHz device in range. A light button
                    // carries the same address as a fan button, so pressing one
                    // is no less valid.
                    log(`matched ${frame.key}; address:`, frame.address.join(''));
                    settle(resolve, frame.address);
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

module.exports = LucciFanDriver;
