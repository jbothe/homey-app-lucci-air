'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseCaptures, clusterDurations, gapParity, separatorThreshold, splitFrames,
    analyseCapture, analyseCaptures, renderFrame, framesAgree, fieldRuns, pairRepeats, OVERFLOW,
} = require('../tools/pulses');
const {
    synthesise, captureFile, BINARY, TABLE, repeat,
} = require('./synth');

const bits = s => s.split('').map(Number);

// A payload with enough of each symbol to be read, and an address prefix shared
// between buttons so the field map has something to find.
const ADDRESS = '0001000000110010110000100010';
const BINARY_FRAME = `${ADDRESS}000100010001`;
const TABLE_FRAME = '22232232132232332202231222322232232222322230222';

test('parseCaptures reads labelled blocks, over several lines, ignoring comments', () => {
    const blocks = parseCaptures([
        '# recorded on the kitchen fan',
        'Fan Speed Up:',
        '4770,1538,332,752',
        '690,392,65535',
        '',
        'Light On/Off (repeat):',
        '4770,1538,690,392,65535',
    ].join('\n'));

    assert.deepEqual(blocks.map(b => b.label), ['Fan Speed Up', 'Light On/Off (repeat)']);
    assert.deepEqual(blocks[0].durations, [4770, 1538, 332, 752, 690, 392, 65535]);
    assert.equal(blocks[1].durations.length, 5);
});

test('parseCaptures ignores a label with no durations under it', () => {
    assert.deepEqual(parseCaptures('Fan Off:\n\nFan On:\n4770,1538,65535').map(b => b.label), ['Fan On']);
});

test('clusterDurations groups jitter and separates distinct durations', () => {
    const clusters = clusterDurations([332, 318, 344, 690, 702, 676, 4770, 4732]);
    assert.deepEqual(clusters.map(c => [c.min, c.max]), [[318, 344], [676, 702], [4732, 4770]]);
    assert.deepEqual(clusters.map(c => c.count), [3, 3, 2]);
});

test('clusterDurations will not chain two durations into one class', () => {
    // 1225 and 1500 are 22% apart, which is inside the tolerance, so only the
    // width cap keeps them apart. Chaining them would read two symbols as one.
    const clusters = clusterDurations([1225, 1300, 1380, 1440, 1500], { maxWidth: 1.2 });
    assert.ok(clusters.length > 1, 'expected more than one class across a 22% spread');
    for (const c of clusters) assert.ok(c.max <= c.min * 1.2, `class ${c.min}-${c.max} is too wide`);
});

test('clusterDurations flags a class too wide to be one duration', () => {
    // Two symbols chained into one class make every reading taken from it
    // wrong, so a class wider than any single duration plausibly is gets
    // reported.
    const [chained] = clusterDurations([1000, 1200, 1400, 1550], { maxWidth: 1.6 });
    assert.equal(chained.suspect, true);

    // But a class sitting right at a tight cap is the ordinary case, not a
    // warning: inferAlignment tries every cap and keeps whichever reading fits
    // best, so flagging that would warn on every clean capture. This is what
    // the real Lucci recordings do, at 282-312us.
    const [tight] = clusterDurations([282, 295, 312], { maxWidth: 1.12 });
    assert.equal(tight.suspect, false);
});

test('gapParity finds the side holding the long gaps, whichever the capture opens on', () => {
    const durations = [332, 752, 690, 392, 332, 10000];
    assert.equal(gapParity(durations), 1);
    assert.equal(gapParity(durations.slice(1)), 0);
});

test('separatorThreshold sits below the gap between repeats and above everything in a frame', () => {
    const durations = synthesise({ ...BINARY, frames: repeat(bits(BINARY_FRAME), 6), jitter: 10 });
    const threshold = separatorThreshold(durations);

    assert.ok(threshold > 4784, `threshold ${threshold} must clear the preamble pulse`);
    assert.ok(threshold < BINARY.interval, `threshold ${threshold} must sit below the interval`);
    assert.equal(splitFrames(durations, threshold).length, 6);
});

test('separatorThreshold is not fooled by a short glitch', () => {
    // A stray 6us duration presents as an enormous jump up to the data, which
    // would drop the threshold below the whole transmission and cut a frame at
    // every gap.
    const durations = synthesise({ ...BINARY, frames: repeat(bits(BINARY_FRAME), 6), jitter: 10 });
    durations.splice(5, 0, 6);

    assert.equal(splitFrames(durations, separatorThreshold(durations)).length, 6);
});

test('a two-symbol protocol is recovered exactly', () => {
    const result = analyseCapture(synthesise({
        ...BINARY, frames: repeat(bits(BINARY_FRAME), 8), jitter: 12,
    }));

    assert.equal(result.alignment.sofLength, 2);
    assert.equal(result.alignment.alphabet.length, 2);
    assert.deepEqual(result.distinct, [[BINARY_FRAME, 8]]);
    assert.equal(result.sent, 8);

    // The preamble and the interval are both measured, not assumed.
    assert.deepEqual(result.alignment.sof.map(d => Math.round(d / 10) * 10), [4770, 1540]);
    assert.ok(Math.abs(result.interval - BINARY.interval) < 50, `interval ${result.interval}`);
});

test('the interval excludes the last symbol\'s own gap', () => {
    // The recorder reports that gap and the silence after it as one duration.
    // Handing the sum to Homey as the interval would transmit a frame longer
    // than the handset's.
    const result = analyseCapture(synthesise({
        ...BINARY, frames: repeat(bits(BINARY_FRAME), 8), jitter: 0,
    }));

    assert.equal(result.interval, BINARY.interval);
    assert.equal(result.separator, BINARY.interval + 392);
});

test('a four-symbol protocol behind an odd-length preamble round-trips', () => {
    // The preamble is 9 durations, so the payload's pulses fall on the offsets
    // the preamble's gaps used. Several readings describe the same airwave
    // under different bookkeeping, so what matters is that the one chosen
    // reproduces the recording — not that it labels the fields as we did.
    const durations = synthesise({ ...TABLE, frames: repeat(bits(TABLE_FRAME), 10), jitter: 15 });
    const result = analyseCapture(durations);

    assert.equal(result.alignment.alphabet.length, 4);
    assert.equal(result.distinct.length, 1);
    assert.equal(result.distinct[0][0].length, TABLE_FRAME.length);

    const [[symbols]] = result.distinct;
    const recorded = splitFrames(durations, result.threshold)
        .find(f => f.durations.length === result.frameLength);
    const rendered = renderFrame(bits(symbols), result.alignment, { interval: result.interval });

    assert.ok(
        framesAgree(rendered, [...recorded.durations, recorded.separator], 0.1),
        'the reading does not reproduce the frame it was read from',
    );
});

test('a protocol using a symbol once per frame still decodes', () => {
    // The recurrence floor would throw that symbol away as a glitch, so the
    // second pass drops the floor and demands whole frames instead.
    const rare = '22232232132232332232231222322232232222322230222';
    assert.equal(rare.length, TABLE_FRAME.length);
    assert.equal(rare.split('').filter(c => c === '0').length, 1);

    const result = analyseCapture(synthesise({ ...TABLE, frames: repeat(bits(rare), 10), jitter: 15 }));
    assert.equal(result.alignment.alphabet.length, 4);
    assert.equal(result.distinct[0][0].length, rare.length);
});

test('a glitched frame is reported, not read', () => {
    const durations = synthesise({ ...BINARY, frames: repeat(bits(BINARY_FRAME), 8), jitter: 10 });
    // Break one pulse in the third frame beyond any symbol's range.
    durations[2 * 82 + 10] = 180;

    const result = analyseCapture(durations);
    assert.deepEqual(result.distinct, [[BINARY_FRAME, 7]]);
    assert.equal(result.unreadable, 1);
});

test('a reading no other repeat corroborates is kept out of the field map', () => {
    const good = bits(BINARY_FRAME);
    const odd = bits(`${ADDRESS}000100010000`);
    const result = analyseCapture(synthesise({
        ...BINARY, frames: [...repeat(good, 7), odd], jitter: 10,
    }));

    assert.deepEqual(result.distinct, [[BINARY_FRAME, 7]]);
    assert.deepEqual(result.discarded, [[odd.join(''), 1]]);
});

test('the field map separates what every button shares from what identifies it', () => {
    const blocks = [
        { label: 'Fan On/Off', durations: synthesise({ ...BINARY, frames: repeat(bits(`${ADDRESS}000100010001`), 8), jitter: 10 }) },
        { label: 'Fan Speed Up', durations: synthesise({ ...BINARY, frames: repeat(bits(`${ADDRESS}000100110011`), 8), jitter: 10, seed: 11 }) },
        { label: 'Light On/Off', durations: synthesise({ ...BINARY, frames: repeat(bits(`${ADDRESS}000101010101`), 8), jitter: 10, seed: 13 }) },
    ];

    const { positions, reads } = analyseCaptures(blocks);
    assert.equal(reads.length, 3);
    assert.equal(positions.length, 40);

    const constant = positions.filter(p => p.constant).length;
    assert.equal(positions.slice(0, 32).every(p => p.constant), true, 'address and the shared bits hold still');
    assert.ok(constant >= 32 && constant < 40, `expected a constant prefix and a varying tail, got ${constant}`);

    assert.deepEqual(fieldRuns(positions.slice(0, 4)), [{ start: 0, end: 3, constant: true }]);
});

test('captures that disagree about frame length are not merged into one reading', () => {
    const result = analyseCaptures([
        { label: 'Short', durations: synthesise({ ...BINARY, frames: repeat(bits('00010001000100010001'), 8), jitter: 8 }) },
        { label: 'Long', durations: synthesise({ ...BINARY, frames: repeat(bits(BINARY_FRAME), 8), jitter: 8, seed: 21 }) },
    ]);

    // One frame length is chosen for the session, so the other capture's frames
    // are not whole and contribute no reading. Silently averaging the two would
    // invent a protocol neither of them uses.
    const empty = result.reads.filter(r => r.distinct.length === 0);
    assert.equal(empty.length, 1);
});

test('a capture holding a single frame still yields a reading', () => {
    const durations = synthesise({ ...BINARY, frames: [bits(BINARY_FRAME)], jitter: 8 });
    assert.equal(durations[durations.length - 1], OVERFLOW);

    const result = analyseCapture(durations);
    assert.deepEqual(result.distinct, [[BINARY_FRAME, 1]]);
});

test('captureFile output is what parseCaptures reads back', () => {
    const durations = synthesise({ ...BINARY, frames: repeat(bits(BINARY_FRAME), 4), jitter: 5 });
    const blocks = parseCaptures(captureFile([{ label: 'Fan On/Off', durations }]));

    assert.deepEqual(blocks, [{ label: 'Fan On/Off', durations }]);
});

test('pairRepeats matches a button to its second recording and compares them', () => {
    const paired = pairRepeats([
        { label: 'Fan On/Off', distinct: [['0001', 6]] },
        { label: 'Fan Speed Up', distinct: [['0010', 6]] },
        { label: 'Fan On/Off (repeat)', distinct: [['0001', 6]] },
        { label: 'Fan Speed Up (repeat)', distinct: [['1101', 6]] },
    ]);

    assert.deepEqual(paired, [
        { label: 'Fan On/Off', agrees: true },
        { label: 'Fan Speed Up', agrees: false },
    ]);
});

test('pairRepeats compares the whole set of readings, in any order', () => {
    // A handset that sends two forms per press is still repeating itself when
    // the second recording holds the same two.
    const paired = pairRepeats([
        { label: 'Light On/Off', distinct: [['0101', 4], ['1010', 4]] },
        { label: 'Light On/Off (repeat)', distinct: [['1010', 3], ['0101', 5]] },
    ]);

    assert.deepEqual(paired, [{ label: 'Light On/Off', agrees: true }]);
});

test('pairRepeats does not call two unreadable captures an agreement', () => {
    const paired = pairRepeats([
        { label: 'Fan Direction', distinct: [] },
        { label: 'Fan Direction (repeat)', distinct: [] },
    ]);

    assert.deepEqual(paired, [{ label: 'Fan Direction', agrees: false }]);
});

test('pairRepeats ignores a repeat whose first recording is missing', () => {
    assert.deepEqual(pairRepeats([{ label: 'Fan Direction (repeat)', distinct: [['0100', 6]] }]), []);
});

test('a repeat that began mid-preamble does not veto the reading', () => {
    // The recorder arms part-way through the first transmission more often than
    // not, delivering a frame of the usual length whose payload is shifted. Held
    // against the other repeats as an equal, it makes the preamble look as
    // though it varies, and no reading survives at all.
    const frames = repeat(bits(BINARY_FRAME), 8);
    const durations = synthesise({ ...BINARY, frames, jitter: 10 });

    // Replace the first frame's preamble with the tail of one, as a recorder
    // that started late would report it.
    durations.splice(0, 2, 230, 870, 220);

    const result = analyseCapture(durations);
    assert.notEqual(result.alignment, null, 'no reading survived the truncated repeat');
    assert.equal(result.alignment.sofLength, 2);
    assert.deepEqual(result.distinct, [[BINARY_FRAME, 7]]);

    // And the preamble is measured only over the repeats that carry it, so the
    // truncated one cannot drag its durations off.
    assert.ok(Math.abs(result.alignment.sof[0] - 4770) < 40, `sof ${result.alignment.sof}`);
});

test('a long preamble of repeated pulses is found, odd length and all', () => {
    // The Lucci handset opens with ten short pulses rather than one long one,
    // which comes to an odd number of durations and so shifts the payload onto
    // the offsets the preamble's gaps used.
    const sync = [];
    for (let i = 0; i < 10; i += 1) sync.push(500, 595);
    sync.pop();

    const durations = synthesise({
        sof: sync,
        words: [[295, 797], [791, 301]],
        interval: 9416,
        frames: repeat(bits('0101110011110011101010100'), 9),
        jitter: 10,
        trailing: false,
    });

    const result = analyseCapture(durations);
    assert.equal(result.alignment.sofLength, 19);
    assert.equal(result.alignment.alphabet.length, 2);
    assert.deepEqual(result.distinct, [['0101110011110011101010100', 9]]);
    assert.ok(Math.abs(result.interval - 9416) < 60, `interval ${result.interval}`);
});
