'use strict';

const Homey = require('homey');

class LucciApp extends Homey.App {
    async onInit() {
        this.log('Lucci is running...');
    }
}

module.exports = LucciApp;
