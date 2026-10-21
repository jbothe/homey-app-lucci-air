'use strict';

const Cr2032Driver = require('../../lib/cr2032-driver');

// Receiving, learning an address off the remote and offering a device are all
// in Cr2032Driver. What is left here is what a fan is.
class Cr2032FanDriver extends Cr2032Driver {
    get deviceIdPrefix() { return 'lucci-cr2032-fan'; }
}

module.exports = Cr2032FanDriver;
