'use strict';

const Homey = require('homey');
const {
    SIGNAL_ID, ADDRESS_LENGTH, FAN_SPEEDS, buildFrame, sameAddress,
} = require('../../lib/lucci-protocol');

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

// How long the same received command is treated as one press, in milliseconds.
//
// One press can reach us as two or three separate receptions: `isFirst` only
// groups the frames Homey heard as a single burst, and reception dropping
// briefly mid-transmission starts a new one. Nine frames occupy ~423ms, so a
// window several times that collapses a press however it was split.
//
// **Collapsing is only safe because every fan command is absolute or
// idempotent** — "set speed 3", "reverse", "8 hours", "off" — so a suppressed
// duplicate can never lose information. The light's brighter and dimmer are
// relative, one press one step, and collapsing those would silently drop steps:
// the light driver must not reuse this.
const RX_REPEAT_WINDOW = 2000;

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

        // Direction and the timer get a listener each, and deliberately not the
        // coupled one. They are absolute like the speed, but unlike it they are
        // nothing else's business: one capability, one code, and no second
        // capability whose value has to be decided at the same moment. Pooling
        // them with `onoff` would only invite the question of what a request for
        // "off and reverse" means, which the protocol does not answer — the
        // handset has no such combination.
        //
        // **A direction code starts a stopped fan**, confirmed on the hardware,
        // so it implies `onoff` true exactly as a speed code does — through
        // `reflect`, because this is the pitfall that cost a round trip once
        // already: writing a capability from inside another's listener.
        //
        // What speed it starts at is a different matter and not knowable. The
        // fan picks one, nothing reports it, and no speed code was sent — so
        // `lucci_speed` after a direction-started start is Homey's last guess
        // rather than a fact. The next speed command or overheard press fixes
        // it, which is the best available and worth knowing about.
        this.registerCapabilityListener('lucci_direction', async value => {
            await this.send(`fan.direction.${value}`, 'lucci_direction');
            await this.reflect({ onoff: true }, { lucci_direction: value });
        });

        // The timer implies nothing, because whether it starts a stopped fan has
        // not been tested — and a direction code's doing so is no evidence about
        // it. Guessing wrong here shows the fan on while it is off, which is the
        // mirror of the bug that had the tile stuck off while it ran.
        this.registerCapabilityListener('lucci_timer', async value => {
            await this.send(`fan.timer.${value}`, 'lucci_timer');

            // Asked at the only moment it can be answered: a timer code has
            // just gone out to a fan that was stopped, which is the experiment.
            // Cheaper than remembering to run it on purpose, and it will fire
            // the first time anyone happens to do this.
            if (this.getCapabilityValue('onoff') !== true) {
                this.log('timer sent while the fan was off — did the fan start?'
                    + ' If it did, lucci_timer should imply onoff true the way lucci_direction does.'
                    + ' Open question in RF_PROTOCOL.md under Caveats.');
            }
        });

        // Follow the handset, so Homey does not show stale state. Because speed,
        // direction and the timer are absolute, a received frame gives the exact
        // state rather than a hint — which is the whole reason this is worth the
        // effort. Failing here must not stop the device from transmitting.
        this.onRX = this.onRX.bind(this);
        try {
            await this.driver.registerRXListener(this.onRX);
        } catch (err) {
            this.error('could not listen for the handset; state may go stale:', err.message);
        }
    }

    async onUninit() {
        await this.driver.unregisterRXListener(this.onRX)
            .catch(err => this.error('could not stop listening:', err.message));
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

    // Every Lucci frame Homey receives, from any handset in range.
    onRX(frame, isFirst) {
        // Each press is transmitted nine times; only act on it once.
        if (isFirst === false) return;

        // Another household's handset, or another fan in this one.
        if (!sameAddress(frame.address, this.address)) return;

        if (frame.domain !== 'fan') {
            // The light's codes carry the same address, so this device hears
            // them whether it wants to or not. Said once, because it is worth
            // knowing the light is audible — that is step 6's whole premise —
            // and a held dimmer button is 56 frames, which is not worth a line
            // each.
            if (this.heardLight !== true) {
                this.heardLight = true;
                this.log(`heard ${frame.key} from the handset; the light is a separate device, still to come`);
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
    // Through `set` rather than `reflect`: nothing is deferred here because no
    // capability listener is running — this comes from a radio event, not from a
    // request Homey is waiting on, so there is no post-listener write to lose a
    // race with. (A press landing in the same instant as a user's own change
    // could still lose one, and the next press puts it right, every fan command
    // being absolute.)
    //
    // `set`, never `triggerCapabilityListener`: this reflects a change the fan
    // has already made, and must not transmit it back to the fan.
    async mirror(frame) {
        switch (frame.command) {
            case 'off':
                await this.set('onoff', false);
                break;
            case 'speed':
                // A speed code starts the fan, so hearing one means both.
                await this.set('lucci_speed', frame.value);
                await this.set('onoff', true);
                break;
            case 'direction':
                await this.set('lucci_direction', frame.value);
                break;
            case 'timer':
                // What was commanded, not time remaining: the fan reports
                // nothing, so Homey cannot know when this expires.
                await this.set('lucci_timer', frame.value);
                break;
            default:
                // A fan command with no capability behind it yet. Logged rather
                // than ignored, because this is how a seventeenth button would
                // first announce itself.
                this.log(`heard ${frame.key}, which no capability tracks`);
                return;
        }

        this.log(`rx ${frame.key} from the handset`);
    }
}

module.exports = LucciFanDevice;
