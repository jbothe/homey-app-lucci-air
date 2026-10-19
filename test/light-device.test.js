'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { ADDRESS_LENGTH, identifyFrame, buildFrame } = require('../lib/lucci-protocol');
const position = require('../lib/light-position');

// As in test/device.test.js, with one difference that matters: the clock runs
// fast. Delays are scaled rather than ignored, because presses are deliberately
// spaced — a press is 423ms of airtime and two laid on top of each other are
// heard as one (see lib/press-queue.js) — so a test that collapsed every delay
// to zero could not tell a cancelled move from a completed one.
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
            // 573ms of real spacing becomes 6ms here: fast enough for a suite,
            // slow enough that order and interruption still mean something.
            setTimeout: (fn, ms = 0) => setTimeout(fn, Math.ceil(ms / 100)),
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

// `on: null` leaves the capability unset, which is what a brand-new device
// looks like — the case the pair-time question exists for. `told` is the answer
// that question stored.
async function light({ on = true, at, bit24 = 0, told } = {}) {
    const device = new LucciLightDevice();
    device.storeValues.address = ADDRESS;
    if (bit24 !== null) device.storeValues.bit24 = bit24;
    if (at !== undefined) device.storeValues.position = at;
    if (told !== undefined) device.storeValues.lit = told;
    if (on !== null) device.capabilityValues.onoff = on;
    await device.onInit();
    return device;
}

const keysSent = device => device.sent.map(payload => identifyFrame(payload).key);
const counted = (device, key) => keysSent(device).filter(k => k === key).length;

// A capability request, the way Homey makes one: the listener runs, then Homey
// writes the value that was asked for. Then the move it may have started, and a
// tick for anything the device deferred past its own listener — which is where
// a write to a *different* capability has to happen. See lib/reflect.js.
async function request(device, capability, value) {
    await device.listeners[capability](value, {});
    device.capabilityValues[capability] = value;
    await device.moving;
    await new Promise(resolve => setTimeout(resolve, 1));
}

async function receive(device, key, isFirst = true) {
    for (const listener of device.rxListeners) listener(identifyFrame(buildFrame(ADDRESS, key, 0)), isFirst);
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

test('onoff is idempotent, because a stateless toggle is not', async () => {
    // "Turn it on" twice turns it on once, which is what onoff means
    // everywhere. Asking for the state it is already believed to be in used to
    // send a toggle and turn the light off.
    const device = await light({ on: true, at: 10 });

    await request(device, 'onoff', true);
    assert.deepEqual(device.sent, [], 'a flow asking for on twice turned the light off');
    assert.ok(device.logs.some(line => line.includes('already believed to be on')), device.logs.join(' | '));

    await request(device, 'onoff', false);
    assert.deepEqual(keysSent(device), ['light.onoff'], 'a real change sent nothing');
});

test('two quick presses leave Homey and the light in step', async () => {
    // Reported from the hardware: Homey can deliver two fast presses as a single
    // listener call carrying the net value. That used to send one toggle and
    // leave the two inverted — the drift onoff gets blamed for.
    const device = await light({ on: false, at: 10 });

    // Coalesced: off -> on -> off arrives as one call for the value it ended on.
    await request(device, 'onoff', false);
    assert.deepEqual(device.sent, [], 'one toggle went out for a net change of nothing');
    assert.equal(device.capabilityValues.onoff, false);

    // And delivered separately, the same two presses are two toggles and end
    // where they started.
    await request(device, 'onoff', true);
    await request(device, 'onoff', false);
    assert.deepEqual(keysSent(device), ['light.onoff', 'light.onoff']);
    assert.equal(device.capabilityValues.onoff, false);
});

test('the toggle button sends one toggle and flips the belief', async () => {
    // A press is an event, so it cannot be collapsed by value the way a state
    // change can. This is the way out when the belief has drifted.
    const device = await light({ on: false, at: 10 });

    await request(device, 'lucci_toggle', true);
    assert.deepEqual(keysSent(device), ['light.onoff']);
    assert.equal(device.capabilityValues.onoff, true, 'the tile did not follow the toggle');

    await request(device, 'lucci_toggle', true);
    assert.deepEqual(keysSent(device), ['light.onoff', 'light.onoff'], 'the second press was collapsed');
    assert.equal(device.capabilityValues.onoff, false);
});

test('the toggle button works whatever the light is believed to be doing', async () => {
    // Unlike the brightness controls, which are gated on the light being on:
    // this is the control that fixes a wrong belief, so it cannot be refused
    // on the strength of one.
    for (const on of [true, false]) {
        const device = await light({ on, at: 10 });
        await request(device, 'lucci_toggle', true);

        assert.deepEqual(keysSent(device), ['light.onoff'], `believed ${on}`);
        assert.equal(device.capabilityValues.onoff, !on);
    }
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
    await new Promise(resolve => setTimeout(resolve, 20));
    const partway = device.sent.length;
    assert.ok(partway > 0 && partway < position.MAX, `sent ${partway} of a 31-press move`);

    await request(device, 'dim', position.toDim(2));

    assert.ok(device.logs.some(line => line.includes('cancelled the move in flight')), device.logs.join(' | '));
    // And the presses that did go out were counted, so the estimate survived.
    assert.equal(device.position, 2);
    // The move really was cut short rather than run to the end and corrected:
    // a full run up and back would be sixty presses.
    assert.ok(device.sent.length < 40, `sent ${device.sent.length} presses in total`);
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
    await new Promise(resolve => setTimeout(resolve, 15));

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
    await new Promise(resolve => setTimeout(resolve, 20));

    await receive(device, 'light.dimmer');
    await device.moving;

    assert.ok(device.logs.some(line => line.includes('at the handset')), device.logs.join(' | '));
    assert.equal(device.move, null);
});

test('the light ignores the fan, and other households', async () => {
    const device = await light({ on: true, at: 10 });

    for (const listener of device.rxListeners) {
        listener(identifyFrame(buildFrame(ADDRESS, 'fan.speed.3', 0)), true);
        listener(identifyFrame(buildFrame(ADDRESS.map((b, i) => (i ? b : b ^ 1)), 'light.onoff', 0)), true);
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
    await new Promise(resolve => setTimeout(resolve, 20));

    await device.onUninit();
    await device.moving;

    assert.equal(device.rxListeners.size, 0);
    assert.equal(device.move, null);
});

test('the light transmits the bit 24 it was paired with', async () => {
    const device = await light({ at: 10, bit24: 1 });
    await request(device, 'lucci_brighter', true);

    assert.equal(device.sent[0][24], 1);
    assert.ok(device.logs.some(line => line.includes('bit 24 1')), device.logs.join(' | '));
});

test('a light with no stored bit 24 refuses to transmit', async () => {
    const device = await light({ at: 10, bit24: null });

    assert.equal(device.unavailable, 'errors.not_paired');
    assert.deepEqual(Object.keys(device.listeners), []);
});

test('every press of a long move carries the learned bit', async () => {
    // A saturating move is dozens of frames. One of them going out wrong would
    // be a step the light ignored, and the estimate would quietly drift.
    const device = await light({ at: 10, bit24: 1 });
    await request(device, 'dim', 0);

    assert.ok(device.sent.length > 10, `only ${device.sent.length} presses`);
    for (const payload of device.sent) assert.equal(payload[24], 1);
});

test('two presses in a row stay in step without Homey writing between them', async () => {
    // **The failure the idempotence check did not fix, and caused.**
    //
    // Homey writes a requested capability value when the listener resolves, not
    // before it runs — the same ordering that makes reflect() necessary. So the
    // second of two quick presses used to compare itself against the value from
    // before the first one, conclude the light was already where it was being
    // asked to go, and send nothing. One toggle for two presses, and Homey left
    // believing the opposite of what the light was doing.
    //
    // No capability writes here at all: that is the point. This is what the
    // listener sees when presses arrive faster than Homey's own bookkeeping.
    const device = await light({ on: true, at: 10 });

    await device.listeners.onoff(false, {});
    await device.listeners.onoff(true, {});
    await new Promise(resolve => setTimeout(resolve, 1));

    assert.deepEqual(keysSent(device), ['light.onoff', 'light.onoff'],
        'the second press was swallowed, so the light ended up inverted');
});

test('a run of presses sends one toggle each, however fast', async () => {
    const device = await light({ on: false, at: 10 });

    for (const value of [true, false, true, false, true]) {
        await device.listeners.onoff(value, {});
    }
    await new Promise(resolve => setTimeout(resolve, 1));

    assert.equal(counted(device, 'light.onoff'), 5);
});

test('a repeated request still sends nothing, even back to back', async () => {
    // Idempotence has to survive the fix: asking twice for the state it is
    // already in is still one change, or none.
    const device = await light({ on: false, at: 10 });

    await device.listeners.onoff(true, {});
    await device.listeners.onoff(true, {});
    await new Promise(resolve => setTimeout(resolve, 1));

    assert.equal(counted(device, 'light.onoff'), 1, 'asking for on twice toggled it twice');
});

test('a press already queued when a move is cancelled is dropped, not counted', async () => {
    // A press is 423ms of airtime, so the next one waits its turn — and a move
    // abandoned during that wait has a press already committed. Letting it go
    // out would move the light one step past where the new move's plan assumed
    // it was, and the estimate would be wrong by exactly that step.
    const device = await light({ at: 0 });

    device.listeners.dim(position.toDim(position.MAX), {});
    await new Promise(resolve => setTimeout(resolve, 20));
    const partway = device.position;

    device.cancelMove('a test');
    await device.moving;

    assert.ok(device.logs.some(line => line.includes('dropped before it reached the air')),
        device.logs.join(' | '));
    // Whatever went out was counted; nothing that did not go out was.
    assert.equal(device.position, partway);
    assert.equal(device.sent.length, partway, 'presses sent and steps counted disagree');
});

test('every press of a move is spaced, so none lands on the one before', async () => {
    // The fault this is all for: two transmissions laid on top of each other are
    // heard as one long press, so a thirty-press move moved the light once.
    const device = await light({ at: 10 });
    const at = [];
    device.signal = { tx: async () => { at.push(Date.now()); } };

    await request(device, 'dim', position.toDim(16));

    assert.equal(at.length, 6);
    for (let i = 1; i < at.length; i += 1) {
        // The harness clock runs at 1/100, so the real 573ms shows up as ~6ms.
        assert.ok(at[i] - at[i - 1] >= 4, `press ${i} came ${at[i] - at[i - 1]}ms after ${i - 1}`);
    }
});

// --- where the first belief comes from --------------------------------------

test('a brand-new light believes what it was told at pair time', async () => {
    // The one fact about this device that cannot be worked out and cannot be
    // measured. Before it was asked, the belief started as a guess and every
    // toggle after it preserved that guess faithfully.
    for (const told of [true, false]) {
        const device = await light({ on: null, at: 10, told });

        assert.equal(device.lit, told, `told ${told}`);
        assert.equal(device.capabilityValues.onoff, told, 'the tile did not show it');
        assert.ok(device.logs.some(line => line.includes('first run')), device.logs.join(' | '));
    }
});

test('a light paired before the question was asked assumes off', async () => {
    // Nothing stored and nothing on the capability: there is no answer to use,
    // and off is the assumption that cannot turn the light off by surprise.
    const device = await light({ on: null, at: 10 });

    assert.equal(device.lit, false);
    assert.equal(device.capabilityValues.onoff, false);
});

test('after a restart the capability wins, not the pair-time answer', async () => {
    // It holds everything that has happened since pairing, which is strictly
    // better than what was true once.
    const device = await light({ on: true, at: 10, told: false });

    assert.equal(device.lit, true);
    assert.ok(device.logs.some(line => line.includes('carried over')), device.logs.join(' | '));
});

// --- a brightness press is evidence -----------------------------------------

test('a received brightness press means the light is on', async () => {
    // The codes do nothing while it is off, so nobody presses dimmer at a dark
    // light — they reach for the toggle. The only self-correction available for
    // a belief with no feedback behind it.
    for (const key of ['light.brighter', 'light.dimmer']) {
        const device = await light({ on: false, at: 10 });
        await receive(device, key);

        assert.equal(device.lit, true, key);
        assert.equal(device.capabilityValues.onoff, true, key);
        assert.ok(device.logs.some(line => line.includes('believed off — so it is on')),
            device.logs.join(' | '));
    }
});

test('the inference does not transmit, and still moves the estimate', async () => {
    const device = await light({ on: false, at: 10 });
    await receive(device, 'light.brighter');

    assert.deepEqual(device.sent, [], 'put a frame on air for something it overheard');
    assert.equal(device.position, 11, 'the step was not counted');
});

test('a brightness press at a light already believed on says nothing new', async () => {
    const device = await light({ on: true, at: 10 });
    await receive(device, 'light.dimmer');

    assert.equal(device.lit, true);
    assert.equal(device.logs.filter(line => line.includes('so it is on')).length, 0);
});

test('Homey\'s own brightness presses are still refused while it is off', async () => {
    // The inference is about what the handset did, not about what Homey may do.
    // Sending a brightness code at a light believed off would be transmitting
    // into the void, and would not make it true.
    const device = await light({ on: false, at: 10 });
    await request(device, 'lucci_brighter', true);

    assert.deepEqual(device.sent, []);
    assert.equal(device.lit, false);
});
