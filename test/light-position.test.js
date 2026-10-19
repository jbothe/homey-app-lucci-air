'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    STEPS, MIN, MAX, MARGIN, SATURATE, KEY_UP, KEY_DOWN,
    isStep, isEnd, toStep, toDim, nearerEnd, plan, stepped, airtime,
} = require('../lib/light-position');

const presses = moves => moves.reduce((total, move) => total + move.presses, 0);

test('the range is the 32 steps the hardware has', () => {
    assert.equal(STEPS, 32);
    assert.equal(MIN, 0);
    assert.equal(MAX, 31);

    // Enough to arrive at an end stop from the far side, whatever the app
    // believed beforehand.
    assert.ok(SATURATE > MAX - MIN, 'saturating cannot cross the range');
    assert.equal(SATURATE, STEPS + MARGIN);
});

test('dim maps onto steps, and 0% is the dimmest the light goes', () => {
    // Not off: the light stays lit at its minimum, and onoff is what turns it
    // off. A dim of 0 that meant off would make the slider a second power
    // switch with no way back up.
    assert.equal(toStep(0), MIN);
    assert.equal(toStep(1), MAX);
    assert.equal(toDim(MIN), 0);
    assert.equal(toDim(MAX), 1);

    // Every step round-trips, so a slider the user has not moved does not drift
    // by a step each time it is read back.
    for (let step = MIN; step <= MAX; step += 1) {
        assert.equal(toStep(toDim(step)), step, `step ${step}`);
    }
});

test('a dim outside 0 to 1 is clamped rather than trusted', () => {
    assert.equal(toStep(-0.5), MIN);
    assert.equal(toStep(1.5), MAX);
    assert.equal(toDim(-3), 0);
    assert.equal(toDim(99), 1);
});

test('only a whole step in range is a step', () => {
    assert.equal(isStep(0), true);
    assert.equal(isStep(31), true);
    assert.equal(isStep(32), false);
    assert.equal(isStep(-1), false);
    assert.equal(isStep(1.5), false);
    assert.equal(isStep(null), false);
    assert.equal(isStep('4'), false);

    assert.deepEqual([isEnd(MIN), isEnd(MAX), isEnd(1), isEnd(30)], [true, true, false, false]);
});

test('an end stop from a known position oversteps on purpose', () => {
    // The trick the saturation buys: aim past the end, let the end absorb the
    // surplus, and the light is then known to be there rather than estimated to
    // be. It is also far quicker than re-establishing from scratch.
    const down = plan(10, MIN);
    assert.deepEqual(down.moves, [{ key: KEY_DOWN, presses: 14, anchorsAt: MIN }]);
    assert.equal(down.endsAt, MIN);
    assert.equal(down.anchored, true);

    const up = plan(10, MAX);
    assert.deepEqual(up.moves, [{ key: KEY_UP, presses: 21 + MARGIN, anchorsAt: MAX }]);
    assert.equal(up.anchored, true);

    // Already there, as far as the estimate knows: still worth the margin,
    // because that is what makes the estimate a fact.
    assert.deepEqual(plan(MIN, MIN).moves, [{ key: KEY_DOWN, presses: MARGIN, anchorsAt: MIN }]);
    assert.equal(plan(MIN, MIN).anchored, true);
});

test('an end stop from nowhere takes the long way, and cannot fail', () => {
    for (const [to, key] of [[MIN, KEY_DOWN], [MAX, KEY_UP]]) {
        const made = plan(null, to);
        assert.deepEqual(made.moves, [{ key, presses: SATURATE, anchorsAt: to }]);
        assert.equal(made.endsAt, to);
        assert.equal(made.anchored, true);
    }
});

test('a step in the middle from a known position is the difference', () => {
    const up = plan(10, 20);
    assert.deepEqual(up.moves, [{ key: KEY_UP, presses: 10 }]);
    assert.equal(up.anchored, false, 'nothing anchors a position off the ends');

    const down = plan(20, 10);
    assert.deepEqual(down.moves, [{ key: KEY_DOWN, presses: 10 }]);
});

test('a move to where the light already is sends nothing', () => {
    const made = plan(14, 14);
    assert.deepEqual(made.moves, []);
    assert.equal(made.endsAt, 14);
});

test('the middle from nowhere saturates first, towards the nearer end', () => {
    // Slow, and the only way to be right. The nearer end is whichever leaves
    // less stepping afterwards.
    const low = plan(null, 5);
    assert.deepEqual(low.moves, [
        { key: KEY_DOWN, presses: SATURATE, anchorsAt: MIN }, { key: KEY_UP, presses: 5 },
    ]);

    const high = plan(null, 26);
    assert.deepEqual(high.moves, [
        { key: KEY_UP, presses: SATURATE, anchorsAt: MAX }, { key: KEY_DOWN, presses: 5 },
    ]);

    // The anchor is what hands a known position to the second move, and what
    // leaves a usable estimate if the move is interrupted between the two.
    assert.equal(low.moves[0].anchorsAt, MIN);
    assert.equal(low.moves[1].anchorsAt, undefined);

    assert.equal(nearerEnd(0), MIN);
    assert.equal(nearerEnd(15), MIN);
    assert.equal(nearerEnd(16), MAX);
    assert.equal(nearerEnd(31), MAX);
});

test('every target is reachable from every starting point', () => {
    // The property that matters: whatever the app believes, including nothing at
    // all, there is a plan, and it lands where it says it will.
    for (const from of [null, ...Array.from({ length: STEPS }, (_, i) => i)]) {
        for (let to = MIN; to <= MAX; to += 1) {
            const made = plan(from, to);
            assert.equal(made.endsAt, to, `${from} -> ${to}`);

            // Walk the plan a press at a time and see where the light lands,
            // saturation and all. This is the check that the arithmetic agrees
            // with the hardware's behaviour rather than only with itself.
            let at = from === null ? MAX : from; // worst case: the far end
            for (const move of made.moves) {
                for (let i = 0; i < move.presses; i += 1) at = stepped(at, move.key);
            }
            assert.equal(at, to, `walking ${from} -> ${to} ended at ${at}`);
        }
    }
});

test('a plan from nowhere lands even if the light was at the other end', () => {
    // Saturating has to work from the worst case, not the average one.
    for (const to of [MIN, MAX, 7, 24]) {
        for (const actually of [MIN, MAX, 15]) {
            let at = actually;
            for (const move of plan(null, to).moves) {
                for (let i = 0; i < move.presses; i += 1) at = stepped(at, move.key);
            }
            assert.equal(at, to, `believed nothing, was at ${actually}, aimed at ${to}`);
        }
    }
});

test('an overheard press moves the estimate by one, and saturates', () => {
    assert.equal(stepped(10, KEY_UP), 11);
    assert.equal(stepped(10, KEY_DOWN), 9);

    // Pressed towards an end it is already against: nothing happened.
    assert.equal(stepped(MAX, KEY_UP), MAX);
    assert.equal(stepped(MIN, KEY_DOWN), MIN);

    // A step cannot be counted from a position that is not known.
    assert.equal(stepped(null, KEY_UP), null);
    assert.equal(stepped(undefined, KEY_DOWN), null);

    // Anything else leaves it alone.
    assert.equal(stepped(10, 'light.onoff'), 10);
});

test('a target that is not a step is refused rather than guessed at', () => {
    for (const bad of [null, undefined, -1, 32, 1.5, '4']) {
        assert.throws(() => plan(10, bad), /Not a step/);
    }
});

test('airtime is the presses times what a press costs', () => {
    assert.equal(airtime([{ key: KEY_UP, presses: 10 }], 573), 5730);
    assert.equal(airtime(plan(null, MIN).moves, 573), SATURATE * 573);
    assert.equal(airtime([], 573), 0);

    // The figure worth knowing: re-establishing takes about 20 seconds, which is
    // why it happens only when the position is unknown or being calibrated.
    assert.ok(airtime(plan(null, MIN).moves, 573) > 20000);
    // And a nudge is a second or two.
    assert.ok(airtime(plan(10, 12).moves, 573) < 1500);
});

test('an interrupted move still leaves a usable estimate', () => {
    // A move takes seconds, so being cut off partway is ordinary. One press is
    // one step, so the presses that did go out are exactly what moved — and a
    // move that reached its anchor hands on a position that is a fact.
    const made = plan(null, 20);
    const [saturating, stepping] = made.moves;

    let at = null;
    for (let i = 0; i < saturating.presses; i += 1) at = stepped(at, saturating.key);
    assert.equal(at, null, 'nothing can be counted from nowhere');

    // Which is the point of the anchor: it says where the light is regardless.
    at = saturating.anchorsAt;
    assert.equal(at, MAX);

    // Cut off three presses into the second move.
    for (let i = 0; i < 3; i += 1) at = stepped(at, stepping.key);
    assert.equal(at, MAX - 3, 'the estimate survives the interruption');
});
