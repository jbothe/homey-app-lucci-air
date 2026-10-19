'use strict';

const LucciDriver = require('../../lib/lucci-driver');

// Receiving, learning an address off the handset and offering a device are all
// in LucciDriver, identically to the fan: every frame carries the same 16-bit
// address whichever selector it has, so either handset button pairs either
// device. What is left here is what a light is.
//
// A separate driver, and so a separate pair step, because Homey pairs per
// driver. APP_PLAN.md describes one learn step offering both; that is not
// something Homey can do, and pressing a button twice is a small price for two
// devices that each get their own tile, flow cards and voice control.
class LucciLightDriver extends LucciDriver {
    get deviceIdPrefix() { return 'lucci-light'; }

    // Re-establishing the brightness, as a repair rather than a setting: it
    // drives the light to an end stop and takes the position from there, which
    // works because both ends saturate instead of wrapping. See APP_PLAN.md.
    async onRepair(session, device) {
        session.setHandler('calibrate', async ({ end }) => device.calibrate(end));
        session.setHandler('cancel', async () => device.cancelMove('calibration cancelled'));
    }
}

module.exports = LucciLightDriver;
