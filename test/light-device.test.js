'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { ADDRESS_LENGTH, identifyFrame, buildFrame } = require('../lib/lucci-protocol');
const position = require('../lib/light-position');

// As in test/device.test.js, with one difference that matters: setTimeout fires
// at once. A move is dozens of presses 150ms apart, and the point of these
// tests is which codes go out in which order, not how long that takes.
class FakeDevice {
    constructor() {
        this.storeValues = {};
        this.capabilityValues = {};
        this.listeners = {};
        this.sent = [];
        this.logs = [];
        this.rxListeners = new Set();
        this.txFails = false;

        this.homey = {
            setTimeout: (fn) => setTimeout(fn, 0),
            clearTimeout: (...args) => clearTimeout(...args),
            __: key => key,
            rf: {
                getSignal433: () => ({
                    tx: async payload => {
                        if (this.txFails) throw new Error('radio busy');
                        this.sent.push(payload);
                    },
                }),
            },
        };

        this.driver = {
            registerRXListener: async listener => { this.rxListeners.add(listener); },
            unregisterRXListener: async listener => { this.rxListeners.delete(listener); },
        };
    }

    getStoreValue(key) { return this.storeValues[key] ?? null; }
    async setStoreValue(key, value) { this.storeValues[key] = value; }
    getCapabilityValue(key) { return this.capabilityValues[key] ?? null; }
    async setCapabilityValue(key, value) { this.capabilityValues[key] = value; }
    registerCapabilityListener(id, listener) { this.listeners[id] = listener; }
    async setUnavailable(reason) { this.unavailable = reason; }
    log(...args) { this.logs.push(args.join(' ')); }
    error(...args) { this.logs.push(`ERROR ${args.join(' ')}`); }
}

const STUB = path.join(__dirname, 'homey.light.stub.js');
require.cache[STUB] = {
    id: STUB, filename: STUB, loaded: true, exports: { Device: FakeDevice },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'homey' ? STUB : resolveFilename.call(this, request, ...rest);
};

const LucciLightDevice = require('../drivers/light/device');

const ADDRESS = '0101110011110011'.split('').map(Number);

async function light({ on = true, at } = {}) {
    const device = new LucciLightDevice();
    device.storeValues.address = ADDRESS;
    if (at !== undefined) device.storeValues.position = at;
    device.capabilityValues.onoff = on;
    await device.onInit();
    return device;
}

const keysSent = device => device.sent.map(payload => identifyFrame(payload).key);
const counted = (device, key) => keysSent(device).filter(k => k === key).length;

// A capability request, then the move it may have started.
async function request(device, capability, value) {
    await device.listeners[capability](value, {});
    device.capabilityValues[capability] = value;
    await device.moving;
}

async function receive(device, key, isFirst = true) {
    for (const listener of device.rxListeners) listener(identifyFrame(buildFrame(ADDRESS, key)), isFirst);
    await new Promise(resolve => setTimeout(resolve, 1));
}

test('a light with no stored address refuses to transmit', async () => {
    const device = new LucciLightDevice();
    await device.onInit();

    assert.equal(device.unavailable, 'errors.not_paired');
    assert.deepEqual(Object.keys(device.listeners), []);
});

test('the brightness starts out unknown, and survives a restart once known', async () => {
    const fresh = await light();
    assert.equal(fresh.position, null);
    assert.ok(fresh.logs.some(line => line.includes('brightness unknown')), fresh.logs.join(' | '));

    const resumed = await light({ at: 11 });
    assert.equal(resumed.position, 11);
    assert.ok(resumed.logs.some(line => line.includes('believed step 11')));

    // A stored value that is not a step is no position at all.
    const nonsense = await light({ at: 99 });
    assert.equal(nonsense.position, null);
});

test('onoff sends the one stateless toggle code', async () => {
    const device = await light({ on: false, at: 10 });
    await request(device, 'onoff', true);

    assert.deepEqual(keysSent(device), ['light.onoff']);
    // Nothing about brightness: the toggle says nothing about the level, and
    // the level says nothing about the toggle.
    assert.equal(device.position, 10);
});

test('a brightness button is one press and one step', async () => {
    const device = await light({ at: 10 });

    await request(device, 'lucci_brighter', true);
    assert.deepEqual(keysSent(device), ['light.brighter']);
    assert.equal(device.position, 11);
    assert.equal(device.storeValues.position, 11, 'the step was not remembered');

    await request(device, 'lucci_dimmer', true);
    assert.equal(device.position, 10);
});

test('a brightness button from an unknown position stays unknown', async () => {
    // One press is one step, but a step from nowhere is still nowhere. The
    // button is still correct — that is the point of it — and the slider is
    // what needs a position.
    const device = await light();
    await request(device, 'lucci_brighter', true);

    assert.deepEqual(keysSent(device), ['light.brighter']);
    assert.equal(device.position, null);
});

test('brightness does nothing while the light is off, and says so', async () => {
    // Confirmed on the hardware: the brightness codes are ignored unless the
    // light is already on. A no-op with a log line beats a silent failure.
    const device = await light({ on: false, at: 10 });

    await request(device, 'lucci_brighter', true);
    await request(device, 'lucci_dimmer', true);
    await request(device, 'dim', 0.5);

    assert.deepEqual(device.sent, [], 'transmitted at a light that cannot hear it');
    assert.equal(device.position, 10, 'the estimate moved for a press that did nothing');
    assert.equal(device.logs.filter(line => line.includes('the light is off')).length, 3);
});

test('dim can never be the thing that turns the light on', async () => {
    const device = await light({ on: false, at: 10 });
    await request(device, 'dim', 1);

    assert.deepEqual(device.sent, []);
    assert.equal(device.capabilityValues.onoff, false);
});

test('dim steps the difference when the position is known', async () => {
    const device = await light({ at: 10 });
    await request(device, 'dim', position.toDim(16));

    assert.equal(counted(device, 'light.brighter'), 6);
    assert.equal(counted(device, 'light.dimmer'), 0);
    assert.equal(device.position, 16);
});

test('dim to an end oversteps, and the end makes it a fact', async () => {
    const device = await light({ at: 10 });
    await request(device, 'dim', 0);

    // 10 steps down, plus the margin the end stop absorbs.
    assert.equal(counted(device, 'light.dimmer'), 10 + position.MARGIN);
    assert.equal(device.position, position.MIN);
    assert.equal(device.storeValues.position, position.MIN);
});

test('dim from nowhere saturates first, then steps off the end', async () => {
    const device = await light();
    await request(device, 'dim', position.toDim(5));

    assert.equal(counted(device, 'light.dimmer'), position.SATURATE);
    assert.equal(counted(device, 'light.brighter'), 5);
    assert.equal(device.position, 5, 'the anchor did not hand on a known position');
});

test('the slider shows the target at once, not when the radio catches up', async () => {
    // A full-range move is seconds of transmission. A capability listener that
    // took that long would read as a device that had stopped responding.
    const device = await light({ at: 0 });
    const target = position.toDim(position.MAX);

    const started = device.listeners.dim(target, {});
    assert.equal(device.capabilityValues.dim, target, 'the slider lagged the request');

    await started;
    await device.moving;
    assert.equal(device.position, position.MAX);
});

test('a new target cancels the move in flight rather than queueing behind it', async () => {
    // Dragging the slider emits a value per step. Queued, that would back up a
    // minute of transmission for a move the user has already changed their mind
    // about.
    const device = await light({ at: 0 });

    device.listeners.dim(position.toDim(position.MAX), {});
    await new Promise(resolve => setTimeout(resolve, 1));
    const partway = device.sent.length;
    assert.ok(partway > 0 && partway < position.MAX, `sent ${partway} of a 31-press move`);

    await request(device, 'dim', position.toDim(2));

    assert.ok(device.logs.some(line => line.includes('cancelled the move in flight')), device.logs.join(' | '));
    // And the presses that did go out were counted, so the estimate survived.
    assert.equal(device.position, 2);
});

test('dim to where the light already is sends nothing', async () => {
    const device = await light({ at: 14 });
    await request(device, 'dim', position.toDim(14));

    assert.deepEqual(device.sent, []);
    assert.ok(device.logs.some(line => line.includes('already at step 14')));
});

test('a move cut off by a transmission failure keeps what it managed', async () => {
    const device = await light({ at: 20 });
    device.listeners.dim(position.toDim(10), {});
    await new Promise(resolve => setTimeout(resolve, 1));

    device.txFails = true;
    await device.moving;

    // One press is one step, so the presses that did go out are exactly what
    // moved. The estimate is lower than it was and higher than the target.
    assert.ok(device.position < 20 && device.position >= 10, `position ${device.position}`);
    assert.ok(device.logs.some(line => line.startsWith('ERROR')), device.logs.join(' | '));
});

test('calibrating drives into an end stop and cannot fail', async () => {
    const device = await light();
    const seconds = await device.calibrate('dimmest');
    await device.moving;

    assert.equal(counted(device, 'light.dimmer'), position.SATURATE);
    assert.equal(device.position, position.MIN);
    assert.ok(seconds > 20, `said ${seconds}s`);

    const up = await light();
    await up.calibrate('brightest');
    await up.moving;
    assert.equal(up.position, position.MAX);
});

test('calibrating a light that is off is refused, not attempted', async () => {
    const device = await light({ on: false });
    await assert.rejects(() => device.calibrate('dimmest'), /errors\.light_off/);
    assert.deepEqual(device.sent, []);
});

// --- following the handset ---------------------------------------------------

test('a received toggle flips onoff, whatever Homey believed', async () => {
    const device = await light({ on: true, at: 10 });
    await receive(device, 'light.onoff');
    assert.equal(device.capabilityValues.onoff, false);

    await receive(device, 'light.onoff');
    assert.equal(device.capabilityValues.onoff, true);
});

test('a received brightness press moves the estimate by one', async () => {
    const device = await light({ at: 10 });

    await receive(device, 'light.brighter');
    assert.equal(device.position, 11);
    assert.equal(device.capabilityValues.dim, position.toDim(11), 'the slider did not follow');

    await receive(device, 'light.dimmer');
    assert.equal(device.position, 10);
});

test('received brightness presses are NOT collapsed', async () => {
    // The fan collapses repeats of one command over two seconds, which is safe
    // because every fan command is absolute. These are relative — one press,
    // one step — so collapsing would drop steps with no way to notice.
    const device = await light({ at: 10 });

    await receive(device, 'light.brighter');
    await receive(device, 'light.brighter');
    await receive(device, 'light.brighter');

    assert.equal(device.position, 13, 'presses at the handset were collapsed');
});

test('a press at the handset mid-move abandons the move', async () => {
    // Both sides are stepping the same light and only one is counting. The
    // user's own press is the thing that happened.
    const device = await light({ at: 0 });
    device.listeners.dim(position.toDim(position.MAX), {});
    await new Promise(resolve => setTimeout(resolve, 1));

    await receive(device, 'light.dimmer');
    await device.moving;

    assert.ok(device.logs.some(line => line.includes('at the handset')), device.logs.join(' | '));
    assert.equal(device.move, null);
});

test('the light ignores the fan, and other households', async () => {
    const device = await light({ on: true, at: 10 });

    for (const listener of device.rxListeners) {
        listener(identifyFrame(buildFrame(ADDRESS, 'fan.speed.3')), true);
        listener(identifyFrame(buildFrame(ADDRESS.map((b, i) => (i ? b : b ^ 1)), 'light.onoff')), true);
    }
    await new Promise(resolve => setTimeout(resolve, 1));

    assert.equal(device.position, 10);
    assert.equal(device.capabilityValues.onoff, true);
});

test('following the handset never transmits', async () => {
    const device = await light({ at: 10 });
    for (const key of ['light.onoff', 'light.brighter', 'light.dimmer']) await receive(device, key);

    assert.deepEqual(device.sent, [], 'mirroring put a frame on air');
});

test('shutting down stops the radio and the move', async () => {
    const device = await light({ at: 0 });
    device.listeners.dim(position.toDim(position.MAX), {});
    await new Promise(resolve => setTimeout(resolve, 1));

    await device.onUninit();
    await device.moving;

    assert.equal(device.rxListeners.size, 0);
    assert.equal(device.move, null);
});
