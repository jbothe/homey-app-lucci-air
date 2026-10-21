'use strict';

const Cr2032Driver = require('../../lib/cr2032-driver');

// A fan with its light, paired once. No state question at pair time: this
// device keeps no belief about the light to start off right.
class Cr2032FanLightDriver extends Cr2032Driver {
    get deviceIdPrefix() { return 'lucci-cr2032-fan-light'; }
}

module.exports = Cr2032FanLightDriver;
