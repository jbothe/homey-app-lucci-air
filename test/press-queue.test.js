'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PRESS_AIRTIME, RELEASE_GAP, PRESS_INTERVAL, pressQueue,
} = require('../lib/press-queue');
const signal = require('../.homeycompose/signals/433/lucci.json');

// A clock that only moves when something waits on it, so a twenty-second move
// takes no time to test and the arithmetic is exact rather than approximate.
function virtualClock() {
    let at = 0;
    const waits = [];
    return {
        now: () => at,
        wait: ms => {
            waits.push(ms);
            at += ms;
            return Promise.resolve();
        },
        tick: ms => { at += ms; },
        waits,
    };
}

test('the airtime is what the signal definition actually transmits', () => {
    // The number this whole module rests on, re-derived from the signal so the
    // two cannot drift apart: change `repetitions` or a word and this fails.
    const preamble = signal.sof.reduce((total, d) => total + d, 0);
    const perBit = signal.words.map(([pulse, gap]) => pulse + gap);
    const frame = preamble + 25 * ((perBit[0] + perBit[1]) / 2);
    const press = signal.repetitions * (frame + signal.interval);

    assert.equal(Math.round(press / 1000), PRESS_AIRTIME);
    assert.equal(PRESS_INTERVAL, PRESS_AIRTIME + RELEASE_GAP);

    // And the figure APP_PLAN.md costs a step at.
    assert.equal(PRESS_INTERVAL, 573);
});

test('the first press goes out at once', async () => {
    const clock = virtualClock();
    const press = pressQueue(clock);
    const sent = [];

    await press(() => sent.push(clock.now()));

    assert.deepEqual(sent, [0]);
    assert.deepEqual(clock.waits, [], 'waited before transmitting anything');
});

test('a press hard on the heels of another waits out the airtime', async () => {
    // The bug, in one assertion: two toggles 134ms apart used to be laid on top
    // of each other and heard as one long press.
    const clock = virtualClock();
    const press = pressQueue(clock);
    const sent = [];

    const first = press(() => sent.push(clock.now()));
    // Let the first take its slot before the clock moves: a press is queued on
    // a microtask, which is nothing in real time and everything to a virtual
    // clock that only advances when asked.
    await Promise.resolve();

    clock.tick(134);
    const second = press(() => sent.push(clock.now()));
    await Promise.all([first, second]);

    assert.deepEqual(sent, [0, PRESS_INTERVAL]);
    assert.ok(sent[1] - sent[0] >= PRESS_AIRTIME, 'the second overlapped the first');
});

test('a long run of presses is spaced evenly, one per interval', async () => {
    // A full-range brightness move. Every press of it used to be queued 150ms
    // after the one before, so thirty presses went out as one transmission.
    const clock = virtualClock();
    const press = pressQueue(clock);
    const sent = [];

    for (let i = 0; i < 30; i += 1) {
        // Queued as fast as the loop can, which is how the move loop does it.
        press(() => sent.push(clock.now()));
    }
    await press(() => sent.push(clock.now()));

    assert.equal(sent.length, 31);
    sent.forEach((at, i) => assert.equal(at, i * PRESS_INTERVAL, `press ${i}`));
});

test('a press long after the last one does not wait at all', async () => {
    const clock = virtualClock();
    const press = pressQueue(clock);
    const sent = [];

    await press(() => sent.push(clock.now()));
    clock.tick(PRESS_INTERVAL * 3);
    await press(() => sent.push(clock.now()));

    assert.deepEqual(sent, [0, PRESS_INTERVAL * 3]);
    assert.deepEqual(clock.waits, []);
});

test('presses go out in the order they were asked for', async () => {
    const clock = virtualClock();
    const press = pressQueue(clock);
    const sent = [];

    const all = ['a', 'b', 'c', 'd'].map(key => press(() => sent.push(key)));
    await Promise.all(all);

    assert.deepEqual(sent, ['a', 'b', 'c', 'd']);
});

test('one failed transmission does not wedge the ones after it', async () => {
    // The radio being busy once is not a reason to stop driving the fan.
    const clock = virtualClock();
    const press = pressQueue(clock);
    const sent = [];

    const bad = press(() => { throw new Error('radio busy'); });
    const good = press(() => sent.push('after'));

    await assert.rejects(() => bad, /radio busy/);
    await good;
    assert.deepEqual(sent, ['after']);
});

test('a press that throws still holds its slot in the clock', async () => {
    // Otherwise a failure would let the next press start early and overlap
    // whatever did make it onto the air.
    const clock = virtualClock();
    const press = pressQueue(clock);
    const sent = [];

    const bad = press(() => { throw new Error('radio busy'); });
    const good = press(() => sent.push(clock.now()));

    await bad.catch(() => {});
    await good;
    assert.deepEqual(sent, [PRESS_INTERVAL]);
});
