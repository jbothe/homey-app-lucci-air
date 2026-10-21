'use strict';

const Cr2032Driver = require('../../lib/cr2032-driver');

// A separate driver, and so a separate pair step, because Homey pairs per
// driver - the same reasoning as the USB-C remote's light. Every frame carries
// the same address whichever button sent it, so pressing any button pairs
// either device.
class Cr2032LightDriver extends Cr2032Driver {
    get deviceIdPrefix() { return 'lucci-cr2032-light'; }

    // Whether the light was on when it was paired.
    //
    // **The one fact about this device that cannot be worked out and cannot be
    // measured.** The light is a stateless toggle and reports nothing, so
    // Homey's `onoff` for it is a belief; asking once at the only moment
    // someone is standing in front of it turns the first value from a guess
    // into something that was true. Same as the USB-C remote's light.
    async onPair(session) {
        this.pairLit = null;

        session.setHandler('state', async ({ lit }) => {
            this.pairLit = lit === true;
            this.log(`[pair] told the light is ${this.pairLit ? 'on' : 'off'}`);
            return true;
        });

        await super.onPair(session);
    }

    devicesFor(learned) {
        return super.devicesFor(learned).map(device => ({
            ...device,
            store: { ...device.store, lit: this.pairLit },
        }));
    }
}

module.exports = Cr2032LightDriver;
