'use strict';

const LucciAirDriver = require('../../lib/lucci-driver');

// A fan with its light, paired once. Receiving, learning an address off the
// handset and offering a device are all in LucciAirDriver; unlike the light
// driver there is no state question at pair time, because this device keeps no
// belief about the light to start off right.
class LucciAirFanLightDriver extends LucciAirDriver {
    get deviceIdPrefix() { return 'lucci-fan-light'; }
}

module.exports = LucciAirFanLightDriver;
