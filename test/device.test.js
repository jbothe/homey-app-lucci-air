'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { ADDRESS_LENGTH, identifyFrame } = require('../lib/lucci-protocol');

// Everything the device asks of Homey, and nothing else. What this file is for
// is which frame goes out for which request, and which capability values are
// written back — neither of which needs a radio.
class FakeDevice {
    constructor() {
        this.storeValues = {};
        this.capabilityValues = {};
        this.multiListener = null;
        this.sent = [];
        this.logs = [];
        this.rejectSetOf = null;

        this.homey = {
            // Wrapped rather than passed by reference, so a test's mocked timers
            // are picked up at the moment they are called.
            setTimeout: (...args) => setTimeout(...args),
            clearTimeout: (...args) => clearTimeout(...args),
            __: key => key,
            rf: {
                getSignal433: () => ({
                    tx: async payload => { this.sent.push(payload); },
                }),
            },
        };
    }

    getStoreValue(key) { return this.storeValues[key] ?? null; }
    getCapabilityValue(key) { return this.capabilityValues[key] ?? null; }

    async setCapabilityValue(key, value) {
        // Homey rejects a write it will not accept; the point of `set` is that
        // such a rejection reaches the log instead of vanishing.
        if (this.rejectSetOf === key) throw new Error(`refused to set ${key}`);
        this.capabilityValues[key] = value;
    }

    registerMultipleCapabilityListener(ids, listener, timeout) {
        this.multiListener = { ids, listener, timeout };
    }

    async setUnavailable(reason) { this.unavailable = reason; }
    log(...args) { this.logs.push(args.join(' ')); }
    error(...args) { this.logs.push(`ERROR ${args.join(' ')}`); }
}

// device.js requires `homey`, which only exists on a Homey. Standing a module in
// for it has to happen before the require below, and by filename, because that
// is the only name the loader looks itself up by.
const STUB = path.join(__dirname, 'homey.stub.js');
require.cache[STUB] = {
    id: STUB, filename: STUB, loaded: true, exports: { Device: FakeDevice },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'homey' ? STUB : resolveFilename.call(this, request, ...rest);
};

const LucciFanDevice = require('../drivers/fan/device');

const ADDRESS = '0101110011110011'.split('').map(Number);

async function device({ speed, onoff } = {}) {
    const fan = new LucciFanDevice();
    fan.storeValues.address = ADDRESS;
    if (speed !== undefined) fan.capabilityValues.lucci_speed = speed;
    if (onoff !== undefined) fan.capabilityValues.onoff = onoff;
    await fan.onInit();
    return fan;
}

// One request, the way Homey makes it: the listener runs, then Homey writes the
// capabilities that were asked for. Anything the device wants to write itself is
// deferred past both, so the timers are flushed last.
async function request(fan, values) {
    await fan.multiListener.listener(values, {});
    for (const [capability, value] of Object.entries(values)) {
        fan.capabilityValues[capability] = value;
    }
    await new Promise(resolve => setTimeout(resolve, 1));
}

const keysSent = fan => fan.sent.map(payload => identifyFrame(payload).key);

test('a device with no stored address refuses to transmit', async () => {
    const fan = new LucciFanDevice();
    await fan.onInit();

    assert.equal(fan.unavailable, 'errors.not_paired');
    assert.equal(fan.multiListener, null, 'no listener, so nothing can be sent');
});

test('an address of the wrong length is no address at all', async () => {
    const fan = new LucciFanDevice();
    fan.storeValues.address = ADDRESS.slice(1);
    await fan.onInit();

    assert.equal(fan.unavailable, 'errors.not_paired');
});

test('onInit says whether it resumed a step or fell back to the default', async () => {
    const resumed = await device({ speed: '4' });
    assert.ok(resumed.logs.some(line => line === 'speed: resumed step 4'), resumed.logs.join(' | '));
    assert.equal(resumed.capabilityValues.lucci_speed, '4');

    // The distinction the log could not make before: `onoff` true sends this
    // step, so "resumed what you chose" and "fell back" look identical on air.
    const fresh = await device();
    assert.ok(fresh.logs.some(line => line.startsWith('speed: none stored')), fresh.logs.join(' | '));
    assert.equal(fresh.capabilityValues.lucci_speed, '2');
});

test('both capabilities share one debounced listener', async () => {
    const fan = await device({ speed: '2' });

    // Coupled because every frame this driver sends is one absolute speed code
    // or the off code — never a power code and a speed.
    assert.deepEqual(fan.multiListener.ids, ['onoff', 'lucci_speed']);
    assert.equal(fan.multiListener.timeout, 250);
});

test('off sends the off code and nothing else', async () => {
    const fan = await device({ speed: '3', onoff: true });
    await request(fan, { onoff: false });

    assert.deepEqual(keysSent(fan), ['fan.off']);
    // The step is kept for whenever the fan is next turned on.
    assert.equal(fan.capabilityValues.lucci_speed, '3');
});

test('on sends the stored step, and says so', async () => {
    const fan = await device({ speed: '5', onoff: false });
    await request(fan, { onoff: true });

    assert.deepEqual(keysSent(fan), ['fan.speed.5']);
    assert.ok(fan.logs.some(line => line.includes('onoff true, stored step 5')), fan.logs.join(' | '));
});

test('a speed starts the fan, and the tile follows', async () => {
    // The bug this is here for: the picker transmitted and moved the fan while
    // the tile stayed off, until an `onoff` toggle — which did nothing, the fan
    // already running — put it right.
    const fan = await device({ speed: '2', onoff: false });
    await request(fan, { lucci_speed: '4' });

    assert.deepEqual(keysSent(fan), ['fan.speed.4']);
    assert.equal(fan.capabilityValues.onoff, true, 'onoff did not follow the speed');
    assert.ok(fan.logs.some(line => line === 'onoff -> true'), fan.logs.join(' | '));
});

test('off leads when one request carries both', async () => {
    // Homey's guidance for coupled capabilities. A flow asking for off and a
    // speed at once means off, and one frame goes out rather than two.
    const fan = await device({ speed: '1', onoff: true });
    await request(fan, { onoff: false, lucci_speed: '5' });

    assert.deepEqual(keysSent(fan), ['fan.off']);
    assert.equal(fan.capabilityValues.lucci_speed, '5', 'the step is still remembered');
});

test('on with a speed in the same request sends that speed once', async () => {
    const fan = await device({ speed: '1', onoff: false });
    await request(fan, { onoff: true, lucci_speed: '3' });

    assert.deepEqual(keysSent(fan), ['fan.speed.3']);
});

test('a speed nobody stored falls through to the default', async () => {
    const fan = await device();
    fan.capabilityValues.lucci_speed = null;
    await request(fan, { onoff: true });

    assert.deepEqual(keysSent(fan), ['fan.speed.2']);
    assert.equal(fan.capabilityValues.lucci_speed, '2', 'the tile shows the step the fan is on');
});

test('nothing is written back for a capability the request already carried', async () => {
    // Homey writes those itself once the listener resolves. Writing them again
    // is what the deferral is for, and doing it twice would be a second source
    // of truth for the same value.
    const fan = await device({ speed: '2', onoff: true });
    await request(fan, { lucci_speed: '5' });

    assert.equal(fan.logs.filter(line => line.startsWith('lucci_speed ->')).length, 0);
    assert.equal(fan.capabilityValues.lucci_speed, '5');
});

test('a refused write is logged rather than swallowed', async () => {
    // `.catch(this.error)` was the original, and it is worse than no handler:
    // `error` is a prototype method, so an unbound reference throws a second
    // time inside the handler and the first error never reaches the log. That is
    // how the onoff bug stayed invisible.
    const fan = await device({ speed: '2', onoff: false });
    fan.rejectSetOf = 'onoff';
    await request(fan, { lucci_speed: '4' });

    assert.deepEqual(keysSent(fan), ['fan.speed.4'], 'the frame still went out');
    assert.ok(fan.logs.some(line => line.startsWith('ERROR could not set onoff')), fan.logs.join(' | '));
});

test('every frame carries this fan\'s address', async () => {
    const fan = await device({ speed: '2', onoff: false });
    await request(fan, { lucci_speed: '0' });
    await request(fan, { onoff: false });

    assert.equal(fan.sent.length, 2);
    for (const payload of fan.sent) {
        assert.deepEqual(identifyFrame(payload).address, ADDRESS);
    }
});
