'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { synthesise } = require('./synth');
const {
    analyseRemote, buttonOf, verdictFor, reportLines, PLAN,
} = require('../tools/cr2032');

// The CR2032 remote's shape: a one-pulse preamble, then 24 symbols that each
// open on a GAP and close on a pulse, the long pulse being a 1. Words are in
// bit order, so symbol index = bit. The codes below are invented - the real
// ones are not committed, because they drive a fan.
const REMOTE = {
    sof: [348],
    words: [[694, 348], [348, 694]],
    interval: 10512,
    trailing: false,
};

const ADDRESS = '11000101001011100010';
const code = nibble => `${ADDRESS}${nibble}`;

// One recording of one or more presses, nine frames each, as the recorder gives
// it. Jitter is on, so the analyser is never handed the exact values.
function recording(label, codes, { jitter = 12, seed = 3 } = {}) {
    const frames = codes.flatMap(c => Array.from({ length: 9 }, () => [...c].map(Number)));
    return { label, durations: synthesise({ ...REMOTE, frames, jitter, seed }) };
}

const analyse = blocks => {
    const analysis = analyseRemote(blocks);
    assert.equal(analysis.ok, true, `analysis failed: ${analysis.reason}`);
    return analysis;
};

test('a code reads back as it was sent, not as its complement', () => {
    // The trap this module exists for: pulses.js numbers the symbol with the
    // shorter first duration 0, and here that is the long-pulse symbol.
    const sent = code('1011');
    const analysis = analyse([recording('Off (1)', [sent]), recording('Off (2)', [sent])]);

    assert.deepEqual(analysis.presses.map(p => p.code), [sent, sent]);
    assert.ok(Math.abs(analysis.polarity.pulses.long - 694) < 15);
    assert.ok(Math.abs(analysis.polarity.pulses.short - 348) < 15);
});

test('noisy first symbols are not swallowed into the preamble', () => {
    // The receiver's gain is still settling over the first few symbols of a
    // burst, so they carry the worst timing error. The default tie-break prefers
    // the lowest fit residual, which rewards claiming those symbols as preamble:
    // the first real OFF recording read as 7 durations of preamble and 21
    // symbols. Four frames, because that is what a single press gave.
    const sent = code('1011');
    const bits = [...sent].map(Number);
    const base = synthesise({ ...REMOTE, frames: Array.from({ length: 4 }, () => bits), jitter: 8, seed: 5 });
    const hit = [-38, 41, -33, 29, -44, 36];
    const durations = base.map((d, i) => (i % 50 >= 1 && i % 50 <= 6 ? d + hit[(i % 50) - 1] : d));

    const analysis = analyse([{ label: 'Off (1)', durations }]);
    assert.equal(analysis.alignment.sofLength, 1);
    assert.equal(analysis.presses[0].code, sent);
});

test('the preamble, the interval and the words come out in bit order', () => {
    const analysis = analyse([recording('Off (1)', [code('1011')]), recording('Off (2)', [code('1011')])]);
    const { definition } = analysis;

    assert.equal(definition.sof.length, 1);
    assert.ok(Math.abs(definition.sof[0] - 348) < 15);
    assert.equal(definition.words.length, 2);
    // index 0 = bit 0 = short pulse, index 1 = bit 1 = long pulse
    assert.ok(definition.words[1][1] > definition.words[0][1] + 200, 'bit 1 should end on the long pulse');
    assert.ok(Math.abs(definition.interval - 10512) < 60);
    assert.equal(definition.minimalLength, 23);
    assert.equal(definition.maximalLength, 24);
    assert.equal(definition.repetitions, 9);
});

test('bits that never change are address, and bits that move between buttons are command', () => {
    const analysis = analyse([
        recording('Speed I (1)', [code('0001')]),
        recording('Speed II (1)', [code('0110')]),
        recording('Off (1)', [code('1011')]),
    ]);
    const { fields } = analysis;

    assert.equal(fields.mask, '.'.repeat(20) + '^^^^');
    assert.equal(fields.prefix, 20);
    assert.deepEqual(fields.within, []);
});

test('a command bit that happens to hold still reads as address', () => {
    // The limit the report warns about. Bit 21 is 0 in all three codes, so it
    // is indistinguishable from address until a button that sets it is recorded.
    const analysis = analyse([
        recording('Speed I (1)', [code('0001')]),
        recording('Speed II (1)', [code('0010')]),
        recording('Off (1)', [code('1011')]),
    ]);

    assert.equal(analysis.fields.mask.slice(20), '^.^^');
});

test('a button that alternates is absolute, and needs a third press to say so', () => {
    const a = code('0110');
    const b = code('1001');
    const three = analyse([
        recording('Reverse (1)', [a]),
        recording('Reverse (2)', [b]),
        recording('Reverse (3)', [a]),
    ]);
    assert.equal(three.buttons[0].verdict.kind, 'alternates');
    // The bits it moves are state the user supplied, not a mystery.
    assert.deepEqual(three.fields.within, []);
    assert.ok(three.fields.state.length > 0);
    assert.ok(three.fields.mask.includes('~'));

    // Two differing presses are NOT enough: a counter looks the same.
    const two = analyse([recording('Reverse (1)', [a]), recording('Reverse (2)', [b])]);
    assert.equal(two.buttons[0].verdict.kind, 'two-differ');
    assert.match(two.buttons[0].verdict.text, /third press/);
});

test('a button that sends one code every time is a toggle or stateless', () => {
    const on = code('0100');
    const analysis = analyse([
        recording('Light (1)', [on]),
        recording('Light (2)', [on]),
        recording('Light (3)', [on]),
    ]);
    assert.equal(analysis.buttons[0].verdict.kind, 'same');
});

test('a bit that moves between presses of one button is flagged, not mistaken for command', () => {
    // Three different codes in three presses, in two bits: neither a toggle nor
    // an alternation. The shape of a counter or a rolling code.
    const analysis = analyse([
        recording('Speed III (1)', [code('0100')]),
        recording('Speed III (2)', [code('0101')]),
        recording('Speed III (3)', [code('0110')]),
        recording('Off (1)', [code('1011')]),
    ]);

    assert.equal(analysis.buttons[0].verdict.kind, 'moves');
    assert.deepEqual(analysis.fields.within, [22, 23]);
    assert.equal(analysis.fields.mask.slice(20), '^^!!');
    assert.match(reportLines(analysis).join('\n'), /change between presses of the same button/);
});

test('parity: equal weights are consistent with it, mixed weights rule it out', () => {
    // 1100 and 0011 add two ones to an address of odd weight; so do all of them.
    const even = analyse([
        recording('Speed I (1)', [code('0000')]),
        recording('Speed II (1)', [code('0011')]),
        recording('Off (1)', [code('1100')]),
    ]);
    const weightOf = c => [...c].filter(b => b === '1').length;
    assert.ok([code('0000'), code('0011'), code('1100')].every((c, _, all) => weightOf(c) % 2 === weightOf(all[0]) % 2));
    assert.equal(Math.min(even.parity.even, even.parity.odd), 0);
    assert.match(reportLines(even).join('\n'), /CONSISTENT with a\s+parity bit/);

    const mixed = analyse([
        recording('Speed I (1)', [code('0000')]),
        recording('Speed II (1)', [code('0001')]),
    ]);
    assert.ok(mixed.parity.even > 0 && mixed.parity.odd > 0);
    assert.match(reportLines(mixed).join('\n'), /NONE of the 24 bits/);
});

test('one recording holding two presses shows what each sent, in order', () => {
    const first = code('0001');
    const second = code('0010');
    const analysis = analyse([
        recording('Speed I (1)', [first, second]),
        recording('Off (1)', [code('1011')]),
    ]);

    const press = analysis.presses[0];
    assert.equal(press.code, null, 'a recording with two codes is not a single code');
    assert.deepEqual(press.order.map(r => r.bits), [first, second]);
});

test('the plan lists what is still to record', () => {
    const analysis = analyse([
        recording('Speed I (1)', [code('0001')]),
        recording('Speed I (2)', [code('0001')]),
        recording('Off (1)', [code('1011')]),
    ]);
    const short = analysis.coverage.filter(c => c.short).map(c => c.name);

    assert.ok(!short.includes('Speed I'));
    assert.ok(short.includes('Off'), 'one press of Off is short of two');
    assert.ok(short.includes('Reverse'));
    assert.equal(analysis.coverage.length, PLAN.length);
});

test('labels name a button and a press', () => {
    assert.deepEqual(buttonOf('Reverse (2)'), { button: 'Reverse', press: 2 });
    assert.deepEqual(buttonOf('Speed VI #3'), { button: 'Speed VI', press: 3 });
    assert.deepEqual(buttonOf('Off'), { button: 'Off', press: 1 });
    assert.equal(verdictFor(['a']).kind, 'once');
});
