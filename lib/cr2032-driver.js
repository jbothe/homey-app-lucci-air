'use strict';

// What the CR2032 remote's two drivers share: one signal, a receiver to
// reference count, and one way to learn an address off the remote.
//
// A separate base from lucci-driver.js rather than a parameterised one, so the
// USB-C remote's pairing - which took hardware to settle, and carries
// reconstruction logic this receiver has no use for - stays exactly as it was.
// What is shared in spirit is the shell: listen, count what was heard for the
// view, and give up with a message that says which failure it was.

const Homey = require('homey');
const protocol = require('./cr2032-protocol');

// How long to listen for a button press before giving up, in milliseconds.
const LEARN_TIMEOUT = 30000;

class Cr2032Driver extends Homey.Driver {
    async onInit() {
        this.learnAttempts = 0;

        // An instance field so a test can wait a few milliseconds for the
        // timeout path instead of thirty seconds.
        this.learnTimeout = LEARN_TIMEOUT;
    }

    // The receiver belongs to the app, because Homey's enableRX acts on the
    // signal rather than on the caller. Reference counted there, per signal.
    registerRXListener(listener) {
        return this.homey.app.registerRXListener(listener, protocol);
    }

    unregisterRXListener(listener) {
        return this.homey.app.unregisterRXListener(listener, protocol);
    }

    async onPair(session) {
        let learned = null;

        session.setHandler('learn', async () => {
            learned = null;
            learned = await this.learnAddress(session);
        });

        session.setHandler('list_devices', async () => {
            if (learned === null) {
                this.log('[pair] list_devices called with no learned address');
                throw new Error(this.homey.__('pair.not_learned'));
            }

            this.reportLearned(learned);
            return this.devicesFor(learned);
        });
    }

    // Says what was learned relative to what is already paired. Diagnostic only.
    //
    // There are no channels in this protocol either: the 16-bit address is the
    // whole of a unit's identity. The case worth a loud line is one remote
    // heard with two different tails, which would be a finding about the
    // protocol and which the device id (built from the address) cannot tell
    // apart.
    reportLearned({ address, tail }) {
        const paired = typeof this.getDevices === 'function' ? this.getDevices() : [];
        const mine = paired.map(device => ({
            name: typeof device.getName === 'function' ? device.getName() : '?',
            address: device.getStoreValue('address'),
            tail: device.getStoreValue('tail'),
        }));

        if (mine.length === 0) {
            this.log('[pair] the first of this kind');
            return;
        }
        const same = mine.filter(d => protocol.sameAddress(d.address, address));
        if (same.length === 0) {
            this.log(`[pair] a different remote from the ${mine.length} already paired;`
                + ' separate address, so separate devices');
            return;
        }

        const differs = same.filter(d => !protocol.sameAddress(d.tail, tail));
        if (differs.length > 0) {
            this.error(`[pair] same address as ${differs[0].name} but tail ${tail.join('')}`
                + ` where that one has ${Array.isArray(differs[0].tail) ? differs[0].tail.join('') : differs[0].tail}:`
                + ' two units are sharing an address, and the device id does not distinguish them.'
                + ' See RF_PROTOCOL_CR2032.md.');
            return;
        }
        this.log(`[pair] this is ${same[0].name}, already paired; Homey will offer it as already added`);
    }

    // The id is built from the address, which makes it stable across re-pairs and
    // unique if a household has more than one remote. The tail goes in the store
    // beside the address and is transmitted back, never computed.
    devicesFor({ address, tail }) {
        return [
            {
                name: this.nameFor(),
                data: { id: `${this.deviceIdPrefix}-${address.join('')}` },
                store: { address, tail },
            },
        ];
    }

    // The manifest's name, numbered once there is more than one, because two
    // fans in a house would otherwise both arrive with the same name.
    nameFor() {
        const base = this.homey.__(this.manifest.name);
        const paired = typeof this.getDevices === 'function' ? this.getDevices() : [];
        return paired.length === 0 ? base : `${base} ${paired.length + 1}`;
    }

    // Listens for a frame from a physical CR2032 remote and returns what Homey
    // needs to transmit as it: the address, and the tail it sent.
    //
    // A frame is taken only when whole. identifyFrame never reconstructs a
    // symbol, so there is no weaker frame to prefer against: a 23-symbol frame
    // is not delivered to listeners at all, and the full-length frames of the
    // same press follow it.
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
                    if (timer !== null) clearTimeout(timer);
                    timer = null;
                    stop().then(() => fn(arg));
                };

                listener = frame => {
                    heard += 1;
                    log(`heard #${heard}: ${frame.key}`);

                    // The progress counter is the view's, which may have
                    // navigated away. Guarded rather than awaited: failing to
                    // update a number on screen must not cost the user the press.
                    try {
                        session.emit('rx', { heard, command: frame.key })?.catch?.(() => {});
                    } catch (err) {
                        log('could not update the view:', err.message);
                    }

                    // Any button will do. The command table is the structural
                    // check that keeps pairing off unrelated 433 MHz traffic.
                    log(`matched ${frame.key}; address ${frame.address.join('')}, tail ${frame.tail.join('')}`);
                    settle(resolve, { address: frame.address, tail: frame.tail });
                };

                timer = setTimeout(() => {
                    log(`timed out after ${this.learnTimeout}ms; ${heard} frame(s) heard`);
                    settle(reject, new Error(this.homey.__('pair.timeout')));
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

module.exports = Cr2032Driver;
