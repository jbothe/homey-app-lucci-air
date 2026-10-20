'use strict';

const LucciAirDriver = require('../../lib/lucci-driver');

// Receiving, learning an address off the handset and offering a device are all
// in LucciAirDriver, identically to the fan: every frame carries the same 16-bit
// address whichever selector it has, so either handset button pairs either
// device. What is left here is what a light is.
//
// A separate driver, and so a separate pair step, because Homey pairs per
// driver. APP_PLAN.md describes one learn step offering both; that is not
// something Homey can do, and pressing a button twice is a small price for two
// devices that each get their own tile, flow cards and voice control.
class LucciAirLightDriver extends LucciAirDriver {
    get deviceIdPrefix() { return 'lucci-light'; }

    // Whether the light was on when it was paired.
    //
    // **The one fact about this device that cannot be worked out and cannot be
    // measured.** The light reports nothing, so Homey's `onoff` for it is a
    // belief — and before this step the belief started as a guess, which every
    // subsequent toggle then preserved faithfully. Asking once turns the first
    // value into something that was actually true.
    //
    // Kept on the driver rather than threaded through the base's pairing
    // closure, because Homey pairs one device at a time and this is read in the
    // same session that set it.
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

    // Re-establishing the brightness, as a repair rather than a setting: it
    // drives the light to an end stop and takes the position from there, which
    // works because both ends saturate instead of wrapping. See APP_PLAN.md.
    async onRepair(session, device) {
        session.setHandler('calibrate', async ({ end }) => device.calibrate(end));
        session.setHandler('cancel', async () => device.cancelMove('calibration cancelled'));
    }
}

module.exports = LucciAirLightDriver;
