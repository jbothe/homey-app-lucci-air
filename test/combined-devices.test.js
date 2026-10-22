'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const usbc = require('../lib/lucci-protocol');
const coin = require('../lib/cr2032-protocol');

// The two "ceiling fan + light" devices are the handset as it is: the fan's
// controls, plus the light's buttons and nothing else. What matters here is that
// the buttons send exactly the handset's codes, that the fan beside them is
// unchanged, and that the light claims no state - the fan devices own the rest
// of their behaviour and are tested in device.test.js and cr2032-devices.test.js.
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
                getSignal433: () => ({
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

const STUB = path.join(__dirname, 'homey.combined.stub.js');
require.cache[STUB] = {
    id: STUB, filename: STUB, loaded: true, exports: { Device: FakeDevice },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'homey' ? STUB : resolveFilename.call(this, request, ...rest);
};

const UsbcFanLight = require('../drivers/fan-light/device');
const CoinFanLight = require('../drivers/fan-light-cr2032/device');

const USBC_ADDRESS = '0101110011110011'.split('').map(Number);
const COIN_ADDRESS = '1100010100101110'.split('').map(Number);
const TAIL = [1, 0];

const tick = () => new Promise(resolve => setTimeout(resolve, 2));

async function make(Kind, store) {
    const device = new Kind();
    device.storeValues = store;
    // Presses are spaced by the queue; test/press-queue.test.js owns that.
    device.wait = () => Promise.resolve();
    await device.onInit();
    return device;
}

const usbcDevice = () => make(UsbcFanLight, { address: USBC_ADDRESS, bit24: 1 });
const coinDevice = () => make(CoinFanLight, { address: COIN_ADDRESS, tail: TAIL });

const usbcKeys = device => device.sent.map(payload => usbc.identifyFrame(payload).key);
const coinKeys = device => device.sent.map(payload => coin.identifyFrame(payload).key);

async function press(device, capability) {
    await device.listeners[capability](true, {});
    await tick();
}

async function request(device, values) {
    await device.multiListener.listener(values, {});
    for (const [capability, value] of Object.entries(values)) device.capabilityValues[capability] = value;
    await tick();
}

// ---------------------------------------------------------- USB-C remote ----

test('USB-C: the light has exactly the handset\'s three buttons, and no state', async () => {
    const device = await usbcDevice();

    assert.deepEqual(
        Object.keys(device.listeners).sort(),
        ['lucci_brighter', 'lucci_dimmer', 'lucci_direction', 'lucci_timer', 'lucci_toggle'],
    );
    // `onoff` and the speed share the coupled listener, and they are the fan's.
    assert.deepEqual(device.multiListener.ids, ['onoff', 'lucci_speed']);
    assert.equal(device.listeners.dim, undefined, 'no slider');
    assert.equal(device.listeners.lucci_resync, undefined, 'no belief to correct');
});

test('USB-C: each light button sends the handset\'s code with this fan\'s address and bit 24', async () => {
    const device = await usbcDevice();

    await press(device, 'lucci_toggle');
    await press(device, 'lucci_brighter');
    await press(device, 'lucci_dimmer');

    assert.deepEqual(usbcKeys(device), ['light.onoff', 'light.brighter', 'light.dimmer']);
    assert.deepEqual(device.sent[0], usbc.buildFrame(USBC_ADDRESS, 'light.onoff', 1));
});

test('USB-C: presses are never collapsed, since brightness is one step a press', async () => {
    const device = await usbcDevice();

    await press(device, 'lucci_dimmer');
    await press(device, 'lucci_dimmer');
    await press(device, 'lucci_dimmer');

    assert.deepEqual(usbcKeys(device), ['light.dimmer', 'light.dimmer', 'light.dimmer']);
});

test('USB-C: a light button changes nothing the fan shows', async () => {
    const device = await usbcDevice();
    await request(device, { lucci_speed: '4' });
    const before = { ...device.capabilityValues };

    await press(device, 'lucci_toggle');
    await press(device, 'lucci_brighter');

    assert.deepEqual(device.capabilityValues, before);
});

test('USB-C: the fan beside the light still works', async () => {
    const device = await usbcDevice();

    await request(device, { lucci_speed: '3' });
    await device.listeners.lucci_direction('reverse', {});
    await request(device, { onoff: false });

    assert.deepEqual(usbcKeys(device), ['fan.speed.3', 'fan.direction.reverse', 'fan.off']);
});

test('USB-C: a failed transmission tells the user, whichever button it was', async () => {
    const device = await usbcDevice();
    device.rejectTx = true;

    for (const capability of ['lucci_toggle', 'lucci_brighter', 'lucci_dimmer']) {
        await assert.rejects(device.listeners[capability](true, {}), /errors\.tx_failed/, capability);
    }
});

test('USB-C: the handset\'s light buttons are heard and ignored, without a word', async () => {
    const device = await usbcDevice();
    await request(device, { lucci_speed: '2' });
    const before = { ...device.capabilityValues };
    const [listener] = device.rxListeners;

    for (const key of ['light.onoff', 'light.brighter', 'light.dimmer']) {
        listener(usbc.identifyFrame(usbc.buildFrame(USBC_ADDRESS, key, 1)), true);
    }
    await tick();

    assert.deepEqual(device.capabilityValues, before);
    assert.equal(device.logs.filter(line => line.includes('separate device')).length, 0,
        'there is no separate light device to point at');
});

test('USB-C: the handset\'s fan buttons are still followed', async () => {
    const device = await usbcDevice();
    const [listener] = device.rxListeners;

    listener(usbc.identifyFrame(usbc.buildFrame(USBC_ADDRESS, 'fan.speed.5', 1)), true);
    await tick();

    assert.equal(device.capabilityValues.lucci_speed, '5');
    assert.equal(device.capabilityValues.onoff, true);
});

// ------------------------------------------------------ legacy (CR2032) ----

test('legacy: the light is the remote\'s one button, and no state', async () => {
    const device = await coinDevice();

    assert.deepEqual(Object.keys(device.listeners).sort(), ['lucci_reverse', 'lucci_toggle']);
    assert.deepEqual(device.multiListener.ids, ['onoff', 'lucci_speed']);
});

test('legacy: the toggle sends the remote\'s code with this remote\'s address and tail', async () => {
    const device = await coinDevice();

    await press(device, 'lucci_toggle');
    await press(device, 'lucci_toggle');

    assert.deepEqual(coinKeys(device), ['light.toggle', 'light.toggle'], 'every press goes out');
    assert.deepEqual(device.sent[0], coin.buildFrame(COIN_ADDRESS, 'light.toggle', TAIL));
});

test('legacy: the fan beside the light still works', async () => {
    const device = await coinDevice();

    await request(device, { lucci_speed: '5' });
    await press(device, 'lucci_reverse');
    await request(device, { onoff: false });

    assert.deepEqual(coinKeys(device), ['fan.speed.5', 'fan.reverse', 'fan.off']);
});

test('legacy: the toggle changes nothing the fan shows, and a failure tells the user', async () => {
    const device = await coinDevice();
    await request(device, { lucci_speed: '1' });
    const before = { ...device.capabilityValues };

    await press(device, 'lucci_toggle');
    assert.deepEqual(device.capabilityValues, before);

    device.rejectTx = true;
    await assert.rejects(device.listeners.lucci_toggle(true, {}), /errors\.tx_failed/);
});

test('legacy: the remote\'s light button is heard and ignored, without a word', async () => {
    const device = await coinDevice();
    const [listener] = device.rxListeners;

    listener(coin.identifyFrame(coin.buildFrame(COIN_ADDRESS, 'light.toggle', TAIL)), true);
    await tick();

    assert.equal(device.capabilityValues.onoff ?? null, null);
    assert.equal(device.logs.filter(line => line.includes('separate device')).length, 0);
});

test('an unpaired combined device refuses to transmit', async () => {
    for (const [Kind, store] of [[UsbcFanLight, {}], [CoinFanLight, {}]]) {
        const device = await make(Kind, store);
        assert.equal(device.unavailable, 'errors.not_paired');
        assert.deepEqual(device.listeners, {}, 'nothing is wired up to send with');
    }
});
