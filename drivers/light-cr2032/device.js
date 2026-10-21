'use strict';

const Homey = require('homey');
const {
    SIGNAL_ID, ADDRESS_LENGTH, TAIL_LENGTH, PRESS_AIRTIME, buildFrame, sameAddress,
} = require('../../lib/cr2032-protocol');
const { reflect } = require('../../lib/reflect');
const { pressQueue, RELEASE_GAP } = require('../../lib/press-queue');

// The light on a CR2032-remote fan.
//
// **Written, and not one of its codes has been transmitted - and the fan this
// was built against has no light fitted.** The code is built from the same
// table as the fan's and the recordings show the toggle repeating itself
// exactly, which is reason to expect it to work and not evidence that it does.
// Anyone with a light fitted is the first to find out.
//
// There is one code: a stateless toggle. No brightness, no discrete on or off.
// So `onoff` is a belief, exactly as on the USB-C remote's light, and carries
// the same protections: idempotent against the belief, a toggle button beside
// it that claims nothing, a resync button that transmits nothing, and a first
// belief asked for at pair time rather than guessed.

// How long a received toggle is counted once, in milliseconds. One press is
// several frames and reception can split it, so counting each reception would
// flip the belief twice for one press. See the fan's device.js.
const RX_TOGGLE_WINDOW = 1000;

class Cr2032LightDevice extends Homey.Device {
    async onInit() {
        this.signal = this.homey.rf.getSignal433(SIGNAL_ID);
        this.press = pressQueue({
            wait: ms => this.wait(ms),
            now: () => Date.now(),
            interval: PRESS_AIRTIME + RELEASE_GAP,
        });

        this.address = this.getStoreValue('address');
        if (!Array.isArray(this.address) || this.address.length !== ADDRESS_LENGTH) {
            this.error('no address stored; the device must be added again');
            await this.setUnavailable(this.homey.__('errors.not_paired'));
            return;
        }
        this.tail = this.getStoreValue('tail');
        this.tailMismatches = 0;
        if (!Array.isArray(this.tail) || this.tail.length !== TAIL_LENGTH) {
            this.error('no tail stored; the device must be added again');
            await this.setUnavailable(this.homey.__('errors.not_paired'));
            return;
        }

        // Whether the light is believed to be lit. **Held here rather than read
        // back from the capability**, because inside a listener the capability is
        // stale. After a restart the capability wins, holding everything that has
        // happened since; on the very first init the fallback is what the user
        // was asked at pair time.
        const known = this.getCapabilityValue('onoff');
        const told = this.getStoreValue('lit');
        this.lit = known === null ? told === true : known === true;
        this.log(`initialised; address ${this.address.join('')}, tail ${this.tail.join('')};`
            + ` light is believed ${this.lit ? 'on' : 'off'}`
            + (known === null
                ? ` (first run; you said it was ${told === true ? 'on' : 'off'} when pairing)`
                : ' (carried over from before the restart)'));
        if (known === null) await this.set('onoff', this.lit);

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('lucci_toggle', this.onCapabilityToggle.bind(this));
        this.registerCapabilityListener('lucci_resync', this.onCapabilityResync.bind(this));

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
    async send(key, why) {
        const payload = buildFrame(this.address, key, this.tail);

        return this.press(async () => {
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

    wait(ms) {
        return new Promise(resolve => { this.homey.setTimeout(resolve, ms); });
    }

    // One stateless toggle behind a capability that means a state, so `onoff` is
    // idempotent against what Homey believes and transmits only when the belief
    // has to change. "Turn it on" twice turns it on once.
    //
    // What it cannot fix is a belief that is already wrong: then an `onoff`
    // command correctly does nothing and the light stays where it was. That is
    // what `lucci_toggle` is for. These fans are installed behind wall switches,
    // so an unpowered fitting makes every command do nothing, silently.
    async onCapabilityOnOff(value) {
        const believed = this.lit;
        if (value === believed) {
            this.log(`onoff ${value}: already believed to be ${value ? 'on' : 'off'}; nothing sent`);
            return;
        }

        // Committed before anything is awaited.
        this.lit = value;

        if (await this.send('light.toggle', `onoff ${value}`) !== 'sent') {
            this.lit = believed;
            throw new Error(this.homey.__('errors.tx_failed'));
        }
        this.log(`tx light.toggle (${believed ? 'on' : 'off'} -> ${value ? 'on' : 'off'})`);
    }

    // One press, one toggle, no claim about the result.
    async onCapabilityToggle() {
        const believed = this.lit;
        this.lit = !believed;

        if (await this.send('light.toggle', 'toggle') !== 'sent') {
            this.lit = believed;
            throw new Error(this.homey.__('errors.tx_failed'));
        }
        this.log(`tx light.toggle (toggle; ${believed ? 'on' : 'off'} -> ${this.lit ? 'on' : 'off'})`);

        // Deferred, because this is a write from inside a listener for another
        // capability - the trap that cost a round trip once already.
        reflect(this, { onoff: this.lit });
    }

    // Corrects Homey's belief without touching the light: the only control here
    // that transmits nothing. It flips rather than sets, because a button press
    // carries no value and the useful statement is always "it is the other way
    // round".
    async onCapabilityResync() {
        this.lit = !this.lit;
        this.log(`corrected: Homey now believes the light is ${this.lit ? 'on' : 'off'};`
            + ' nothing was transmitted');
        reflect(this, { onoff: this.lit });
    }

    noteTail(frame) {
        if (sameAddress(frame.tail, this.tail)) return;

        this.tailMismatches += 1;
        if (this.tailMismatches > 1) return;
        this.log(`${frame.key} arrived with tail ${frame.tail.join('')} where this device stores`
            + ` ${this.tail.join('')} - so the tail is not constant for one remote.`);
    }

    onRX(frame, isFirst) {
        if (isFirst === false) return;
        if (!frame.addressSure) return;
        if (!sameAddress(frame.address, this.address)) return;

        this.noteTail(frame);
        if (frame.domain !== 'light') return;

        const now = Date.now();
        if (now - (this.lastRxAt ?? -Infinity) < RX_TOGGLE_WINDOW) return;
        this.lastRxAt = now;

        this.mirror().catch(err => this.error(`mirroring ${frame.key} failed:`, err.message));
    }

    // Stateless: the remote toggled it, so whatever Homey believed, the opposite
    // is now true. Homey does not hear its own transmissions - checked on the
    // USB-C remote's hardware - so every frame here is someone at the remote.
    async mirror() {
        this.lit = !this.lit;
        await this.set('onoff', this.lit);
        this.log(`rx light.toggle from the remote; now ${this.lit ? 'on' : 'off'}`);
    }
}

module.exports = Cr2032LightDevice;
