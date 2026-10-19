'use strict';

const Homey = require('homey');
const { SIGNAL_ID, ADDRESS_LENGTH, FAN_SPEEDS, buildFrame } = require('../../lib/lucci-protocol');

// The speed a fan starts on when it has never been given one.
//
// The protocol has no "fan on" command and no notion of a last speed — the
// handset's power button is off-only, and a fan is started by sending a speed
// code. So turning this device on has to name a step, and on a device nobody has
// set a speed on yet there is nothing to name. Medium-low is the choice: high
// enough that the fan has visibly done something, low enough not to startle.
//
// It applies once. After that the capability holds whatever was last commanded
// or overheard, which is what `onoff` true sends.
const DEFAULT_SPEED = '2';

class LucciFanDevice extends Homey.Device {
    async onInit() {
        this.signal = this.homey.rf.getSignal433(SIGNAL_ID);

        // The address is learned from the user's own handset during pairing.
        // There is no default: transmitting an address we guessed would drive
        // whichever fan happens to answer to it, so a device without one stays
        // unavailable until it is added again.
        this.address = this.getStoreValue('address');
        if (!Array.isArray(this.address) || this.address.length !== ADDRESS_LENGTH) {
            this.error('no address stored; the device must be added again');
            await this.setUnavailable(this.homey.__('errors.not_paired'));
            return;
        }
        this.log(`initialised; address ${this.address.join('')}`);

        // So the tile always offers a speed, and `onoff` always has one to send.
        // Which of the two happened is logged, because `onoff` true sends this
        // step and the log otherwise cannot tell "resumed what you last chose"
        // from "fell back to the default" — the difference a user would notice.
        const stored = this.getCapabilityValue('lucci_speed');
        if (FAN_SPEEDS.includes(stored)) {
            this.log(`speed: resumed step ${stored}`);
        } else {
            this.log(`speed: none stored (${JSON.stringify(stored)}), starting at step ${DEFAULT_SPEED}`);
            await this.setCapabilityValue('lucci_speed', DEFAULT_SPEED).catch(this.error);
        }

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('lucci_speed', this.onCapabilitySpeed.bind(this));
    }

    // Prefixes a command with this fan's address and transmits it.
    //
    // The frame goes out nine times, which is what the handset sends and
    // deliberately not more: on the sibling RC300 app, transmitting materially
    // longer than the real remote made the receiver re-trigger and register one
    // Homey command as two presses. The count lives in the signal definition.
    // `why` names the capability that asked for it. Without it the log cannot
    // tell `onoff` true from the speed picker — both come out as
    // `tx fan.speed.2`, and they are different paths through this file.
    async send(key, why) {
        const payload = buildFrame(this.address, key);
        const startedAt = Date.now();

        try {
            // tx() resolves once Homey has queued the transmission, not once the
            // repetitions have finished going out, so this time is call latency
            // rather than the ~423ms a press actually occupies.
            await this.signal.tx(payload);
            this.log(`tx ${key} ok (${why}, queued in ${Date.now() - startedAt}ms)`);
        } catch (err) {
            this.error(`tx ${key} failed after ${Date.now() - startedAt}ms (${why}):`, err.message);
            this.error(`  payload was [${payload.join('')}]`);
            throw err;
        }
    }

    // `onoff` is asymmetric, because the protocol is: there is one off code and
    // six absolute speed codes, and no "on". So off sends the off code, and on
    // sends the stored speed's code — which is exactly how the handset behaves,
    // where a fan is started by pressing a speed button.
    async onCapabilityOnOff(value) {
        if (!value) {
            await this.send('fan.off', 'onoff false');
            return;
        }

        const speed = this.getCapabilityValue('lucci_speed');
        const step = FAN_SPEEDS.includes(speed) ? speed : DEFAULT_SPEED;
        await this.send(`fan.speed.${step}`, `onoff true, stored step ${step}`);

        // Only once the frame is away, and only if the fallback was used, so the
        // tile shows the step the fan is actually on.
        if (step !== speed) await this.setCapabilityValue('lucci_speed', step).catch(this.error);
    }

    // A speed code starts the fan as well as setting the step — one absolute
    // command, no power code needed first — so this implies `onoff` true. There
    // is no guard against setting a speed while off, unlike the sibling RC300:
    // on this protocol that is the ordinary way to start the fan.
    async onCapabilitySpeed(value) {
        await this.send(`fan.speed.${value}`, 'lucci_speed');

        // setCapabilityValue, not triggerCapabilityListener: the fan is now
        // running, and saying so must not transmit a second command.
        await this.setCapabilityValue('onoff', true).catch(this.error);
    }
}

module.exports = LucciFanDevice;
