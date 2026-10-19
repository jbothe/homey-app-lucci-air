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

// How long Homey pools changes to the two capabilities before calling the
// listener once, in milliseconds. Homey's own default for a coupled listener.
const DEBOUNCE = 250;

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
        // step and the log otherwise cannot tell "the step you last chose" from
        // "the default, because nothing was stored" — a difference a user would
        // notice and the radio cannot show.
        //
        // Nothing is transmitted here, and the wording says so. "Resumed step 1"
        // was the first attempt and it misread as the fan having been set to
        // step 1; all this does is read back a stored number. What the fan is
        // actually doing at this moment is unknown — the radio is one way, and
        // the handset may have been used while the app was down.
        const stored = this.getCapabilityValue('lucci_speed');
        if (FAN_SPEEDS.includes(stored)) {
            this.log(`speed: step ${stored} stored; nothing sent, this is what onoff true would send`);
        } else {
            this.log(`speed: none stored (${JSON.stringify(stored)}); onoff true would send step ${DEFAULT_SPEED}`);
            await this.set('lucci_speed', DEFAULT_SPEED);
        }

        // One listener for both, which is Homey's documented pattern for
        // capabilities that map to a single command — as `onoff` and `dim` do on
        // a light, and as these do here: every frame this driver sends is one
        // absolute speed code or the off code, never a power code and a speed.
        //
        // The 250ms debounce is worth having on a radio. A drag across the picker
        // emits a value per step, and the first run showed three arriving inside
        // 2.1 seconds — each ~423ms of airtime, so they were queuing up behind
        // each other. Debounced, a drag is one transmission of the step it
        // landed on, and because speed is absolute that is the only one that
        // carried any information.
        this.registerMultipleCapabilityListener(
            ['onoff', 'lucci_speed'], this.onCapabilities.bind(this), DEBOUNCE,
        );
    }

    // setCapabilityValue with the failure actually reported.
    //
    // `.catch(this.error)` was the original, and it is worse than no handler:
    // `error` is a prototype method, so passing it unbound means a rejection
    // throws a second time inside the handler, and the first error never reaches
    // the log. That is how `onoff` came to be silently wrong — the write might
    // have been failing all along and saying nothing.
    async set(capability, value) {
        try {
            await this.setCapabilityValue(capability, value);
            return true;
        } catch (err) {
            this.error(`could not set ${capability} to ${JSON.stringify(value)}:`, err.message);
            return false;
        }
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

    // Both capabilities, one command.
    //
    // `onoff` is asymmetric, because the protocol is: there is one off code and
    // six absolute speed codes, and no "on". So off sends the off code, and on
    // sends the stored speed's code — which is how the handset behaves, where a
    // fan is started by pressing a speed button. A speed code therefore starts
    // the fan as well as setting the step, confirmed on the hardware, and there
    // is no guard against setting a speed while off, unlike the sibling RC300:
    // here that is the ordinary way to start it.
    //
    // Only the capabilities that changed arrive, so the rest come from what is
    // stored.
    async onCapabilities(values) {
        // `onoff` leads when both change, which is Homey's guidance for coupled
        // capabilities: a flow asking for off and a speed in one go means off,
        // and the speed is kept for whenever the fan is next turned on.
        if (values.onoff === false) {
            await this.send('fan.off', 'onoff false');
            return;
        }

        const asked = values.lucci_speed;
        const stored = this.getCapabilityValue('lucci_speed');
        const step = [asked, stored, DEFAULT_SPEED].find(v => FAN_SPEEDS.includes(v));
        const why = asked === undefined ? `onoff true, stored step ${step}` : 'lucci_speed';

        await this.send(`fan.speed.${step}`, why);

        // The fan is now running, whichever capability asked for it. Homey sets
        // the ones that were requested once this resolves, so the work here is
        // the ones that were not — `onoff` after a speed change, and the speed
        // itself when the fallback above had to supply it.
        await this.reflect({ onoff: true, lucci_speed: step }, values);
    }

    // Writes the capability values the request did not carry, and says whether
    // they took.
    //
    // Deferred past this listener deliberately. Setting a capability from inside
    // a listener for a different one did not stick: the speed picker transmitted
    // and moved the fan while the tile stayed off, until an `onoff` toggle —
    // which did nothing, the fan already running — put it right. Homey writes the
    // requested capabilities when the listener resolves, so this waits its turn
    // and then reads back what it wrote, which is what makes the next run's log
    // able to settle it rather than leaving it to be noticed again.
    async reflect(wanted, requested) {
        const pending = Object.entries(wanted).filter(([capability, value]) => requested[capability] === undefined
            && this.getCapabilityValue(capability) !== value);
        if (pending.length === 0) return;

        this.homey.setTimeout(async () => {
            for (const [capability, value] of pending) {
                if (!await this.set(capability, value)) continue;

                const now = this.getCapabilityValue(capability);
                if (now === value) this.log(`${capability} -> ${JSON.stringify(value)}`);
                else this.error(`${capability} would not hold ${JSON.stringify(value)}; reads ${JSON.stringify(now)}`);
            }
        }, 0);
    }
}

module.exports = LucciFanDevice;
