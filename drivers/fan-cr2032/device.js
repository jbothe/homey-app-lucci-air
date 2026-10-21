'use strict';

const Homey = require('homey');
const {
    SIGNAL_ID, ADDRESS_LENGTH, TAIL_LENGTH, PRESS_AIRTIME, FAN_SPEEDS, buildFrame, sameAddress,
} = require('../../lib/cr2032-protocol');
const { reflect } = require('../../lib/reflect');
const { pressQueue, RELEASE_GAP } = require('../../lib/press-queue');

// The fan this drives is a Lucci Whitehaven with a Rhine RH787NRN receiver. It
// has a power-off and six speed buttons, which are absolute, and ONE direction
// button, which is a toggle. See RF_PROTOCOL_CR2032.md for what is and is not
// verified on the fan.
//
// **The direction is a button, and deliberately not a state.** The remote's
// Reverse sends the same code every press, so it can say "flip" and nothing
// else, and the fan reports nothing back. A picker would claim a direction
// nobody knows: it would start as a guess and drift whenever the remote, the
// wall switch or a power cut changed the fan. A "change direction" button
// claims only what is true - one flip was sent - and suits a fan that is slow
// to turn the other way (it has to stop first), where the person presses, watches,
// and presses again if wrong. The cost is no direction on the tile and none to
// build a flow on.

// The speed a fan starts on when it has never been given one. The remote has no
// "on" button, so a fan is started by sending a speed, and turning this device on
// has to name a step. Medium-low, as on the USB-C remote's fan.
const DEFAULT_SPEED = '2';

// How long Homey pools changes to the two coupled capabilities before calling
// the listener once, in milliseconds.
const DEBOUNCE = 250;

// How long the same received command is treated as one press. One press can
// reach us as two or three receptions, and a suppressed duplicate of "set speed
// 3" or "off" loses nothing - which is only safe because both are absolute. It
// applies to Reverse too, but that changes no state here, so only a log line is
// collapsed.
const RX_REPEAT_WINDOW = 2000;

class Cr2032FanDevice extends Homey.Device {
    async onInit() {
        this.signal = this.homey.rf.getSignal433(SIGNAL_ID);

        // tx() resolves when Homey has queued a transmission, not when it has
        // finished. A press here is ~323ms of air, not the USB-C remote's 423.
        this.press = pressQueue({
            wait: ms => this.wait(ms),
            now: () => Date.now(),
            interval: PRESS_AIRTIME + RELEASE_GAP,
        });

        // Learned from the user's own remote at pair time. There is no default:
        // transmitting an address we guessed would drive whichever fan answers
        // to it.
        this.address = this.getStoreValue('address');
        if (!Array.isArray(this.address) || this.address.length !== ADDRESS_LENGTH) {
            this.error('no address stored; the device must be added again');
            await this.setUnavailable(this.homey.__('errors.not_paired'));
            return;
        }
        // The two bits after the command, as this remote was heard to send them.
        // Learned, not assumed, for the reason the USB-C remote's bit 24 is: one
        // remote cannot say whether they identify it. Without them there is
        // nothing to transmit.
        this.tail = this.getStoreValue('tail');
        this.tailMismatches = 0;
        if (!Array.isArray(this.tail) || this.tail.length !== TAIL_LENGTH) {
            this.error('no tail stored; the device must be added again');
            await this.setUnavailable(this.homey.__('errors.not_paired'));
            return;
        }

        this.log(`initialised; address ${this.address.join('')}, tail ${this.tail.join('')}`);

        // What the fan is believed to be doing, held here rather than read back
        // from the capabilities, because inside a listener the capability is
        // stale - Homey writes a requested value when the listener resolves.
        this.on = this.getCapabilityValue('onoff') === true;

        const stored = this.getCapabilityValue('lucci_speed');
        this.step = FAN_SPEEDS.includes(stored) ? stored : DEFAULT_SPEED;
        if (FAN_SPEEDS.includes(stored)) {
            this.log(`speed: step ${stored} stored; nothing sent, this is what onoff true would send`);
        } else {
            this.log(`speed: none stored (${JSON.stringify(stored)}); onoff true would send step ${DEFAULT_SPEED}`);
            await this.set('lucci_speed', DEFAULT_SPEED);
        }

        // One listener for both, as on the USB-C remote's fan: every frame this
        // driver sends for them is one absolute speed code or the off code.
        this.registerMultipleCapabilityListener(
            ['onoff', 'lucci_speed'], this.onCapabilities.bind(this), DEBOUNCE,
        );

        // One press, one flip, and no claim about the result: correct however the
        // fan got to the direction it is in.
        this.registerCapabilityListener('lucci_reverse', async () => {
            await this.reverse('lucci_reverse');
        });

        // Follow the remote, so Homey does not show stale state. Failing here
        // must not stop the device from transmitting.
        this.onRX = this.onRX.bind(this);
        try {
            await this.driver.registerRXListener(this.onRX);
        } catch (err) {
            this.error('could not listen for the remote; state may go stale:', err.message);
        }
    }

    async onUninit() {
        await this.driver.unregisterRXListener(this.onRX)
            .catch(err => this.error('could not stop listening:', err.message));
    }

    // setCapabilityValue with the failure actually reported. `.catch(this.error)`
    // would throw inside its own handler and lose the original.
    async set(capability, value) {
        try {
            await this.setCapabilityValue(capability, value);
            return true;
        } catch (err) {
            this.error(`could not set ${capability} to ${JSON.stringify(value)}:`, err.message);
            return false;
        }
    }

    // Prefixes a command with this fan's address and transmits it, nine times,
    // which is the one repetition count verified on this receiver: OFF stopped the
    // fan at 9 and did not at 1, 2 or 5. The count lives in the signal definition.
    async send(key, why) {
        const payload = buildFrame(this.address, key, this.tail);

        return this.press(async () => {
            const startedAt = Date.now();
            try {
                await this.signal.tx(payload);
                this.log(`tx ${key} ok (${why}, queued in ${Date.now() - startedAt}ms)`);
            } catch (err) {
                this.error(`tx ${key} failed after ${Date.now() - startedAt}ms (${why}):`, err.message);
                this.error(`  payload was [${payload.join('')}]`);
                throw err;
            }
        });
    }

    wait(ms) {
        return new Promise(resolve => { this.homey.setTimeout(resolve, ms); });
    }

    // One reverse press. Nothing is remembered about it.
    async reverse(why) {
        try {
            await this.send('fan.reverse', why);
        } catch (err) {
            throw new Error(this.homey.__('errors.tx_failed'));
        }

        // Asked at the only moment it can be answered. Whether a reverse press
        // does anything to a stopped fan has not been tested.
        if (!this.on) {
            this.log('reverse sent while the fan was believed off - did anything happen?'
                + ' Open question in RF_PROTOCOL_CR2032.md.');
        }
    }

    // Both capabilities, one command. Asymmetric, because the protocol is: one
    // off code and six absolute speed codes, and no "on". Off sends the off code;
    // on sends the stored speed's code, which is how the remote starts a fan.
    //
    // The manual says this fan must be started on speed VI after power-on, and
    // that it takes 5 to 10 seconds to respond to speed or direction changes.
    // The first was not observed: with the fan on VI, a power cut at the wall
    // resumed it there and another speed was honoured at once (RF_PROTOCOL_CR2032.md
    // says exactly what was and was not tried). The second is true of the
    // direction only: a speed change shows within a few seconds, so nothing here
    // waits for it.
    async onCapabilities(values) {
        // `onoff` leads when both change, as on the USB-C remote's fan.
        if (values.onoff === false) {
            this.on = false;
            await this.send('fan.off', 'onoff false');
            return;
        }

        const asked = values.lucci_speed;
        const step = [asked, this.step, DEFAULT_SPEED].find(v => FAN_SPEEDS.includes(v));
        const why = asked === undefined ? `onoff true, stored step ${step}` : 'lucci_speed';

        // Committed before anything is awaited.
        this.on = true;
        this.step = step;

        await this.send(`fan.speed.${step}`, why);

        reflect(this, { onoff: true, lucci_speed: step }, values);
    }

    // Whether a received frame agrees with this device about the tail. Said
    // once: this is the line that would show the tail is not constant for one
    // remote, which one remote cannot say.
    noteTail(frame) {
        if (sameAddress(frame.tail, this.tail)) return;

        this.tailMismatches += 1;
        if (this.tailMismatches > 1) return;
        this.log(`${frame.key} arrived with tail ${frame.tail.join('')} where this device stores`
            + ` ${this.tail.join('')} - so the tail is not constant for one remote, which is the`
            + ' thing RF_PROTOCOL_CR2032.md says one remote cannot show.');
    }

    onRX(frame, isFirst) {
        // Each press is transmitted several times; only act on it once.
        if (isFirst === false) return;
        if (!frame.addressSure) return;

        // Another household's remote, or another fan in this one.
        if (!sameAddress(frame.address, this.address)) return;

        this.noteTail(frame);

        if (frame.domain !== 'fan') {
            // The light's code carries the same address, so this device hears it
            // whether it wants to or not.
            if (this.heardLight !== true) {
                this.heardLight = true;
                this.log(`heard ${frame.key} from the remote; the light is a separate device`);
            }
            return;
        }

        const now = Date.now();
        if (frame.key === this.lastRxKey && now - this.lastRxAt < RX_REPEAT_WINDOW) return;
        this.lastRxKey = frame.key;
        this.lastRxAt = now;

        this.mirror(frame).catch(err => this.error(`mirroring ${frame.key} failed:`, err.message));
    }

    // Brings the capabilities into line with a press that already happened.
    //
    // Through `set`, never `triggerCapabilityListener`: this reflects a change
    // the fan has already made and must not transmit it back.
    async mirror(frame) {
        switch (frame.command) {
            case 'off':
                this.on = false;
                await this.set('onoff', false);
                break;
            case 'speed':
                // A speed code starts the fan, so hearing one means both.
                this.on = true;
                this.step = frame.value;
                await this.set('lucci_speed', frame.value);
                await this.set('onoff', true);
                break;
            case 'reverse':
                // Heard and not tracked: there is no direction to update, and
                // saying so is what tells a person the app noticed.
                this.log('rx fan.reverse from the remote; the direction is not tracked, so nothing changes');
                return;
            default:
                // A fan command with no capability behind it yet.
                this.log(`heard ${frame.key}, which no capability tracks`);
                return;
        }

        this.log(`rx ${frame.key} from the remote`);
    }
}

module.exports = Cr2032FanDevice;
