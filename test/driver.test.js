'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { ADDRESS_LENGTH, buildFrame, identifyFrame } = require('../lib/lucci-protocol');

// Everything the driver asks of Homey. What this file is for is pairing — which
// frame an address is taken from, and what happens when the only frame on offer
// had a symbol reconstructed.
class FakeDriver {
    constructor() {
        this.logs = [];
        this.payloadHandler = null;
        this.rxEnabled = 0;
        this.manifest = { name: { en: 'Ceiling fan' } };

        this.homey = {
            __: key => key,
            rf: {
                getSignal433: () => ({
                    on: (event, handler) => { if (event === 'payload') this.payloadHandler = handler; },
                    enableRX: async () => { this.rxEnabled += 1; },
                    disableRX: async () => { this.rxEnabled -= 1; },
                }),
            },
        };
    }

    log(...args) { this.logs.push(args.join(' ')); }
    error(...args) { this.logs.push(`ERROR ${args.join(' ')}`); }
}

const STUB = path.join(__dirname, 'homey.driver.stub.js');
require.cache[STUB] = {
    id: STUB, filename: STUB, loaded: true, exports: { Driver: FakeDriver },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'homey' ? STUB : resolveFilename.call(this, request, ...rest);
};

const LucciFanDriver = require('../drivers/fan/driver');

const ADDRESS = '0101110011110011'.split('').map(Number);

// A pairing session, as the learn view drives one.
const session = () => ({ emitted: [], emit: async function (event, data) { this.emitted.push({ event, data }); } });

async function driver() {
    const fan = new LucciFanDriver();
    await fan.onInit();
    return fan;
}

// Puts a payload on air, as Homey's signal does.
const air = (fan, payload, isFirst = true) => fan.payloadHandler(payload, isFirst, 0.01);

// Lets the driver's promise chains run.
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('pairing takes the address off a full-length frame at once', async () => {
    const fan = await driver();
    const view = session();
    const learning = fan.learnAddress(view);
    await settle();

    air(fan, buildFrame(ADDRESS, 'fan.off'));

    assert.deepEqual(await learning, ADDRESS);
    assert.ok(fan.logs.some(line => line.includes('matched fan.off; address:')), fan.logs.join(' | '));
    assert.equal(fan.rxEnabled, 0, 'RX was left on');
});

test('any button pairs, including one belonging to the light', async () => {
    // Every frame carries the same address whichever selector it has, so there
    // is no reason to make the user hunt for a particular button.
    for (const key of ['fan.speed.3', 'fan.timer.8h', 'light.brighter']) {
        const fan = await driver();
        const learning = fan.learnAddress(session());
        await settle();

        air(fan, buildFrame(ADDRESS, key));
        assert.deepEqual(await learning, ADDRESS, key);
    }
});

test('a reconstructed frame waits, and loses to the full frame that follows', async () => {
    // The observed hardware: one press arrives as a 24-symbol frame with its
    // leading bit missing, then 70ms later as a full 25-symbol one. That leading
    // bit is address bit 0, and it is a guess — bit 24 is not parity, so there
    // is nothing to recover it from. Pairing is the one caller with no stored
    // address to check against, so it waits for the full one.
    const fan = await driver();
    const learning = fan.learnAddress(session());
    await settle();

    const whole = buildFrame(ADDRESS, 'fan.off');
    air(fan, whole.slice(1));
    await settle();

    assert.ok(fan.logs.some(line => line.includes('missing its leading bit')), fan.logs.join(' | '));

    air(fan, whole);
    assert.deepEqual(await learning, ADDRESS);
});

test('the full frame is taken even as a later frame of the same burst', async () => {
    // It arrives that way on the observed hardware, so the preference must not
    // be gated on Homey's isFirst.
    const fan = await driver();
    const learning = fan.learnAddress(session());
    await settle();

    const whole = buildFrame(ADDRESS, 'fan.speed.1');
    air(fan, whole.slice(1), true);
    await settle();
    air(fan, whole, false);

    assert.deepEqual(await learning, ADDRESS);
});

test('a frame missing its leading bit never pairs, and the timeout says why', async () => {
    // The deliberate choice, and the loud failure rather than the quiet one. A
    // receiver that only ever delivered 24 symbols is now unpairable — and says
    // so — where before it would have paired on a coin toss and produced a
    // device that is added, looks right and never works.
    const fan = await driver();
    fan.learnTimeout = 30;
    const learning = fan.learnAddress(session());
    await settle();

    air(fan, buildFrame(ADDRESS, 'fan.off').slice(1));

    await assert.rejects(() => learning, /pair\.timeout_restored/);
    assert.ok(fan.logs.some(line => line.includes('missing its leading bit')), fan.logs.join(' | '));
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

    const whole = buildFrame(ADDRESS, 'fan.off');
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

    air(fan, buildFrame(ADDRESS, 'fan.off'));

    assert.deepEqual(await learning, ADDRESS);
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
    air(fan, buildFrame(ADDRESS, 'fan.off'));
    assert.deepEqual(await learning, ADDRESS);
});

test('RX is reference counted, so pairing twice does not strand it', async () => {
    const fan = await driver();

    const first = fan.learnAddress(session());
    await settle();
    air(fan, buildFrame(ADDRESS, 'fan.off'));
    await first;
    assert.equal(fan.rxEnabled, 0);

    const second = fan.learnAddress(session());
    await settle();
    assert.equal(fan.rxEnabled, 1, 'RX did not come back for a second attempt');
    air(fan, buildFrame(ADDRESS, 'fan.speed.0'));
    await second;
    assert.equal(fan.rxEnabled, 0);
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
    air(fan, buildFrame(ADDRESS, 'fan.off'));
    await learning;

    const [device] = await handlers.list_devices();
    assert.equal(device.data.id, `lucci-fan-${ADDRESS.join('')}`);
    assert.deepEqual(device.store.address, ADDRESS);
    assert.equal(device.store.address.length, ADDRESS_LENGTH);
});
