'use strict';

const LucciAirDriver = require('../../lib/lucci-driver');

// Everything about receiving, about learning an address off the handset, and
// about offering a device once one is learned is in LucciAirDriver — the light
// driver needs all of it identically. What is left here is what a fan is.
class LucciAirFanDriver extends LucciAirDriver {
    get deviceIdPrefix() { return 'lucci-fan'; }
}

module.exports = LucciAirFanDriver;
