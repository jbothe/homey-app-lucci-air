'use strict';

const Cr2032FanDevice = require('../fan-cr2032/device');

// The remote, as it is: a fan, and beside it the light's one button.
//
// **The light is deliberately not a state here**, for the reason it is not on
// the USB-C remote's combined device: it is a stateless toggle, so the only
// honest control is the button, which sends what the remote sends and claims
// nothing about the result. The standalone light device keeps a belief and a
// button to correct it; this one has nothing to correct.
//
// **Written, and the toggle has not been transmitted** - the fan this was built
// against has no light fitted. See RF_PROTOCOL_CR2032.md.
class Cr2032FanLightDevice extends Cr2032FanDevice {
    registerLightControls() {
        this.registerCapabilityListener('lucci_toggle', async () => {
            try {
                await this.send('light.toggle', 'lucci_toggle');
            } catch (err) {
                throw new Error(this.homey.__('errors.tx_failed'));
            }
        });
    }

    // Nothing to follow: the light has no state on this device.
    heardLightButton() {}
}

module.exports = Cr2032FanLightDevice;
