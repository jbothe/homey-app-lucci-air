'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseCaptures, analyseCaptures, decodeFrame } = require('../tools/pulses');
const {
    ADDRESS_LENGTH, FRAME_LENGTH, COMMAND_KEYS,
    buildFrame, identifyFrame, describeFrame,
} = require('../lib/lucci-protocol');

// The 33 recordings off the handset, decoded on every run. This is what ties
// the shipped command table back to the hardware: change a code or a timing
// window and these stop matching. Everything else tests the app against itself.
//
// The file carries the address that operates the fan, so it is deliberately not
// committed (see .gitignore and RF_PROTOCOL.md). Everyone else's `npm test`
// skips this file rather than failing on its absence.
const CAPTURES = path.join(__dirname, '..', 'captures', 'raw-captures.txt');
const skip = fs.existsSync(CAPTURES)
    ? false
    : 'captures/raw-captures.txt not present (it is not committed — see RF_PROTOCOL.md)';

// One pooled reading of the whole session, exactly as `npm run analyse` reads
// it, so the test and the report can never disagree about what a capture means.
// A frame is read here rather than taken from the report's rankings, so every
// repeat the recorder caught is held against the table, not just the consensus.
const session = skip ? null : analyseCaptures(parseCaptures(fs.readFileSync(CAPTURES, 'utf8')));

// Every frame of the modal length that decoded without an unreadable symbol.
// The recorder mistimes edges and invents transitions, so a handful of frames in
// each capture are junk; tools/pulses.js repairs what it can and reports the
// rest as unreadable. Those are dropped here — a reading the recorder could not
// make is not evidence about the protocol either way.
function cleanFrames(capture) {
    return capture.whole
        .map(frame => decodeFrame(frame, session.alignment))
        .filter(symbols => !symbols.includes(null));
}

const allCaptures = () => (session === null ? [] : session.captures);

// What a capture's label says the handset was doing, as a command key, or null
// where the label cannot name one.
//
// The absolute controls are the point of this: "Fan speed step 3" is a claim
// about which of six codes went out, and checking it is what makes the speed
// ladder in RF_PROTOCOL.md a tested mapping rather than an annotation.
const EXPECTED = [
    [/^Fan Off/i, 'fan.off'],
    [/^Fan speed step (\d)/i, m => `fan.speed.${m[1]}`],
    [/^Speed up at max$/i, 'fan.speed.5'],
    [/^Fan Direction to (forward|reverse)/i, m => `fan.direction.${m[1].toLowerCase()}`],
    [/^Timer (\d)hr/i, m => `fan.timer.${m[1]}h`],
    [/^Light On\/Off/i, 'light.onoff'],
    [/(Light )?Brightness [Uu]p/i, 'light.brighter'],
    [/(Light )?Brightness [Dd]own/i, 'light.dimmer'],
];

// Labels that genuinely cannot name a command, and why. Listed rather than
// matched loosely, so a new capture cannot slip in unchecked: a label this test
// does not recognise fails below instead of being quietly skipped.
const AMBIGUOUS = new Map([
    // Relative presses of an absolute control: which of the six codes went out
    // depends on where the fan already was, which the label does not say.
    ['Fan Speed Up', 'the step it moved to depends on where the fan was'],
    ['Fan Speed Down', 'the step it moved to depends on where the fan was'],
    ['Fan Speed Up (repeat)', 'the step it moved to depends on where the fan was'],
    ['Fan Speed Down (repeat)', 'the step it moved to depends on where the fan was'],
    // Several presses walking the timer cycle, so one label covers four codes.
    ['Timer off/cancel', 'several presses, walking the cycle'],
    ['Timer 4hr', 'several presses, walking the cycle'],
]);

function expectedKey(label) {
    // Ambiguity first: "Timer 4hr" is a capture of the cycle being walked, not
    // of one press, and would otherwise match the pattern for a single state.
    if (AMBIGUOUS.has(label)) return null;

    for (const [pattern, key] of EXPECTED) {
        const match = label.match(pattern);
        if (match !== null) return typeof key === 'function' ? key(match) : key;
    }
    return null;
}

test('the session decodes as 25-bit frames behind a 19-duration preamble', { skip }, () => {
    assert.notEqual(session.alignment, null, 'no alignment could be inferred');
    assert.equal(session.alignment.sofLength, 19);
    assert.equal(session.alignment.bodyLength / 2, FRAME_LENGTH);
    assert.equal(session.alignment.alphabet.length, 2, 'two symbols, so plain binary');
    // 33 button presses, plus the held-down brightness capture that measured
    // the hold rate. A short file would otherwise still pass everything below,
    // because each test only checks the captures that are there.
    assert.ok(session.captures.length >= 33,
        `only ${session.captures.length} captures; the session has 33 presses and a hold`);
});

test('every recorded frame is one the command table knows', { skip }, () => {
    // The structural check pairing relies on, run over real traffic: selector,
    // known tail and parity. A frame failing here would also be a frame the
    // driver would log and discard on air.
    for (const capture of allCaptures()) {
        const frames = cleanFrames(capture);
        assert.ok(frames.length >= 1, `${capture.label}: no clean frame in the capture`);

        for (const frame of frames) {
            const found = identifyFrame(frame);
            assert.notEqual(found, null,
                `${capture.label}: ${frame.join('')} — ${describeFrame(frame)}`);

            // Bit 24 as recorded agrees with even parity on every frame of this
            // handset — which is why computing it costs nothing here, and why 33
            // recordings cannot tell parity from a constant zero.
            assert.equal(found.parityOk, true, `${capture.label}: ${describeFrame(frame)}`);
        }
    }
});

test('buildFrame reproduces the frames the handset actually sent', { skip }, () => {
    // The decisive check. What the app will transmit is bit-for-bit what was
    // recorded off the handset, for every command it can send — including the
    // parity bit, which is computed here and was recorded as 0.
    const covered = new Set();

    for (const capture of allCaptures()) {
        for (const frame of cleanFrames(capture)) {
            const { address, key, bit24 } = identifyFrame(frame);
            covered.add(key);

            // With bit 24 as the handset sent it — which is what the app learns
            // at pair time and transmits, now that the bit is known not to be
            // computable.
            assert.deepEqual(buildFrame(address, key, bit24), frame, `${capture.label}: ${key}`);

            // And without it, which is what a device paired before that field
            // existed still transmits. Identical here, because this handset's
            // bit 24 is 0 and its frames are of even weight — the coincidence
            // that let the parity rule stand for as long as it did.
            assert.deepEqual(buildFrame(address, key), frame, `${capture.label}: ${key} (fallback)`);
        }
    }

    assert.deepEqual([...covered].sort(), [...COMMAND_KEYS].sort(),
        'every command in the table is recorded, and every recording is in the table');
});

test('each capture decodes to the command its label names', { skip }, () => {
    for (const capture of allCaptures()) {
        const keys = new Set(cleanFrames(capture).map(frame => identifyFrame(frame).key));
        const want = expectedKey(capture.label);

        if (want === null) {
            assert.ok(AMBIGUOUS.has(capture.label),
                `capture label "${capture.label}" names no command and is not listed as ambiguous`);
            continue;
        }

        assert.deepEqual([...keys], [want], `${capture.label} decoded as ${[...keys].join(', ')}`);
    }
});

test('every capture carries the same address', { skip }, () => {
    // One handset, so one address — and the evidence that bits 0-15 are an
    // address at all rather than part of the command.
    const addresses = new Set();
    for (const capture of allCaptures()) {
        for (const frame of cleanFrames(capture)) {
            addresses.add(frame.slice(0, ADDRESS_LENGTH).join(''));
        }
    }
    assert.equal(addresses.size, 1, `expected one handset address, got ${addresses.size}`);
});

test('the timer walks cancel, 2h, 4h, 8h and back to cancel', { skip }, () => {
    // One capture caught five presses and closed the cycle, which is what fixed
    // the mapping of the walking zero in bits 20-23. The order the frames went
    // out is the whole of that evidence, and it is lost in any ranking by count.
    const cycle = allCaptures().find(c => c.label === 'Timer off/cancel');
    assert.ok(cycle, 'the capture that closes the timer cycle is present');

    const pressed = [];
    for (const frame of cleanFrames(cycle)) {
        const { key } = identifyFrame(frame);
        if (pressed[pressed.length - 1] !== key) pressed.push(key);
    }

    assert.deepEqual(pressed, [
        'fan.timer.off', 'fan.timer.2h', 'fan.timer.4h', 'fan.timer.8h', 'fan.timer.off',
    ]);
});

test('the light and the fan are told apart only by the selector', { skip }, () => {
    // light.dimmer and fan.speed.3 share their command field, so a capture of
    // each is the evidence that the selector is a real field rather than a
    // coincidence of the four fan buttons that first suggested one.
    const keyed = label => {
        const capture = allCaptures().find(c => c.label === label);
        assert.ok(capture, `${label} is present`);
        return cleanFrames(capture).map(frame => identifyFrame(frame));
    };

    const dim = keyed('Light Brightness Down')[0];
    const speed = keyed('Fan speed step 3')[0];

    assert.equal(dim.key, 'light.dimmer');
    assert.equal(speed.key, 'fan.speed.3');
    assert.deepEqual(
        buildFrame(dim.address, dim.key).slice(ADDRESS_LENGTH + 2),
        buildFrame(speed.address, speed.key).slice(ADDRESS_LENGTH + 2),
        'the two share everything below the selector',
    );
});
