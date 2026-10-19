'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { check, chooseSensitivity, signalDefinition } = require('../tools/signal');

// An alphabet entry as inferAlignment produces one: a class for the pulse and
// one for the gap, each with the spread it was measured over.
const symbol = (index, [pulse, pulseSpread], [gap, gapSpread]) => ({
    index,
    pulse: { mean: pulse, min: pulse - pulseSpread, max: pulse + pulseSpread },
    gap: { mean: gap, min: gap - gapSpread, max: gap + gapSpread },
});

// The Bear handset, as measured off its own recordings.
const BEAR = [
    symbol(0, [331, 17], [753, 63]),
    symbol(1, [690, 18], [392, 12]),
];

test('a tolerance narrower than the measured spread is rejected', () => {
    const tight = check(BEAR, 0.02);
    assert.equal(tight.ok, false);
    assert.deepEqual(tight.excluded.map(s => s.index), [0, 1]);
    assert.deepEqual(tight.ambiguous, []);
});

test('a tolerance wide enough to make two symbols overlap is rejected', () => {
    const loose = check(BEAR, 0.5);
    assert.equal(loose.ok, false);
    assert.deepEqual(loose.ambiguous, [[0, 1]]);
});

test('symbols are only ambiguous when they overlap on both pulse and gap', () => {
    // Homey matches a (pulse, gap) against each word, so sharing one half is
    // not enough to make two words indistinguishable.
    const samePulse = [
        symbol(0, [1500, 20], [400, 20]),
        symbol(1, [1500, 20], [900, 20]),
    ];
    assert.deepEqual(check(samePulse, 0.3).ambiguous, []);
    assert.equal(check(samePulse, 0.3).ok, true);

    // At 0.5 the gaps overlap too (400 reaches 600, 900 reaches down to 450).
    assert.deepEqual(check(samePulse, 0.5).ambiguous, [[0, 1]]);
});

test('the chosen tolerance sits in the middle of the usable run', () => {
    const { chosen, usable } = chooseSensitivity(BEAR);

    assert.deepEqual(usable.map(t => t.sensitivity), [0.1, 0.15, 0.2, 0.25, 0.3]);
    assert.equal(chosen.sensitivity, 0.2);
    assert.equal(chosen.ok, true);
});

test('no tolerance is chosen when the alphabet cannot be separated', () => {
    // Two symbols a few microseconds apart: every tolerance that admits the
    // spread also makes them ambiguous.
    const indistinct = [
        symbol(0, [400, 30], [600, 30]),
        symbol(1, [420, 30], [610, 30]),
    ];
    const { chosen, usable } = chooseSensitivity(indistinct);

    assert.equal(chosen, null);
    assert.deepEqual(usable, []);
});

test('the definition allows a frame one symbol short of what it transmits', () => {
    // A received frame's last symbol loses its own gap to the silence before
    // the next repeat, so Homey hands back one symbol fewer than went out.
    // Requiring the transmitted length exactly makes the app deaf.
    const definition = signalDefinition({
        alignment: { sof: [4769, 1538], alphabet: BEAR },
        frameLength: 40,
        interval: 9765,
        repetitions: 8,
        sensitivity: 0.2,
    });

    assert.equal(definition.minimalLength, 39);
    assert.equal(definition.maximalLength, 40);
});

test('the definition omits eof and txOnly, and sets a workable rxTimeout', () => {
    const definition = signalDefinition({
        alignment: { sof: [4769, 1538], alphabet: BEAR },
        frameLength: 40,
        interval: 9765,
        repetitions: 8,
        sensitivity: 0.2,
    });

    // Both omissions are what make receiving work at all: Homey will not match
    // a frame against a definition declaring an eof unless it observes that eof
    // on air, and txOnly would switch receiving off.
    assert.equal('eof' in definition, false);
    assert.equal('txOnly' in definition, false);

    // The 10ms default expires inside a frame this long.
    assert.equal(definition.rxTimeout, 255);

    assert.deepEqual(definition.words, [[331, 753], [690, 392]]);
    assert.deepEqual(definition.sof, [4769, 1538]);
    assert.equal(definition.interval, 9765);
    assert.equal(definition.repetitions, 8);
});
