'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const cr2032 = require('../lib/cr2032-protocol');
const lucci = require('../lib/lucci-protocol');

// One Homey, shared by the app and the drivers on it, with a signal per id -
// which is the point of this file: two remotes, two signals, and a receiver
// that must not let one remote's devices switch off the other's.
function homeyStub() {
    const signals = new Map();
    const homey = {
        __: key => (typeof key === 'string' ? key : key.en),
        rf: {
            getSignal433: id => {
                if (!signals.has(id)) {
                    const state = { id, rx: 0, handler: null };
                    signals.set(id, {
                        state,
                        on: (event, handler) => { if (event === 'payload') state.handler = handler; },
                        enableRX: async () => { state.rx += 1; },
                        disableRX: async () => { state.rx -= 1; },
                    });
                }
                return signals.get(id);
            },
        },
    };
    return { homey, signals };
}

class FakeBase {
    constructor(homey) {
        this.homey = homey;
        this.logs = [];
    }

    log(...args) { this.logs.push(args.join(' ')); }
    error(...args) { this.logs.push(`ERROR ${args.join(' ')}`); }
}

class FakeDriver extends FakeBase {
    constructor(homey) {
        super(homey);
        this.manifest = { name: { en: 'Ceiling fan (legacy)' } };
        this.devices = [];
    }

    getDevices() { return this.devices; }
}

class FakeApp extends FakeBase {}

const STUB = path.join(__dirname, 'homey.cr2032.driver.stub.js');
require.cache[STUB] = {
    id: STUB, filename: STUB, loaded: true, exports: { Driver: FakeDriver, App: FakeApp },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'homey' ? STUB : resolveFilename.call(this, request, ...rest);
};

const Cr2032FanDriver = require('../drivers/fan-cr2032/driver');
const Cr2032LightDriver = require('../drivers/light-cr2032/driver');
const LucciAirApp = require('../app');

const ADDRESS = '1100010100101110'.split('').map(Number);
const TAIL = [1, 0];

const session = () => ({
    emitted: [],
    handlers: {},
    emit: async function (event, data) { this.emitted.push({ event, data }); },
    setHandler: function (name, fn) { this.handlers[name] = fn; },
});

async function setup(Kind = Cr2032FanDriver) {
    const { homey, signals } = homeyStub();
    const app = new LucciAirApp(homey);
    await app.onInit();
    homey.app = app;

    const driver = new Kind(homey);
    await driver.onInit();
    driver.logs = app.logs;
    return { driver, app, homey, signals };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

// Puts a payload on air, as Homey's signal does.
const air = (signals, payload, isFirst = true, id = cr2032.SIGNAL_ID) => signals.get(id).state.handler(payload, isFirst, 0.01);

test('pairing takes the address and the tail off a full-length frame', async () => {
    const { driver, signals } = await setup();
    const learning = driver.learnAddress(session());
    await settle();

    air(signals, cr2032.buildFrame(ADDRESS, 'fan.off', TAIL));

    assert.deepEqual(await learning, { address: ADDRESS, tail: TAIL });
    assert.ok(driver.logs.some(l => l.includes('matched fan.off; address 1100010100101110, tail 10')), driver.logs.join(' | '));
    assert.equal(signals.get(cr2032.SIGNAL_ID).state.rx, 0, 'RX was left on');
});

test('any button pairs, the light\'s as well as the fan\'s', async () => {
    const { driver, signals } = await setup();
    const learning = driver.learnAddress(session());
    await settle();

    air(signals, cr2032.buildFrame(ADDRESS, 'light.toggle', TAIL));
    assert.deepEqual((await learning).address, ADDRESS);
});

test('the view is told what was heard', async () => {
    const { driver, signals } = await setup();
    const view = session();
    const learning = driver.learnAddress(view);
    await settle();

    air(signals, cr2032.buildFrame(ADDRESS, 'fan.speed.2', TAIL));
    await learning;

    assert.deepEqual(view.emitted, [{ event: 'rx', data: { heard: 1, command: 'fan.speed.2' } }]);
});

test('a short frame is not a pairing, and the failure says so', async () => {
    const { driver, signals } = await setup();
    driver.learnTimeout = 30;
    const learning = driver.learnAddress(session());
    await settle();

    // The start of a burst, one symbol short: neither end can be trusted.
    air(signals, cr2032.buildFrame(ADDRESS, 'fan.off', TAIL).slice(1));

    await assert.rejects(learning, /pair\.timeout/);
    assert.equal(signals.get(cr2032.SIGNAL_ID).state.rx, 0, 'RX was left on');
    assert.ok(driver.logs.some(l => l.includes('rx unrecognised (lucci_cr2032): 23 symbols, one short of 24')), driver.logs.join(' | '));
});

test('traffic that is not ours does not pair', async () => {
    const { driver, signals } = await setup();
    driver.learnTimeout = 30;
    const learning = driver.learnAddress(session());
    await settle();

    air(signals, [...ADDRESS, 0, 0, 0, 0, 0, 0, ...TAIL]);
    air(signals, Array.from({ length: 24 }, () => 1));

    await assert.rejects(learning, /pair\.timeout/);
});

test('the USB-C remote\'s frames never reach a CR2032 device, or the other way round', async () => {
    const { driver, app, signals } = await setup();
    const heard = [];
    await driver.registerRXListener(frame => heard.push(`cr2032:${frame.key}`));
    await app.registerRXListener(frame => heard.push(`lucci:${frame.key}`));

    air(signals, cr2032.buildFrame(ADDRESS, 'fan.off', TAIL));
    air(signals, lucci.buildFrame(ADDRESS, 'fan.off', 0), true, lucci.SIGNAL_ID);

    assert.deepEqual(heard, ['cr2032:fan.off', 'lucci:fan.off']);

    // Each signal was handed only its own protocol's frame, and only that
    // protocol's decoder was asked about it.
    air(signals, lucci.buildFrame(ADDRESS, 'fan.off', 0), true, cr2032.SIGNAL_ID);
    assert.deepEqual(heard, ['cr2032:fan.off', 'lucci:fan.off'], 'a 25-bit frame is not a CR2032 frame');
});

test('each signal\'s receiver is counted on its own', async () => {
    const { driver, app, signals } = await setup();
    const usbc = () => signals.get(lucci.SIGNAL_ID).state.rx;
    const coin = () => signals.get(cr2032.SIGNAL_ID).state.rx;

    const a = () => {};
    const b = () => {};
    const c = () => {};

    await driver.registerRXListener(a);
    await driver.registerRXListener(b);
    assert.equal(coin(), 1, 'enabled once for two listeners');
    assert.equal(usbc(), 0, 'the other remote\'s receiver was not touched');

    await app.registerRXListener(c);
    assert.equal(usbc(), 1);

    // The shape of the bug this guards: the last device of one remote going away
    // must not switch off the other remote's receiver.
    await app.unregisterRXListener(c);
    assert.equal(usbc(), 0);
    assert.equal(coin(), 1, 'the CR2032 receiver went deaf');

    await driver.unregisterRXListener(a);
    assert.equal(coin(), 1, 'one listener still wants it');
    await driver.unregisterRXListener(b);
    assert.equal(coin(), 0);
});

test('the CR2032 signal is only created when a CR2032 device asks for it', async () => {
    const { signals } = await setup();
    assert.deepEqual([...signals.keys()], [lucci.SIGNAL_ID], 'an install with only the original fans never touches the second signal');
});

test('a device is offered with the address and tail, and an id built from the address', async () => {
    const { driver } = await setup();
    const [offered] = driver.devicesFor({ address: ADDRESS, tail: TAIL });

    assert.equal(offered.name, 'Ceiling fan (legacy)');
    assert.equal(offered.data.id, 'lucci-cr2032-fan-1100010100101110');
    assert.deepEqual(offered.store, { address: ADDRESS, tail: TAIL });
});

test('the fan and the light of one remote are different devices', async () => {
    const fan = (await setup(Cr2032FanDriver)).driver.devicesFor({ address: ADDRESS, tail: TAIL })[0];
    const light = (await setup(Cr2032LightDriver)).driver.devicesFor({ address: ADDRESS, tail: TAIL })[0];

    assert.notEqual(fan.data.id, light.data.id);
});

test('a second fan is numbered, so it can be told from the first', async () => {
    const { driver } = await setup();
    driver.devices = [{ getName: () => 'Ceiling fan (legacy)', getStoreValue: () => null }];

    assert.equal(driver.devicesFor({ address: ADDRESS, tail: TAIL })[0].name, 'Ceiling fan (legacy) 2');
});

test('the light asks whether it is on, and keeps the answer with the device', async () => {
    const { driver, signals } = await setup(Cr2032LightDriver);
    const view = session();
    await driver.onPair(view);

    await view.handlers.state({ lit: true });
    const learning = view.handlers.learn();
    await settle();
    air(signals, cr2032.buildFrame(ADDRESS, 'light.toggle', TAIL));
    await learning;

    const [offered] = await view.handlers.list_devices();
    assert.equal(offered.store.lit, true);
    assert.deepEqual(offered.store.address, ADDRESS);
});

test('listing devices before anything is learned says so rather than offering nothing', async () => {
    const { driver } = await setup();
    const view = session();
    await driver.onPair(view);

    await assert.rejects(view.handlers.list_devices(), /pair\.not_learned/);
});

test('pairing reports whether the remote is new, known, or sharing an address', async () => {
    const { driver } = await setup();
    const paired = (address, tail) => ({
        getName: () => 'Fan A',
        getStoreValue: key => ({ address, tail })[key],
    });

    driver.reportLearned({ address: ADDRESS, tail: TAIL });
    assert.ok(driver.logs.some(l => l.includes('the first of this kind')));

    driver.devices = [paired(ADDRESS.map(b => 1 - b), TAIL)];
    driver.reportLearned({ address: ADDRESS, tail: TAIL });
    assert.ok(driver.logs.some(l => l.includes('a different remote')));

    driver.devices = [paired(ADDRESS, TAIL)];
    driver.reportLearned({ address: ADDRESS, tail: TAIL });
    assert.ok(driver.logs.some(l => l.includes('already paired')));

    // The finding that would matter: one address, two tails.
    driver.devices = [paired(ADDRESS, [0, 0])];
    driver.reportLearned({ address: ADDRESS, tail: TAIL });
    assert.ok(driver.logs.some(l => l.startsWith('ERROR [pair] same address as Fan A but tail 10')), driver.logs.join(' | '));
});
