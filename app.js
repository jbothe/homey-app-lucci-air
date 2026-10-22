'use strict';

const Homey = require('homey');
const lucci = require('./lib/lucci-protocol');
const { registerFlowCards } = require('./lib/flow');

// Ambient 433 MHz traffic occasionally fits our timings. The unrecognised-frame
// log exists to diagnose a silent receiver, not to narrate the airwaves, so it
// is throttled to one line per minute with a count of what it skipped.
const UNRECOGNISED_LOG_INTERVAL = 60000;

// The app owns the receivers, because there is one of each.
//
// **Homey's enableRX and disableRX act on the signal, not on the caller**, so
// the count of who wants it has to be kept in one place. It used to be kept per
// driver, which was fine while the fan was the only driver and wrong the moment
// the light arrived: pairing a light finished by calling disableRX, and the fan
// — still registered, with its own driver's count untouched — went deaf. The log
// caught it on the first run with both drivers:
//
//     [Driver:light] RX disabled
//     [Driver:light] RX enabled          (4 seconds later, on device init)
//
// Four seconds is nothing. The same shape with the light paired last and the fan
// following the handset is a fan that silently stops keeping up, which is the
// kind of fault that gets noticed as "Homey shows the wrong speed sometimes".
//
// **One receiver per signal, because Homey's enableRX acts on the signal.** The
// USB-C remote and the CR2032 remote are different signals (different preamble,
// timing and length), so each has its own listener set and its own reference
// count; sharing one count would have the first remote's last device switch off
// the second's receiver, which is the fan-and-light bug above in a new place.
//
// The CR2032 receiver is created the first time a device asks for it, and the
// USB-C one at start-up as it always was: an install with only the original
// fans never touches the second signal.
class LucciAirApp extends Homey.App {
    async onInit() {
        this.receivers = new Map();

        // The original receiver, under the names it has always had.
        const original = this.receiverFor(lucci);
        this.signal = original.signal;
        this.rxListeners = original.listeners;

        registerFlowCards(this.homey);

        this.log('Lucci Air is running...');
    }

    // The receiver for a protocol, made on first use.
    receiverFor(protocol) {
        let receiver = this.receivers.get(protocol.SIGNAL_ID);
        if (receiver !== undefined) return receiver;

        receiver = {
            protocol,
            // Everyone listening to this signal, across every driver and device.
            listeners: new Set(),
            signal: this.homey.rf.getSignal433(protocol.SIGNAL_ID),
            // Ambient 433 MHz traffic occasionally fits our timings. The
            // unrecognised-frame log exists to diagnose a silent receiver, not
            // to narrate the airwaves, so it is throttled per signal.
            unrecognisedSinceLog: 0,
            lastUnrecognisedLog: 0,
        };
        receiver.signal.on('payload', (payload, isFirst, deviation) => {
            this.onPayload(receiver, payload, isFirst, deviation);
        });
        this.receivers.set(protocol.SIGNAL_ID, receiver);
        return receiver;
    }

    onPayload(receiver, payload, isFirst, deviation) {
        const { protocol } = receiver;
        const frame = protocol.identifyFrame(payload);
        if (frame === null) {
            // Log rather than drop silently. Homey gives the identical symptom —
            // enableRX() resolving while no payload ever reaches a listener —
            // whether frames are not arriving at all or arriving and failing to
            // decode, and this line is what tells those two apart. It found the
            // leading-bit truncation on the first run that ever received
            // anything.
            receiver.unrecognisedSinceLog += 1;
            const now = Date.now();
            if (now - receiver.lastUnrecognisedLog < UNRECOGNISED_LOG_INTERVAL) return;

            const skipped = receiver.unrecognisedSinceLog - 1;
            this.log(`rx unrecognised${protocol === lucci ? '' : ` (${protocol.SIGNAL_ID})`}:`
                + ` ${protocol.describeFrame(payload)}`
                + ` [${Array.isArray(payload) ? payload.join('') : payload}]`
                + `${deviation === undefined ? '' : ` dev ${deviation}`}`
                + (skipped > 0 ? ` (+${skipped} more in the last minute)` : ''));
            receiver.lastUnrecognisedLog = now;
            receiver.unrecognisedSinceLog = 0;
            return;
        }

        for (const listener of receiver.listeners) {
            try {
                listener(frame, isFirst, payload);
            } catch (err) {
                this.error('RX listener failed:', err.message);
            }
        }
    }

    // `protocol` defaults to the USB-C remote's, so every caller that predates
    // the second remote is unchanged.
    async registerRXListener(listener, protocol = lucci) {
        const receiver = this.receiverFor(protocol);
        if (receiver.listeners.has(listener)) return;
        receiver.listeners.add(listener);

        if (receiver.listeners.size === 1) {
            await receiver.signal.enableRX();
            this.log(`RX enabled on signal '${protocol.SIGNAL_ID}'`);
        }
    }

    async unregisterRXListener(listener, protocol = lucci) {
        const receiver = this.receiverFor(protocol);
        if (!receiver.listeners.delete(listener)) return;

        if (receiver.listeners.size === 0) {
            await receiver.signal.disableRX();
            this.log(`RX disabled on signal '${protocol.SIGNAL_ID}'`);
        }
    }
}

module.exports = LucciAirApp;
