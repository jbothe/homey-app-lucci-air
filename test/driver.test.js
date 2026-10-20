'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { ADDRESS_LENGTH, buildFrame, identifyFrame } = require('../lib/lucci-protocol');

// Everything the driver asks of Homey. What this file is for is pairing — which
// frame an address is taken from, and what happens when the only frame on offer
// had a symbol reconstructed.
// One Homey, shared by the app and the drivers that run on it — which is the
// point of this file's harness: the receiver is the app's, and whether two
// drivers can share it is exactly what went wrong once.
function homeyStub() {
    const state = { rxEnabled: 0, payloadHandler: null, signalsMade: 0 };
    const homey = {
        // Homey's __ takes either a locale key or an object of translations, and
        // the driver manifest's name is the latter.
        __: key => (typeof key === 'string' ? key : key.en),
        rf: {
            getSignal433: () => {
                state.signalsMade += 1;
                return {
                    on: (event, handler) => { if (event === 'payload') state.payloadHandler = handler; },
                    enableRX: async () => { state.rxEnabled += 1; },
                    disableRX: async () => { state.rxEnabled -= 1; },
                };
            },
        },
    };
    return { homey, state };
}

// Both classes need the same two methods, and neither needs more.
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
        this.manifest = { name: { en: 'Ceiling fan' } };
    }
}

class FakeApp extends FakeBase {}

const STUB = path.join(__dirname, 'homey.driver.stub.js');
require.cache[STUB] = {
    id: STUB, filename: STUB, loaded: true, exports: { Driver: FakeDriver, App: FakeApp },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'homey' ? STUB : resolveFilename.call(this, request, ...rest);
};

const LucciFanDriver = require('../drivers/fan/driver');
const LucciLightDriver = require('../drivers/light/driver');
// The real app, because the receiver it owns is what these tests are about.
const LucciApp = require('../app');

const ADDRESS = '0101110011110011'.split('').map(Number);

// A pairing session, as the learn view drives one.
const session = () => ({ emitted: [], emit: async function (event, data) { this.emitted.push({ event, data }); } });

// An app with one driver on it, which is what most of these need.
async function driver(Kind = LucciFanDriver) {
    const { homey, state } = homeyStub();
    const app = new LucciApp(homey);
    await app.onInit();
    homey.app = app;

    const instance = new Kind(homey);
    await instance.onInit();
    // The driver's own log is what the assertions read, and the app's lines —
    // RX enabled, unrecognised frames — belong to the same run.
    instance.logs = app.logs;
    instance.state = state;
    instance.app = app;
    return instance;
}

// Puts a payload on air, as Homey's signal does.
const air = (fan, payload, isFirst = true) => fan.state.payloadHandler(payload, isFirst, 0.01);

// Lets the driver's promise chains run.
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('pairing takes the address off a full-length frame at once', async () => {
    const fan = await driver();
    const view = session();
    const learning = fan.learnAddress(view);
    await settle();

    air(fan, buildFrame(ADDRESS, 'fan.off', 0));

    assert.deepEqual((await learning).address, ADDRESS);
    assert.ok(fan.logs.some(line => line.includes('matched fan.off; address 0101110011110011')),
        fan.logs.join(' | '));
    assert.equal(fan.state.rxEnabled, 0, 'RX was left on');
});

test('any button pairs, including one belonging to the light', async () => {
    // Every frame carries the same address whichever selector it has, so there
    // is no reason to make the user hunt for a particular button.
    for (const key of ['fan.speed.3', 'fan.timer.8h', 'light.brighter']) {
        const fan = await driver();
        const learning = fan.learnAddress(session());
        await settle();

        air(fan, buildFrame(ADDRESS, key, 0));
        assert.deepEqual((await learning).address, ADDRESS, key);
    }
});

test('an incomplete frame waits, and loses to the full frame that follows', async () => {
    // The observed hardware: one press arrives as a 24-symbol frame with its
    // leading bit missing, then 70ms later as a full 25-symbol one. That leading
    // bit is address bit 0, and nothing recovers it — it was recoverable only
    // from bit 24 under a parity rule the radio disproved. Pairing is the one
    // caller with nothing stored to check against, so it waits for the full one.
    const fan = await driver();
    const learning = fan.learnAddress(session());
    await settle();

    const whole = buildFrame(ADDRESS, 'fan.off', 0);
    air(fan, whole.slice(1));
    await settle();

    assert.ok(fan.logs.some(line => line.includes('on an incomplete frame')), fan.logs.join(' | '));

    air(fan, whole);
    assert.deepEqual((await learning).address, ADDRESS);
});

test('the full frame is taken even as a later frame of the same burst', async () => {
    // It arrives that way on the observed hardware, so the preference must not
    // be gated on Homey's isFirst.
    const fan = await driver();
    const learning = fan.learnAddress(session());
    await settle();

    const whole = buildFrame(ADDRESS, 'fan.speed.1', 0);
    air(fan, whole.slice(1), true);
    await settle();
    air(fan, whole, false);

    assert.deepEqual((await learning).address, ADDRESS);
});

test('an incomplete frame never pairs, and the timeout says why', async () => {
    // The deliberate choice, and the loud failure rather than the quiet one. A
    // receiver that only ever delivered 24 symbols is now unpairable — and says
    // so — where before it would have paired on a coin toss and produced a
    // device that is added, looks right and drives nothing.
    //
    // Both truncations, because they lose opposite ends and neither is enough:
    // one drops address bit 0, the other drops bit 24.
    const fan = await driver();
    fan.learnTimeout = 30;
    const learning = fan.learnAddress(session());
    await settle();

    air(fan, buildFrame(ADDRESS, 'fan.off', 0).slice(1));
    air(fan, buildFrame(ADDRESS, 'fan.off', 0).slice(0, 24));

    await assert.rejects(() => learning, /pair\.timeout_restored/);
    assert.ok(fan.logs.some(line => line.includes('on an incomplete frame')), fan.logs.join(' | '));
});

test('a timeout with nothing heard at all says that instead', async () => {
    const fan = await driver();
    fan.learnTimeout = 30;

    await assert.rejects(() => fan.learnAddress(session()), /pair\.timeout$/);
});

test('the press count on screen counts presses, not frames', async () => {
    const fan = await driver();
    const view = session();
    const learning = fan.learnAddress(view);
    await settle();

    const whole = buildFrame(ADDRESS, 'fan.off', 0);
    air(fan, whole.slice(1), true);
    await settle();
    air(fan, whole, false);
    await learning;

    // Two frames, one press: the second was Homey's own repeat of the first.
    assert.deepEqual(view.emitted.map(e => e.data.heard), [1]);
});

test('a view that cannot be updated does not cost the user the press', async () => {
    // onPayload catches what a listener throws, so an exception reaching it
    // drops the frame and pairing looks as though nothing was heard. A progress
    // counter is not worth that.
    const fan = await driver();
    const broken = { emit: () => { throw new Error('view is gone'); } };
    const learning = fan.learnAddress(broken);
    await settle();

    air(fan, buildFrame(ADDRESS, 'fan.off', 0));

    assert.deepEqual((await learning).address, ADDRESS);
    assert.ok(fan.logs.some(line => line.includes('could not update the view')), fan.logs.join(' | '));
});

test('unrelated 433 MHz traffic neither pairs nor goes unmentioned', async () => {
    const fan = await driver();
    const learning = fan.learnAddress(session());
    await settle();

    // A selector of 11, which was never seen and is not ours.
    const head = [...ADDRESS, 1, 1, 0, 0, 0, 1, 0, 0];
    air(fan, [...head, 0]);
    await settle();

    assert.equal(identifyFrame([...head, 0]), null);
    // Logged rather than dropped silently: that one line is what separates
    // "no frames arriving" from "frames arriving and not decoding".
    assert.ok(fan.logs.some(line => line.includes('rx unrecognised')), fan.logs.join(' | '));

    // And pairing is still listening.
    air(fan, buildFrame(ADDRESS, 'fan.off', 0));
    assert.deepEqual((await learning).address, ADDRESS);
});

test('RX is reference counted, so pairing twice does not strand it', async () => {
    const fan = await driver();

    const first = fan.learnAddress(session());
    await settle();
    air(fan, buildFrame(ADDRESS, 'fan.off', 0));
    await first;
    assert.equal(fan.state.rxEnabled, 0);

    const second = fan.learnAddress(session());
    await settle();
    assert.equal(fan.state.rxEnabled, 1, 'RX did not come back for a second attempt');
    air(fan, buildFrame(ADDRESS, 'fan.speed.0', 0));
    await second;
    assert.equal(fan.state.rxEnabled, 0);
});

test('a device offered for pairing is named and keyed by its address', async () => {
    const fan = await driver();
    const handlers = {};
    const view = session();
    view.setHandler = (event, handler) => { handlers[event] = handler; };
    await fan.onPair(view);

    // Before anything is learned, saying so beats an empty list, which reads as
    // "you have no fans".
    await assert.rejects(() => handlers.list_devices(), /pair\.not_learned/);

    const learning = handlers.learn();
    await settle();
    air(fan, buildFrame(ADDRESS, 'fan.off', 0));
    await learning;

    const [device] = await handlers.list_devices();
    assert.equal(device.data.id, `lucci-fan-${ADDRESS.join('')}`);
    assert.deepEqual(device.store.address, ADDRESS);
    assert.equal(device.store.address.length, ADDRESS_LENGTH);
    // And what the handset put in bit 24, which is not computable from the rest.
    assert.equal(device.store.bit24, 0);
});

test('pairing learns bit 24 from the handset rather than deriving it', async () => {
    // The whole point: a handset that sends 1 there is paired as sending 1, and
    // one that sends 0 as sending 0. Even parity would have said 0 for both,
    // because both frames below hold an even number of ones across bits 0-23.
    for (const bit of [0, 1]) {
        const fan = await driver();
        const learning = fan.learnAddress(session());
        await settle();

        const whole = buildFrame(ADDRESS, 'fan.off', 0);
        air(fan, [...whole.slice(0, 24), bit]);

        const learned = await learning;
        assert.deepEqual(learned.address, ADDRESS, `bit ${bit}`);
        assert.equal(learned.bit24, bit, `bit 24 was not taken from the air`);
        assert.ok(fan.logs.some(line => line.includes(`bit 24 ${bit}`)), fan.logs.join(' | '));
    }
});

test('a frame that never carried bit 24 cannot pair either', async () => {
    // The trailing truncation leaves a sound address and no bit 24. That used to
    // be pairable, because a missing bit fell back to even parity; with the bit
    // required there is nothing to fall back on, so it is not.
    const fan = await driver();
    fan.learnTimeout = 30;
    const learning = fan.learnAddress(session());
    await settle();

    air(fan, buildFrame(ADDRESS, 'fan.off', 1).slice(0, 24));

    await assert.rejects(() => learning, /pair\.timeout_restored/);
});

test('the two drivers share one receiver, counted once', async () => {
    // **The bug this file exists to prevent recurring.** enableRX and disableRX
    // act on the signal, not on the caller, so a count per driver is no count at
    // all: pairing a light used to finish by calling disableRX and leave the fan
    // — still registered, its own driver's count untouched — deaf.
    const { homey, state } = homeyStub();
    const app = new LucciApp(homey);
    await app.onInit();
    homey.app = app;

    const fan = new LucciFanDriver(homey);
    const light = new LucciLightDriver(homey);
    await fan.onInit();
    await light.onInit();

    // One signal and one payload subscription, however many drivers run on it.
    assert.equal(state.signalsMade, 1, 'each driver took its own signal');
    assert.equal(state.rxEnabled, 0);

    const onFan = () => {};
    const onLight = () => {};

    await fan.registerRXListener(onFan);
    assert.equal(state.rxEnabled, 1);

    // A second listener, through the other driver, must not switch it on twice.
    await light.registerRXListener(onLight);
    assert.equal(state.rxEnabled, 1);

    // And the light letting go must not take the fan's receiver with it.
    await light.unregisterRXListener(onLight);
    assert.equal(state.rxEnabled, 1, 'the fan went deaf when the light finished');

    await fan.unregisterRXListener(onFan);
    assert.equal(state.rxEnabled, 0, 'nobody is listening and RX is still on');
});

test('a frame reaches listeners registered through either driver', async () => {
    const { homey, state } = homeyStub();
    const app = new LucciApp(homey);
    await app.onInit();
    homey.app = app;

    const fan = new LucciFanDriver(homey);
    const light = new LucciLightDriver(homey);
    await fan.onInit();
    await light.onInit();

    const heard = [];
    await fan.registerRXListener(frame => heard.push(`fan:${frame.key}`));
    await light.registerRXListener(frame => heard.push(`light:${frame.key}`));

    state.payloadHandler(buildFrame(ADDRESS, 'light.brighter', 0), true, 0.01);

    // Both, because the app identifies once and hands the frame to everyone —
    // which is also why the light's codes reach the fan device at all.
    assert.deepEqual(heard.sort(), ['fan:light.brighter', 'light:light.brighter']);
});

test('one listener throwing does not stop the others being told', async () => {
    const fan = await driver();
    const heard = [];

    await fan.registerRXListener(() => { throw new Error('listener is broken'); });
    await fan.registerRXListener(frame => heard.push(frame.key));

    air(fan, buildFrame(ADDRESS, 'fan.off', 0));

    assert.deepEqual(heard, ['fan.off']);
    assert.ok(fan.logs.some(line => line.includes('RX listener failed')), fan.logs.join(' | '));
});

test('the light driver asks whether the light is on, and stores the answer', async () => {
    // The question exists because the answer cannot be measured. It is asked
    // during pairing because that is the only moment someone is standing in
    // front of the light on purpose.
    for (const lit of [true, false]) {
        const light = await driver(LucciLightDriver);
        const handlers = {};
        const view = session();
        view.setHandler = (event, handler) => { handlers[event] = handler; };
        await light.onPair(view);

        const learning = handlers.learn();
        await settle();
        air(light, buildFrame(ADDRESS, 'light.onoff', 0));
        await learning;

        await handlers.state({ lit });

        const [device] = await handlers.list_devices();
        assert.equal(device.store.lit, lit, `answered ${lit}`);
        assert.equal(device.data.id, `lucci-light-${ADDRESS.join('')}`);
        assert.deepEqual(device.store.address, ADDRESS);
    }
});

test('a light paired without answering stores no answer rather than a guess', async () => {
    // The view offers no way past the question, so this should not happen — and
    // if it does, the device assumes off rather than inheriting a stale answer.
    const light = await driver(LucciLightDriver);
    const handlers = {};
    const view = session();
    view.setHandler = (event, handler) => { handlers[event] = handler; };
    await light.onPair(view);

    const learning = handlers.learn();
    await settle();
    air(light, buildFrame(ADDRESS, 'light.onoff', 0));
    await learning;

    const [device] = await handlers.list_devices();
    assert.equal(device.store.lit, null);
});

test('the fan is not asked, because nothing about it needs telling', async () => {
    // Its speed, direction and timer are absolute: a handset press says exactly
    // what state the fan moved to, so there is nothing a person could add.
    const fan = await driver();
    const handlers = {};
    const view = session();
    view.setHandler = (event, handler) => { handlers[event] = handler; };
    await fan.onPair(view);

    assert.deepEqual(Object.keys(handlers).sort(), ['learn', 'list_devices']);
});

// --- two fans, two handsets --------------------------------------------------

// A second handset. There are no channels in this protocol: the 16-bit address
// is the whole of a unit's identity, so a second fan is a second address.
const SECOND = '1001011000110101'.split('').map(Number);

test('two handsets pair as two devices, keyed apart by address', async () => {
    const fan = await driver();
    const handlers = {};
    const view = session();
    view.setHandler = (event, handler) => { handlers[event] = handler; };
    await fan.onPair(view);

    const learn = async (address, bit24) => {
        const learning = handlers.learn();
        await settle();
        air(fan, buildFrame(address, 'fan.off', bit24));
        await learning;
        return handlers.list_devices();
    };

    const [first] = await learn(ADDRESS, 0);
    const [second] = await learn(SECOND, 1);

    assert.notEqual(first.data.id, second.data.id, 'two fans collapsed into one device');
    assert.deepEqual(first.store, { address: ADDRESS, bit24: 0 });
    assert.deepEqual(second.store, { address: SECOND, bit24: 1 });
});

test('pairing says whether this handset is a new one or one already added', async () => {
    const fan = await driver();
    // Two already paired: one of them is the handset about to be presented.
    fan.getDevices = () => [
        {
            getName: () => 'Bedroom fan',
            getStoreValue: key => ({ address: ADDRESS, bit24: 0 })[key],
        },
    ];

    const handlers = {};
    const view = session();
    view.setHandler = (event, handler) => { handlers[event] = handler; };
    await fan.onPair(view);

    const learning = handlers.learn();
    await settle();
    air(fan, buildFrame(ADDRESS, 'fan.off', 0));
    await learning;
    await handlers.list_devices();

    assert.ok(fan.logs.some(line => line.includes('this is Bedroom fan, already paired')),
        fan.logs.join(' | '));
});

test('a second handset is reported as a separate device, not a collision', async () => {
    const fan = await driver();
    fan.getDevices = () => [
        {
            getName: () => 'Bedroom fan',
            getStoreValue: key => ({ address: ADDRESS, bit24: 0 })[key],
        },
    ];

    const handlers = {};
    const view = session();
    view.setHandler = (event, handler) => { handlers[event] = handler; };
    await fan.onPair(view);

    const learning = handlers.learn();
    await settle();
    air(fan, buildFrame(SECOND, 'fan.off', 1));
    await learning;
    await handlers.list_devices();

    assert.ok(fan.logs.some(line => line.includes('a different handset')), fan.logs.join(' | '));
});

test('two units sharing an address is reported as the finding it would be', async () => {
    // Not seen, and it would be a fact about the protocol rather than a bug:
    // the device id is built from the address alone, so two units telling
    // themselves apart by bit 24 would arrive as one device.
    const fan = await driver();
    fan.getDevices = () => [
        {
            getName: () => 'Bedroom fan',
            getStoreValue: key => ({ address: ADDRESS, bit24: 0 })[key],
        },
    ];

    const handlers = {};
    const view = session();
    view.setHandler = (event, handler) => { handlers[event] = handler; };
    await fan.onPair(view);

    const learning = handlers.learn();
    await settle();
    air(fan, buildFrame(ADDRESS, 'fan.off', 1));
    await learning;
    await handlers.list_devices();

    assert.ok(fan.logs.some(line => line.includes('two units are sharing an address')),
        fan.logs.join(' | '));
});

test('a second device of a kind is numbered, so the list can be told apart', async () => {
    // Two fans would otherwise both arrive called "Ceiling fan" and picking the
    // right one would be guesswork. The user renames it anyway; this only has
    // to be distinguishable at the moment of adding.
    const fan = await driver();
    const handlers = {};
    const view = session();
    view.setHandler = (event, handler) => { handlers[event] = handler; };
    await fan.onPair(view);

    const offer = async address => {
        const learning = handlers.learn();
        await settle();
        air(fan, buildFrame(address, 'fan.off', 0));
        await learning;
        const [device] = await handlers.list_devices();
        return device.name;
    };

    assert.equal(await offer(ADDRESS), 'Ceiling fan');

    fan.getDevices = () => [{ getName: () => 'Ceiling fan', getStoreValue: () => null }];
    assert.equal(await offer(SECOND), 'Ceiling fan 2');
});
