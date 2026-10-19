'use strict';

const Homey = require('homey');
const { SIGNAL_ID, ADDRESS_LENGTH, buildFrame, sameAddress } = require('../../lib/lucci-protocol');
const position = require('../../lib/light-position');
const { reflect } = require('../../lib/reflect');
const { pressQueue, PRESS_INTERVAL } = require('../../lib/press-queue');


// How long to wait before saying a move is still going, in milliseconds. A nudge
// of a step or two is done inside this; only the long moves get a line.
const SLOW_MOVE = 3000;

class LucciLightDevice extends Homey.Device {
    async onInit() {
        this.signal = this.homey.rf.getSignal433(SIGNAL_ID);

        // Every press this device makes goes through here, so no two are ever
        // laid on top of each other. See lib/press-queue.js: tx() resolves when
        // Homey has queued a transmission, not when it has finished, and a press
        // is 423ms of airtime.
        this.press = pressQueue({ wait: ms => this.wait(ms), now: () => Date.now() });

        // Learned from the user's own handset at pair time. Transmitting a
        // guessed address would drive whichever light answers to it.
        this.address = this.getStoreValue('address');
        if (!Array.isArray(this.address) || this.address.length !== ADDRESS_LENGTH) {
            this.error('no address stored; the device must be added again');
            await this.setUnavailable(this.homey.__('errors.not_paired'));
            return;
        }

        // Whether the light is believed to be lit.
        //
        // **Held here rather than read back from the capability**, because
        // inside a listener the capability is stale: Homey writes a requested
        // value when the listener resolves, not before it runs. Reading it there
        // made the second of two quick presses compare itself against the value
        // from before the first, conclude there was nothing to do, and send
        // nothing — one toggle for two presses, and Homey left believing the
        // opposite of what the light was doing. The capability is this field's
        // display; this field is what the code decides on.
        this.lit = this.getCapabilityValue('onoff') === true;

        // Where the light is believed to be, as a step, or null for "no idea".
        //
        // Kept in the store rather than read back off `dim`, because `dim` is
        // the target the user asked for and is deliberately allowed to run
        // ahead of the light while a move is still transmitting. Confusing the
        // two would make every interrupted move look complete.
        const stored = this.getStoreValue('position');
        this.position = position.isStep(stored) ? stored : null;
        // Bit 24 as this handset was heard to send it, learned at pair time
        // because it cannot be computed: it is neither parity nor a constant.
        // Without it there is nothing to transmit — a guess on the air would
        // look like a working device driving nothing — so the device waits to be
        // added again, exactly as it does without an address. See RF_PROTOCOL.md.
        this.bit24 = this.getStoreValue('bit24');
        this.bit24Mismatches = 0;
        if (this.bit24 !== 0 && this.bit24 !== 1) {
            this.error('no bit 24 stored; the device must be added again');
            await this.setUnavailable(this.homey.__('errors.not_paired'));
            return;
        }

        this.log(`initialised; address ${this.address.join('')},`
            + ` bit 24 ${this.bit24};`
            + ` brightness ${this.position === null ? 'unknown' : `believed step ${this.position}`}`);

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
        this.registerCapabilityListener('lucci_brighter', () => this.nudge(position.KEY_UP));
        this.registerCapabilityListener('lucci_dimmer', () => this.nudge(position.KEY_DOWN));
        this.registerCapabilityListener('lucci_toggle', this.onCapabilityToggle.bind(this));

        this.onRX = this.onRX.bind(this);
        try {
            await this.driver.registerRXListener(this.onRX);
        } catch (err) {
            this.error('could not listen for the handset; state may go stale:', err.message);
        }
    }

    async onUninit() {
        this.cancelMove('the device is shutting down');
        await this.driver.unregisterRXListener(this.onRX)
            .catch(err => this.error('could not stop listening:', err.message));
    }

    // setCapabilityValue with the failure actually reported. See the fan's
    // device.js: an unbound `.catch(this.error)` throws inside its own handler
    // and loses the original.
    async set(capability, value) {
        try {
            await this.setCapabilityValue(capability, value);
            return true;
        } catch (err) {
            this.error(`could not set ${capability} to ${JSON.stringify(value)}:`, err.message);
            return false;
        }
    }

    // Queues one press, and says what became of it.
    //
    // `stillWanted` is checked at the moment the press reaches the front of the
    // queue, not when it was asked for. That is the difference between
    // cancelling a move and merely stopping it: a press is 423ms of airtime, so
    // the next one waits 573ms for its turn, and a move abandoned during that
    // wait has a press already committed. Dropping it there is what keeps the
    // position estimate honest — a press that never went out must not be counted
    // as a step, and a new move's plan must not be undercut by one that was
    // supposed to be over.
    async send(key, why, stillWanted = null) {
        const payload = buildFrame(this.address, key, this.bit24);

        return this.press(async () => {
            if (stillWanted !== null && !stillWanted()) {
                this.log(`tx ${key} dropped before it reached the air (${why})`);
                return 'skipped';
            }

            try {
                await this.signal.tx(payload);
                return 'sent';
            } catch (err) {
                this.error(`tx ${key} failed (${why}):`, err.message);
                this.error(`  payload was [${payload.join('')}]`);
                return 'failed';
            }
        });
    }

    // One stateless toggle code behind a capability that means a state.
    //
    // **So `onoff` is idempotent against what Homey believes**, and transmits
    // only when the belief has to change. That is what `onoff` means everywhere
    // else — "turn it on" twice turns it on once — and getting it wrong here had
    // two consequences, both reported from the hardware.
    //
    // A flow asking for on, twice, used to send two toggles and turn the light
    // off. And two quick presses of the tile, which Homey can deliver as a
    // single listener call carrying the net value, used to send one toggle and
    // leave Homey and the light inverted — the exact drift this capability is
    // blamed for. Both disappear when the question is "does the belief need to
    // change" rather than "was a button pressed".
    //
    // What it cannot fix: a belief that is already wrong. Then an `onoff`
    // command correctly does nothing, and the light stays where it was. That is
    // what `lucci_toggle` is for, and what the wall switches these fans are
    // installed behind make unavoidable — see APP_PLAN.md under Known state
    // drift.
    async onCapabilityOnOff(value) {
        const believed = this.lit;
        if (value === believed) {
            this.log(`onoff ${value}: already believed to be ${value ? 'on' : 'off'}; nothing sent`);
            return;
        }

        // Committed before anything is awaited, so a press arriving while this
        // one is still in flight sees the new belief rather than the old one.
        this.lit = value;

        // A move still going would be transmitting brightness codes at a light
        // that is about to be switched, and those are ignored while it is off.
        this.cancelMove(`onoff ${value}`);

        if (await this.send('light.onoff', `onoff ${value}`) !== 'sent') {
            // The belief goes back: nothing reached the light.
            this.lit = believed;
            throw new Error(this.homey.__('errors.tx_failed'));
        }
        this.log(`tx light.onoff (${believed ? 'on' : 'off'} -> ${value ? 'on' : 'off'})`);
    }

    // One press, one toggle, no claim about the result.
    //
    // The honest primitive, and the same argument as the brightness buttons: a
    // press is an event, so it cannot be collapsed by value the way a state
    // change can, and it is correct however the light got to where it is. It is
    // the way out when the belief behind `onoff` has drifted — press it until
    // the light is doing what you want, and Homey follows along.
    async onCapabilityToggle() {
        const believed = this.lit;
        this.lit = !believed;
        this.cancelMove('toggle');

        if (await this.send('light.onoff', 'toggle') !== 'sent') {
            this.lit = believed;
            throw new Error(this.homey.__('errors.tx_failed'));
        }
        this.log(`tx light.onoff (toggle; ${believed ? 'on' : 'off'} -> ${this.lit ? 'on' : 'off'})`);

        // Deferred, because this is a write from inside a listener for another
        // capability — the trap that cost a round trip once already.
        reflect(this, { onoff: this.lit });
    }

    // One press, one step, and nothing to remember. The honest core of the
    // brightness controls: correct however the light got to where it is, which
    // no slider can claim.
    async nudge(key) {
        if (!this.isOn(key)) return;

        this.cancelMove(key);
        if (await this.send(key, key) !== 'sent') throw new Error(this.homey.__('errors.tx_failed'));

        this.position = position.stepped(this.position, key);
        await this.rememberPosition();
        this.log(`tx ${key} (one step; ${this.describePosition()})`);
    }

    // The slider. See "The slider" in APP_PLAN.md for the mechanism and
    // light-position.js for the arithmetic, which is tested on its own.
    async onCapabilityDim(value) {
        // **`dim` can never be what turns the light on.** The brightness codes
        // are ignored while the light is off, confirmed on the hardware, so a
        // move would transmit for up to twenty seconds and change nothing.
        if (!this.isOn('dim')) return;

        const target = position.toStep(value);
        const made = position.plan(this.position, target);

        if (made.moves.length === 0) {
            this.log(`dim: already at step ${target}; nothing to send`);
            return;
        }

        // Started rather than awaited. A full-range move is seconds of
        // transmission, and a capability listener that takes that long reads as
        // a device that has stopped responding — so the slider shows the target
        // at once and the radio catches up, as a thermostat does.
        this.startMove(made, `dim ${Math.round(value * 100)}% (step ${target})`);
    }

    // Drives the light into an end stop and takes the position from there.
    //
    // This cannot fail, which is the whole point of it: the light saturates at
    // both ends rather than wrapping, so enough presses in one direction arrive
    // whatever the app believed beforehand. It is the repair for an estimate
    // that has drifted, and the only way back from "no idea".
    async calibrate(end) {
        if (!this.isOn('calibrate')) throw new Error(this.homey.__('errors.light_off'));

        const target = end === 'brightest' ? position.MAX : position.MIN;
        const made = position.plan(null, target);
        const seconds = Math.ceil(position.airtime(made.moves, PRESS_INTERVAL) / 1000);

        this.log(`calibrating to ${end}: ${made.moves[0].presses} presses, about ${seconds}s`);
        this.startMove(made, `calibrate to ${end}`);
        return seconds;
    }

    // Starts a move, cancelling whatever was in flight.
    //
    // A new target has to cancel rather than queue: dragging the slider emits a
    // value per step, and queueing them would back up a minute of transmission
    // for a move the user has already changed their mind about.
    startMove(made, why) {
        this.cancelMove(why);

        const token = { cancelled: false, why };
        this.move = token;

        // The target, shown now. The light will be there in a few seconds.
        this.set('dim', position.toDim(made.endsAt)).catch(() => {});

        // Kept so a caller can wait for the move to finish — nothing in the
        // app has to, since a move is deliberately not awaited by the
        // capability listener, but it is the difference between testing this
        // and watching a radio.
        this.moving = this.runMove(made, token)
            .catch(err => this.error(`move (${why}) failed:`, err.message))
            .finally(() => { if (this.move === token) this.move = null; });
    }

    cancelMove(why) {
        if (this.move === null || this.move === undefined) return;
        this.move.cancelled = true;
        this.log(`cancelled the move in flight (${this.move.why}) for: ${why}`);
        this.move = null;
    }

    async runMove(made, token) {
        const total = made.moves.reduce((sum, move) => sum + move.presses, 0);
        const startedAt = Date.now();
        let sent = 0;
        let announced = false;

        for (const move of made.moves) {
            for (let i = 0; i < move.presses; i += 1) {
                if (token.cancelled) {
                    await this.rememberPosition();
                    this.log(`move stopped after ${sent}/${total} presses; ${this.describePosition()}`);
                    return;
                }

                const outcome = await this.send(move.key, token.why, () => !token.cancelled);

                if (outcome === 'skipped') {
                    // Cancelled while this press waited its turn, so it never
                    // went out and is not a step.
                    await this.rememberPosition();
                    this.log(`move stopped after ${sent}/${total} presses; ${this.describePosition()}`);
                    return;
                }
                if (outcome === 'failed') {
                    await this.rememberPosition();
                    throw new Error(`transmission failed after ${sent}/${total} presses`);
                }

                sent += 1;
                // One press is one step, so this is exact for every press that
                // the light actually heard — which is what makes an interrupted
                // move leave a usable estimate rather than nothing.
                this.position = position.stepped(this.position, move.key);

                if (!announced && Date.now() - startedAt > SLOW_MOVE) {
                    announced = true;
                    this.log(`move (${token.why}) is ${sent}/${total} presses in`);
                }
            }

            // A move that drove into an end stop knows where the light is,
            // however wrong the estimate was going in. This is also what hands a
            // known position to the stepping half of a saturate-then-step plan.
            if (move.anchorsAt !== undefined) this.position = move.anchorsAt;
        }

        await this.rememberPosition();
        this.log(`move (${token.why}) done in ${Date.now() - startedAt}ms; ${this.describePosition()}`);
    }

    wait(ms) {
        return new Promise(resolve => { this.homey.setTimeout(resolve, ms); });
    }

    async rememberPosition() {
        await this.setStoreValue('position', this.position)
            .catch(err => this.error('could not remember the brightness:', err.message));
    }

    describePosition() {
        return this.position === null ? 'brightness unknown' : `believed step ${this.position}`;
    }

    // The brightness codes do nothing while the light is off, confirmed on the
    // hardware. A no-op with a line in the log beats a silent failure, and beats
    // throwing at a user who pressed a button that looks available.
    isOn(what) {
        if (this.lit) return true;
        this.log(`ignored ${what}: the light is off, and brightness codes do nothing until it is on`);
        return false;
    }


    // Whether a received frame agrees with this device about bit 24.
    //
    // **This is the one line that would say what bit 24 actually is.** It is
    // learned from one press, so a handset that varies the bit across its
    // sixteen commands would disagree here — and a handset that holds it
    // constant never will. Said once per device, because thousands of frames is
    // not thousands of findings.
    noteBit24(frame) {
        if (frame.bit24 === null) return;
        if (frame.bit24 === this.bit24) return;

        this.bit24Mismatches += 1;
        if (this.bit24Mismatches > 1) return;
        this.log(`${frame.key} arrived with bit 24 ${frame.bit24} where this device stores`
            + ` ${this.bit24} — so the bit is not constant for one handset, which is`
            + ' the thing RF_PROTOCOL.md says is unknown about it.');
    }

    onRX(frame, isFirst) {
        if (isFirst === false) return;

        // A frame whose address had a bit guessed rather than heard cannot say
        // whose it is, and this receiver guesses one on every burst's first
        // frame. The rest of the burst arrives in full, so nothing is lost by
        // waiting for it — see "Bit 24" in RF_PROTOCOL.md for why the guess
        // stopped being exact.
        if (!frame.addressSure) return;

        if (!sameAddress(frame.address, this.address)) return;

        this.noteBit24(frame);
        if (frame.domain !== 'light') return;

        // **Deliberately not collapsed into a repeat window**, unlike the fan's.
        // The fan's commands are absolute, so a suppressed duplicate loses
        // nothing; these are relative, one press one step, and dropping one
        // would put the estimate out by a step with no way to notice. Homey does
        // not hear its own transmissions — checked on the hardware — so every
        // frame here is someone at the handset.
        this.mirror(frame).catch(err => this.error(`mirroring ${frame.key} failed:`, err.message));
    }

    async mirror(frame) {
        if (frame.command === 'onoff') {
            // Stateless: the handset toggled it, so whatever Homey believed,
            // the opposite is now true.
            const was = this.lit;
            this.lit = !was;
            await this.set('onoff', this.lit);
            this.log(`rx light.onoff from the handset; now ${this.lit ? 'on' : 'off'}`);
            return;
        }

        if (frame.command !== 'brighter' && frame.command !== 'dimmer') return;

        // A press at the handset while Homey is mid-move makes the estimate
        // wrong in a way neither side can reconcile: both are stepping the same
        // light and only one of them is counting. Giving up the move leaves the
        // user's own press as the thing that happened.
        if (this.move !== null && this.move !== undefined) {
            this.cancelMove(`${frame.key} at the handset`);
        }

        this.position = position.stepped(this.position, frame.key);
        await this.rememberPosition();
        if (this.position !== null) await this.set('dim', position.toDim(this.position));

        this.log(`rx ${frame.key} from the handset; ${this.describePosition()}`);
    }
}

module.exports = LucciLightDevice;
