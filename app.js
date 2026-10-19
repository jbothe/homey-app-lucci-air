'use strict';

const Homey = require('homey');
const { SIGNAL_ID, identifyFrame, describeFrame } = require('./lib/lucci-protocol');

// Ambient 433 MHz traffic occasionally fits our timings. The unrecognised-frame
// log exists to diagnose a silent receiver, not to narrate the airwaves, so it
// is throttled to one line per minute with a count of what it skipped.
const UNRECOGNISED_LOG_INTERVAL = 60000;

// The app owns the receiver, because there is one of it.
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
class LucciApp extends Homey.App {
    async onInit() {
        this.unrecognisedSinceLog = 0;
        this.lastUnrecognisedLog = 0;

        // Everyone listening, across both drivers and every device.
        this.rxListeners = new Set();
        this.signal = this.homey.rf.getSignal433(SIGNAL_ID);
        this.signal.on('payload', this.onPayload.bind(this));

        this.log('Lucci is running...');
    }

    onPayload(payload, isFirst, deviation) {
        const frame = identifyFrame(payload);
        if (frame === null) {
            // Log rather than drop silently. Homey gives the identical symptom —
            // enableRX() resolving while no payload ever reaches a listener —
            // whether frames are not arriving at all or arriving and failing to
            // decode, and this line is what tells those two apart. It found the
            // leading-bit truncation on the first run that ever received
            // anything.
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

        for (const listener of this.rxListeners) {
            try {
                listener(frame, isFirst, payload);
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
}

module.exports = LucciApp;
