'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const p = require('../lib/cr2032-protocol');

// Everything a device asks of Homey, and nothing else. What this file is for is
// which frame goes out for which request, what the device believes afterwards,
// and what a heard press does to that belief - none of which needs a radio.
class FakeDevice {
    constructor() {
        this.storeValues = {};
        this.capabilityValues = {};
        this.multiListener = null;
        this.listeners = {};
        this.sent = [];
        this.logs = [];
        this.rejectTx = false;
        this.rxListeners = new Set();
        this.triggered = [];

        this.homey = {
            setTimeout: (...args) => setTimeout(...args),
            clearTimeout: (...args) => clearTimeout(...args),
            __: key => key,
            flow: {
                getDeviceTriggerCard: id => ({
                    trigger: async (device, tokens, state) => { this.triggered.push({ id, value: state.value }); },
                }),
            },
            rf: {
                getSignal433: id => ({
                    id,
                    tx: async payload => {
                        if (this.rejectTx) throw new Error('radio busy');
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
    getCapabilityValue(key) { return this.capabilityValues[key] ?? null; }

    async setCapabilityValue(key, value) { this.capabilityValues[key] = value; }

    registerMultipleCapabilityListener(ids, listener, timeout) {
        this.multiListener = { ids, listener, timeout };
    }

    registerCapabilityListener(id, listener) { this.listeners[id] = listener; }

    async setUnavailable(reason) { this.unavailable = reason; }
    log(...args) { this.logs.push(args.join(' ')); }
    error(...args) { this.logs.push(`ERROR ${args.join(' ')}`); }
}

const STUB = path.join(__dirname, 'homey.cr2032.device.stub.js');
require.cache[STUB] = {
    id: STUB, filename: STUB, loaded: true, exports: { Device: FakeDevice },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'homey' ? STUB : resolveFilename.call(this, request, ...rest);
};

const Cr2032FanDevice = require('../drivers/fan-cr2032/device');
const Cr2032LightDevice = require('../drivers/light-cr2032/device');

const ADDRESS = '1100010100101110'.split('').map(Number);
const OTHER = ADDRESS.map((b, i) => (i === 0 ? 1 - b : b));
const TAIL = [1, 0];

const tick = () => new Promise(resolve => setTimeout(resolve, 2));

async function make(Kind, { store = {}, capabilities = {} } = {}) {
    const device = new Kind();
    device.storeValues = { address: ADDRESS, tail: TAIL, ...store };
    device.capabilityValues = { ...capabilities };
    // The press queue spaces presses 473ms apart. Nothing here is about the
    // spacing - test/press-queue.test.js owns that - so no test waits for it.
    device.wait = () => Promise.resolve();
    await device.onInit();
    return device;
}

const fan = options => make(Cr2032FanDevice, options);
const light = options => make(Cr2032LightDevice, options);

const keysSent = device => device.sent.map(payload => p.identifyFrame(payload).key);

// One request, the way Homey makes it: the listener runs, then Homey writes the
// capabilities that were asked for. Anything the device wants to write itself is
// deferred past both.
async function request(device, values) {
    await device.multiListener.listener(values, {});
    for (const [capability, value] of Object.entries(values)) device.capabilityValues[capability] = value;
    await tick();
}

async function setOne(device, capability, value) {
    await device.listeners[capability](value, {});
    device.capabilityValues[capability] = value;
    await tick();
}

// A frame arriving off the air, as the driver hands it to every device.
async function hear(device, key, { address = ADDRESS, tail = TAIL, isFirst = true } = {}) {
    const frame = p.identifyFrame(p.buildFrame(address, key, tail));
    for (const listener of device.rxListeners) listener(frame, isFirst);
    await tick();
}

// ------------------------------------------------------------------ the fan --

test('a fan with no address, or no tail, refuses to transmit', async () => {
    for (const store of [{ address: null }, { address: ADDRESS.slice(1) }, { tail: null }, { tail: [1] }]) {
        const device = await fan({ store });
        assert.equal(device.unavailable, 'errors.not_paired', JSON.stringify(store));
        assert.equal(device.multiListener, null, 'no listener, so nothing can be sent');
    }
});

test('onInit transmits nothing', async () => {
    const device = await fan();
    assert.equal(device.sent.length, 0);
    assert.equal(device.rxListeners.size, 1, 'it follows the remote');
});

test('the speed picker sends that step\'s code, with this remote\'s address and tail', async () => {
    const device = await fan();
    await request(device, { lucci_speed: '3' });

    assert.deepEqual(device.sent, [p.buildFrame(ADDRESS, 'fan.speed.3', TAIL)]);
    assert.equal(device.capabilityValues.onoff, true, 'a speed starts the fan, so the tile says so');
});

test('off sends the off code and leaves the speed to come back to', async () => {
    const device = await fan({ capabilities: { onoff: true, lucci_speed: '4' } });
    await request(device, { onoff: false });
    assert.deepEqual(keysSent(device), ['fan.off']);

    await request(device, { onoff: true });
    assert.deepEqual(keysSent(device), ['fan.off', 'fan.speed.4'], 'on is the stored speed: the remote has no "on"');
});

test('a fan never given a speed starts on the default', async () => {
    const device = await fan();
    assert.equal(device.capabilityValues.lucci_speed, '2');
    await request(device, { onoff: true });
    assert.deepEqual(keysSent(device), ['fan.speed.2']);
});

test('off leads when both are asked for', async () => {
    const device = await fan();
    await request(device, { onoff: false, lucci_speed: '5' });
    assert.deepEqual(keysSent(device), ['fan.off']);
});

test('the only direction control is a button: no picker, no belief, no timer', async () => {
    const device = await fan();

    assert.deepEqual(Object.keys(device.listeners), ['lucci_reverse']);
    assert.equal(device.direction, undefined, 'nothing is believed about the direction');
    assert.equal(device.capabilityValues.lucci_direction, undefined);
    assert.equal(device.sent.length, 0, 'onInit must not transmit');
});

test('the change-direction button sends exactly one reverse per press', async () => {
    const device = await fan();
    await setOne(device, 'lucci_reverse', true);
    assert.deepEqual(device.sent, [p.buildFrame(ADDRESS, 'fan.reverse', TAIL)]);

    // Pressed again, it is another flip: a press is an event, not a value, so it
    // is never collapsed the way a state change would be.
    await setOne(device, 'lucci_reverse', true);
    assert.deepEqual(keysSent(device), ['fan.reverse', 'fan.reverse']);
});

test('two quick presses are two flips, not one', async () => {
    const device = await fan();
    await Promise.all([device.listeners.lucci_reverse(true), device.listeners.lucci_reverse(true)]);
    await tick();

    assert.deepEqual(keysSent(device), ['fan.reverse', 'fan.reverse']);
});

test('pressing it writes no capability, because there is nothing to show', async () => {
    const device = await fan({ capabilities: { onoff: true, lucci_speed: '3' } });
    const before = { ...device.capabilityValues };
    await setOne(device, 'lucci_reverse', true);

    assert.deepEqual(Object.keys(device.capabilityValues).sort(), Object.keys({ ...before, lucci_reverse: true }).sort());
    assert.equal(device.capabilityValues.onoff, true, 'a flip does not change whether the fan is on');
    assert.equal(device.capabilityValues.lucci_speed, '3');
});

test('a press that never reached the air is reported, not swallowed', async () => {
    const device = await fan();
    device.rejectTx = true;

    await assert.rejects(device.listeners.lucci_reverse(true), /errors\.tx_failed/);
    assert.ok(device.logs.some(l => l.startsWith('ERROR tx fan.reverse failed')), device.logs.join(' | '));
    assert.ok(device.logs.some(l => l.includes('payload was [')), 'the payload is logged for diagnosis');
});

test('a reverse is still sent to a fan believed off, and says so in its one log line', async () => {
    // The fan ignores a direction change while stopped - but Homey's belief can be
    // wrong, so the press goes out, and the log says what it will do.
    const stopped = await fan({ capabilities: { onoff: false } });
    const before = stopped.logs.length;
    await setOne(stopped, 'lucci_reverse', true);

    assert.deepEqual(keysSent(stopped), ['fan.reverse']);
    const lines = stopped.logs.slice(before);
    assert.equal(lines.length, 1, `one line per press: ${lines.join(' | ')}`);
    assert.match(lines[0], /^tx fan\.reverse ok \(lucci_reverse; fan believed off, which ignores direction until it runs, queued in \d+ms\)$/);

    const running = await fan({ capabilities: { onoff: true } });
    const was = running.logs.length;
    await setOne(running, 'lucci_reverse', true);
    const runningLines = running.logs.slice(was);
    assert.equal(runningLines.length, 1);
    assert.equal(runningLines[0].includes('believed off'), false);
    assert.equal(runningLines.some(l => l.includes('Open question')), false, 'the question is answered');
});

test('hearing reverse from the remote is noted and changes nothing', async () => {
    const device = await fan({ capabilities: { onoff: true, lucci_speed: '2' } });
    await hear(device, 'fan.reverse');

    assert.equal(device.sent.length, 0, 'a heard press must not be transmitted back');
    assert.deepEqual(device.capabilityValues, { onoff: true, lucci_speed: '2' });
    assert.ok(device.logs.some(l => l.includes('the direction is not tracked')), device.logs.join(' | '));
});

test('hearing a speed press follows the remote without answering it', async () => {
    const device = await fan();
    await hear(device, 'fan.speed.4');

    assert.equal(device.capabilityValues.lucci_speed, '4');
    assert.equal(device.capabilityValues.onoff, true);
    assert.equal(device.sent.length, 0, 'a heard press must not be transmitted back');
});

test('hearing off turns the tile off', async () => {
    const device = await fan({ capabilities: { onoff: true, lucci_speed: '1' } });
    await hear(device, 'fan.off');
    assert.equal(device.capabilityValues.onoff, false);
});

test('the same absolute press inside two seconds is one press', async (t) => {
    const device = await fan();
    const now = t.mock.method(Date, 'now', () => 1_000_000);
    await hear(device, 'fan.speed.1');
    device.capabilityValues.lucci_speed = 'changed';

    now.mock.mockImplementation(() => 1_001_500);
    await hear(device, 'fan.speed.1');
    assert.equal(device.capabilityValues.lucci_speed, 'changed', 'the same absolute press inside 2s is one press');

    now.mock.mockImplementation(() => 1_003_000);
    await hear(device, 'fan.speed.1');
    assert.equal(device.capabilityValues.lucci_speed, '1');
});

test('another remote\'s presses are not ours', async () => {
    const device = await fan({ capabilities: { onoff: false, lucci_speed: '1' } });
    await hear(device, 'fan.speed.5', { address: OTHER });
    await hear(device, 'fan.off', { address: OTHER });

    assert.equal(device.capabilityValues.lucci_speed, '1');
    assert.equal(device.capabilityValues.onoff, false);
});

test('only the first reception of a burst is acted on', async () => {
    const device = await fan();
    await hear(device, 'fan.speed.3', { isFirst: false });
    assert.equal(device.capabilityValues.lucci_speed, '2');
});

test('the light button is heard but belongs to the light', async () => {
    const device = await fan();
    await hear(device, 'light.toggle');
    await hear(device, 'light.toggle');

    assert.equal(device.logs.filter(l => l.includes('the light is a separate device')).length, 1, 'said once');
});

test('a tail that differs from the stored one is said once, and the press still counts', async () => {
    const device = await fan({ capabilities: { lucci_speed: '1' } });
    await hear(device, 'fan.speed.3', { tail: [0, 0] });

    assert.equal(device.capabilityValues.lucci_speed, '3');
    await hear(device, 'fan.speed.4', { tail: [0, 0] });
    assert.equal(device.logs.filter(l => l.includes('arrived with tail 00')).length, 1);
});

test('the press queue is spaced for this remote\'s 323ms press, not the USB-C remote\'s 423', async () => {
    const device = new Cr2032FanDevice();
    device.storeValues = { address: ADDRESS, tail: TAIL };
    const waits = [];
    let at = 0;
    // A virtual clock: nothing real is waited for, and the spacing is exact.
    const realNow = Date.now;
    Date.now = () => at;
    device.wait = ms => { waits.push(ms); at += ms; return Promise.resolve(); };
    try {
        await device.onInit();
        await Promise.all([device.send('fan.off', 'a'), device.send('fan.off', 'b')]);
    } finally {
        Date.now = realNow;
    }
    assert.deepEqual(waits, [p.PRESS_AIRTIME + 150]);
});

// ---------------------------------------------------------------- the light --

test('a light with no address, or no tail, refuses to transmit', async () => {
    for (const store of [{ address: null }, { tail: null }]) {
        const device = await light({ store });
        assert.equal(device.unavailable, 'errors.not_paired');
        assert.equal(device.listeners.onoff, undefined);
    }
});

test('the first belief is what the user said at pairing, and a restart keeps what happened since', async () => {
    const told = await light({ store: { lit: true } });
    assert.equal(told.lit, true);
    assert.equal(told.capabilityValues.onoff, true);

    const restarted = await light({ store: { lit: true }, capabilities: { onoff: false } });
    assert.equal(restarted.lit, false, 'the capability wins after a restart');

    const unasked = await light();
    assert.equal(unasked.lit, false);
    assert.equal(unasked.sent.length, 0, 'onInit transmits nothing');
});

test('onoff transmits only when the belief has to change', async () => {
    const device = await light({ store: { lit: false } });

    await setOne(device, 'onoff', true);
    await setOne(device, 'onoff', true);
    assert.deepEqual(keysSent(device), ['light.toggle'], '"turn it on" twice turns it on once');

    await setOne(device, 'onoff', false);
    assert.deepEqual(keysSent(device), ['light.toggle', 'light.toggle']);
    assert.equal(device.lit, false);
});

test('the toggle button sends one toggle per press, whatever is believed', async () => {
    const device = await light({ store: { lit: false } });
    await setOne(device, 'lucci_toggle', true);
    await setOne(device, 'lucci_toggle', true);

    assert.deepEqual(keysSent(device), ['light.toggle', 'light.toggle']);
    assert.equal(device.lit, false);
    assert.equal(device.capabilityValues.onoff, false);
});

test('correcting the light flips the belief and transmits nothing', async () => {
    const device = await light({ store: { lit: false } });
    await setOne(device, 'lucci_resync', true);

    assert.equal(device.sent.length, 0);
    assert.equal(device.lit, true);
    assert.equal(device.capabilityValues.onoff, true);
});

test('the light\'s frame carries this remote\'s address and tail', async () => {
    const device = await light();
    await setOne(device, 'lucci_toggle', true);
    assert.deepEqual(device.sent, [p.buildFrame(ADDRESS, 'light.toggle', TAIL)]);
});

test('a toggle that never reached the air does not change the belief', async () => {
    const device = await light({ store: { lit: false } });
    device.rejectTx = true;

    await assert.rejects(device.listeners.onoff(true), /errors\.tx_failed/);
    assert.equal(device.lit, false);
    await assert.rejects(device.listeners.lucci_toggle(true), /errors\.tx_failed/);
    assert.equal(device.lit, false);
});

test('hearing the remote\'s light button flips the belief once per press', async (t) => {
    const device = await light({ store: { lit: false } });
    const now = t.mock.method(Date, 'now', () => 5_000_000);

    await hear(device, 'light.toggle');
    assert.equal(device.lit, true);
    now.mock.mockImplementation(() => 5_000_400);
    await hear(device, 'light.toggle');
    assert.equal(device.lit, true, 'two receptions of one press are one flip');
    assert.equal(device.capabilityValues.onoff, true);

    now.mock.mockImplementation(() => 5_002_000);
    await hear(device, 'light.toggle');
    assert.equal(device.lit, false);
    assert.equal(device.sent.length, 0, 'a heard press must not be transmitted back');
});

test('the light ignores the fan\'s buttons and other remotes', async () => {
    const device = await light({ store: { lit: false } });
    await hear(device, 'fan.speed.2');
    await hear(device, 'light.toggle', { address: OTHER });

    assert.equal(device.lit, false);
});

// -------------------------------------------------------------- flow triggers --

test('a speed from Homey or from the remote fires the speed trigger, once per change', async () => {
    const device = await fan({ capabilities: { lucci_speed: '1', onoff: true } });
    await request(device, { lucci_speed: '3' });
    await hear(device, 'fan.speed.5');
    await hear(device, 'fan.speed.5');

    assert.deepEqual(device.triggered, [
        { id: 'fan_speed_changed', value: '3' },
        { id: 'fan_speed_changed', value: '5' },
    ]);
});
