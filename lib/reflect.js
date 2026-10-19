'use strict';

// Writes capability values that a request did not itself carry, after the
// listener that asked for them has resolved.
//
// **Setting a capability from inside the listener for a different one does not
// stick.** Homey writes the capabilities a request carried when the listener
// resolves, and a write made inside is lost. Nothing throws. It shipped once —
// the speed picker transmitted, the fan moved, and the `onoff` tile stayed off
// until a toggle that did nothing, the fan already running — and it cost a
// hardware round trip to find, because the error that would have explained it
// was swallowed by an unbound `.catch(this.error)`.
//
// So the write waits its turn and then reads itself back. The read-back is the
// part that matters: this was invisible until someone watched a tile, and a log
// line is what let the next run settle it.
//
// Shared by both devices because the reasoning is what must not be duplicated.
// `set` is the device's own guarded writer, which reports a failure instead of
// losing it.
function reflect(device, wanted, requested = {}) {
    const pending = Object.entries(wanted).filter(([capability, value]) => requested[capability] === undefined
        && device.getCapabilityValue(capability) !== value);
    if (pending.length === 0) return;

    device.homey.setTimeout(async () => {
        for (const [capability, value] of pending) {
            if (!await device.set(capability, value)) continue;

            const now = device.getCapabilityValue(capability);
            if (now === value) device.log(`${capability} -> ${JSON.stringify(value)}`);
            else device.error(`${capability} would not hold ${JSON.stringify(value)}; reads ${JSON.stringify(now)}`);
        }
    }, 0);
}

module.exports = { reflect };
