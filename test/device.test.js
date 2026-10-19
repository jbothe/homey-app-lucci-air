'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { ADDRESS_LENGTH, identifyFrame, buildFrame } = require('../lib/lucci-protocol');

// Everything the device asks of Homey, and nothing else. What this file is for
// is which frame goes out for which request, and which capability values are
// written back — neither of which needs a radio.
class FakeDevice {
    constructor() {
        this.storeValues = {};
        this.capabilityValues = {};
        this.multiListener = null;
        this.listeners = {};
        this.sent = [];
        this.logs = [];
        this.rejectSetOf = null;
        this.rxListeners = new Set();

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

        // The driver owns RX, reference counted, because Homey's enableRX is
        // per-signal rather than per-listener.
        this.driver = {
            registerRXListener: async listener => { this.rxListeners.add(listener); },
            unregisterRXListener: async listener => { this.rxListeners.delete(listener); },
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

    registerCapabilityListener(id, listener) { this.listeners[id] = listener; }

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

// A request for one capability, the way Homey makes it: the listener runs, then
// Homey writes the value that was asked for.
async function setOne(fan, capability, value) {
    await fan.listeners[capability](value, {});
    fan.capabilityValues[capability] = value;
    await new Promise(resolve => setTimeout(resolve, 1));
}

// A frame arriving off the air, as the driver hands it to every device.
async function receive(fan, payload, isFirst = true) {
    for (const listener of fan.rxListeners) listener(identifyFrame(payload), isFirst);
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

test('onInit reports the stored step without claiming to have set it', async () => {
    const resumed = await device({ speed: '4' });
    assert.equal(resumed.capabilityValues.lucci_speed, '4');
    assert.equal(resumed.sent.length, 0, 'onInit must not transmit');

    // The distinction the log could not make before: `onoff` true sends this
    // step, so "the step you chose" and "the default" look identical on air.
    const line = resumed.logs.find(l => l.startsWith('speed:'));
    assert.match(line, /step 4 stored/);
    // And it must not read as though the fan were set to that step — "resumed
    // step 1" was the first wording and it did read that way.
    assert.doesNotMatch(line, /resumed/);
    assert.match(line, /nothing sent/);

    const fresh = await device();
    assert.match(fresh.logs.find(l => l.startsWith('speed:')), /none stored/);
    assert.equal(fresh.capabilityValues.lucci_speed, '2');
    assert.equal(fresh.sent.length, 0, 'onInit must not transmit');
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

// --- direction and the timer -------------------------------------------------

test('direction and the timer get a listener each, not the coupled one', async () => {
    const fan = await device({ speed: '2' });

    // Absolute like the speed, but nothing else's business: one capability, one
    // code, and no second capability whose value has to be decided at the same
    // moment.
    assert.deepEqual(Object.keys(fan.listeners).sort(), ['lucci_direction', 'lucci_timer']);
    assert.deepEqual(fan.multiListener.ids, ['onoff', 'lucci_speed']);
});

test('direction starts a stopped fan, and the tile follows', async () => {
    // Confirmed on the hardware: a direction code starts the fan, as a speed
    // code does. So it implies onoff true, and through reflect, this being the
    // pitfall that cost a round trip once already.
    const fan = await device({ speed: '2', onoff: false });
    await setOne(fan, 'lucci_direction', 'reverse');

    assert.deepEqual(keysSent(fan), ['fan.direction.reverse']);
    assert.equal(fan.capabilityValues.onoff, true);
    assert.ok(fan.logs.some(line => line === 'onoff -> true'), fan.logs.join(' | '));
});

test('the timer implies nothing, not having been tested stopped', async () => {
    // A direction code starting the fan is no evidence about a timer code.
    // Guessing wrong here shows the fan on while it is off, the mirror of the
    // bug that had the tile stuck off while it ran.
    const fan = await device({ speed: '2', onoff: false });
    await setOne(fan, 'lucci_timer', '8h');

    assert.deepEqual(keysSent(fan), ['fan.timer.8h']);
    assert.equal(fan.capabilityValues.onoff, false);

    // And it asks the question at the only moment it can be answered, rather
    // than waiting for someone to remember to run the experiment.
    assert.ok(fan.logs.some(line => line.includes('did the fan start?')), fan.logs.join(' | '));
});

test('the timer asks nothing when the fan was already running', async () => {
    const fan = await device({ speed: '2', onoff: true });
    await setOne(fan, 'lucci_timer', '2h');

    assert.ok(!fan.logs.some(line => line.includes('did the fan start?')));
});

test('a direction change while the fan runs leaves onoff alone', async () => {
    const fan = await device({ speed: '2', onoff: true });
    await setOne(fan, 'lucci_direction', 'forward');

    assert.deepEqual(keysSent(fan), ['fan.direction.forward']);
    assert.equal(fan.capabilityValues.onoff, true);
    // Nothing to write: reflect skips a capability that already holds the value.
    assert.equal(fan.logs.filter(line => line === 'onoff -> true').length, 0);
});

test('every direction and timer value has a code that builds', async () => {
    const fan = await device({ speed: '2' });
    for (const value of ['forward', 'reverse']) await setOne(fan, 'lucci_direction', value);
    for (const value of ['off', '2h', '4h', '8h']) await setOne(fan, 'lucci_timer', value);

    assert.deepEqual(keysSent(fan), [
        'fan.direction.forward', 'fan.direction.reverse',
        'fan.timer.off', 'fan.timer.2h', 'fan.timer.4h', 'fan.timer.8h',
    ]);
});

// --- following the handset ---------------------------------------------------

const heard = (fan, key) => receive(fan, buildFrame(ADDRESS, key));

test('the device listens for the handset, and stops when it uninits', async () => {
    const fan = await device({ speed: '2' });
    assert.equal(fan.rxListeners.size, 1);

    await fan.onUninit();
    assert.equal(fan.rxListeners.size, 0);
});

test('a received speed sets the step and turns the fan on', async () => {
    const fan = await device({ speed: '2', onoff: false });
    await heard(fan, 'fan.speed.4');

    assert.equal(fan.capabilityValues.lucci_speed, '4');
    assert.equal(fan.capabilityValues.onoff, true, 'a speed code starts the fan');
});

test('a received off turns the fan off', async () => {
    const fan = await device({ speed: '3', onoff: true });
    await heard(fan, 'fan.off');

    assert.equal(fan.capabilityValues.onoff, false);
    assert.equal(fan.capabilityValues.lucci_speed, '3', 'the step is still remembered');
});

test('a received direction and timer are exact, not a hint', async () => {
    // The whole reason following the handset is worth the effort: these are
    // absolute, so the handset tells us the state it moved to rather than that
    // something changed.
    const fan = await device({ speed: '2' });

    await heard(fan, 'fan.direction.reverse');
    assert.equal(fan.capabilityValues.lucci_direction, 'reverse');

    await heard(fan, 'fan.timer.4h');
    assert.equal(fan.capabilityValues.lucci_timer, '4h');
});

test('following the handset never transmits', async () => {
    // The one mistake in this path that would be unrecoverable: echoing a frame
    // back would have Homey and the handset talking over each other, and on a
    // relative command would double the step.
    const fan = await device({ speed: '2', onoff: false });

    for (const key of ['fan.speed.5', 'fan.off', 'fan.direction.forward', 'fan.timer.2h']) {
        await heard(fan, key);
    }
    assert.deepEqual(fan.sent, [], 'mirroring put a frame on air');
});

test('another handset is ignored', async () => {
    const fan = await device({ speed: '2', onoff: false });
    const elsewhere = ADDRESS.map((bit, i) => (i === 0 ? bit ^ 1 : bit));

    await receive(fan, buildFrame(elsewhere, 'fan.speed.5'));

    assert.equal(fan.capabilityValues.lucci_speed, '2', 'one household drove another\'s fan');
    assert.equal(fan.capabilityValues.onoff, false);
});

test('repeats of one press are collapsed, a later press is not', async () => {
    const fan = await device({ speed: '2', onoff: false });
    const lines = () => fan.logs.filter(line => line === 'rx fan.speed.5 from the handset').length;

    // One press can reach us as two or three receptions: isFirst only groups the
    // frames Homey heard as a single burst.
    await heard(fan, 'fan.speed.5');
    await heard(fan, 'fan.speed.5');
    assert.equal(lines(), 1, 'the same press was acted on twice');

    // Long enough later, it is a new press.
    fan.lastRxAt = 0;
    await heard(fan, 'fan.speed.5');
    assert.equal(lines(), 2);
});

test('a frame Homey marks as a repeat is ignored outright', async () => {
    const fan = await device({ speed: '2', onoff: false });
    await receive(fan, buildFrame(ADDRESS, 'fan.speed.5'), false);

    assert.equal(fan.capabilityValues.lucci_speed, '2');
});

test('the light is heard, said once, and otherwise left alone', async () => {
    // Its codes carry the same address, so this device hears them whether it
    // wants to or not. A held dimmer button is 56 frames, which is not worth a
    // line each — but that the light is audible at all is step 6's premise.
    const fan = await device({ speed: '2', onoff: true });

    await heard(fan, 'light.onoff');
    await heard(fan, 'light.dimmer');
    await heard(fan, 'light.dimmer');

    assert.equal(fan.logs.filter(line => line.includes('the light is a separate device')).length, 1);
    assert.equal(fan.capabilityValues.onoff, true, 'a light command moved the fan');
    assert.deepEqual(fan.sent, []);
});
