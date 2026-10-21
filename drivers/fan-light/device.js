'use strict';

const LucciAirFanDevice = require('../fan/device');

// The handset, as it is: a fan, and beside it the light's three buttons.
//
// **The light is deliberately not a state here.** Its on/off is one stateless
// toggle and its brightness is relative, so Homey can never know whether it is
// lit or how bright — the standalone light device keeps a belief and a slider
// anyway, and carries a button to correct them when they drift. This device
// claims none of that. It has the three buttons the handset has, each of which
// sends exactly what the handset sends and says nothing about the result, so
// there is nothing here that can be wrong.
//
// Everything about the fan is the fan device's, unchanged.
class LucciAirFanLightDevice extends LucciAirFanDevice {
    registerLightControls() {
        this.registerCapabilityListener('lucci_toggle', () => this.pressButton('light.onoff', 'lucci_toggle'));
        this.registerCapabilityListener('lucci_brighter', () => this.pressButton('light.brighter', 'lucci_brighter'));
        this.registerCapabilityListener('lucci_dimmer', () => this.pressButton('light.dimmer', 'lucci_dimmer'));
    }

    // One press, one code. Through the fan's own queue, so a button pressed
    // straight after a speed change is not laid on top of it.
    async pressButton(key, why) {
        try {
            await this.send(key, why);
        } catch (err) {
            throw new Error(this.homey.__('errors.tx_failed'));
        }
    }

    // Nothing to follow: the light has no state on this device, so a press at
    // the handset changes nothing Homey shows.
    heardLightButton() {}
}

module.exports = LucciAirFanLightDevice;
