'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ADDRESS_LENGTH, HEAD_LENGTH, FRAME_LENGTH, RX_FRAME_LENGTH,
    COMMANDS, COMMAND_KEYS, FAN_SPEEDS, FAN_DIRECTIONS, FAN_TIMERS,
    evenParity, completeFrame, buildFrame, identifyFrame, describeFrame, sameAddress,
} = require('../lib/lucci-protocol');

// captures.test.js holds the table against the recordings. This file covers
// what one handset's recordings cannot: an address of odd weight, frames the
// handset never sends, and the lengths Homey may hand back.

// The handset the protocol was decoded from. Even weight, like every one of its
// sixteen frames.
const HANDSET = '0101110011110011'.split('').map(Number);

// An address with an odd number of ones, which this handset does not have and
// no recording can therefore exercise. Every command from it needs bit 24 set.
const ODD = '0101110011110001'.split('').map(Number);

test('the table holds all sixteen commands, and no two share a code', () => {
    assert.equal(COMMANDS.length, 16);
    assert.equal(COMMAND_KEYS.length, 16);
    assert.equal(new Set(COMMAND_KEYS).size, 16, 'keys are unique');

    const tails = COMMAND_KEYS.map(key => buildFrame(HANDSET, key)
        .slice(ADDRESS_LENGTH, HEAD_LENGTH).join(''));
    assert.equal(new Set(tails).size, 16, 'selector and command together are unique');
});

test('the capability values come from the table', () => {
    // A picker offering a value the table has no code for would look like a
    // working control and do nothing.
    assert.deepEqual(FAN_SPEEDS, ['0', '1', '2', '3', '4', '5']);
    assert.deepEqual(FAN_DIRECTIONS, ['forward', 'reverse']);
    assert.deepEqual(FAN_TIMERS, ['off', '2h', '4h', '8h']);
});

test('a frame is the address, then the 9-bit tail', () => {
    const frame = buildFrame(HANDSET, 'fan.speed.3');

    assert.equal(frame.length, FRAME_LENGTH);
    assert.deepEqual(frame.slice(0, ADDRESS_LENGTH), HANDSET);
    assert.equal(frame.slice(ADDRESS_LENGTH).join(''), '100010110');
});

test('bit 24 is computed, so an odd-weight address sets it', () => {
    // The whole reason the bit is computed rather than copied. On this handset
    // every command comes out with it clear — bit-for-bit what was recorded —
    // and on a handset whose address has odd weight every command needs it set.
    // 33 recordings cannot separate even parity from a constant zero; this is
    // the behaviour that would differ if the choice were wrong.
    for (const key of COMMAND_KEYS) {
        assert.equal(buildFrame(HANDSET, key)[HEAD_LENGTH], 0, `${key} from an even address`);
        assert.equal(buildFrame(ODD, key)[HEAD_LENGTH], 1, `${key} from an odd address`);
    }

    assert.equal(evenParity([]), 0);
    assert.equal(evenParity([1, 1, 0]), 0);
    assert.equal(evenParity([1, 1, 1]), 1);
});

test('every built frame identifies back to the command that built it', () => {
    for (const key of COMMAND_KEYS) {
        for (const address of [HANDSET, ODD]) {
            const frame = buildFrame(address, key);
            const found = identifyFrame(frame);

            assert.notEqual(found, null, `${key} did not identify`);
            assert.equal(found.key, key);
            assert.deepEqual(found.address, address);
            assert.equal(describeFrame(frame), key);
        }
    }
});

test('identifyFrame names the field as well as the command', () => {
    const light = identifyFrame(buildFrame(HANDSET, 'light.dimmer'));
    assert.deepEqual(light, {
        address: HANDSET, domain: 'light', command: 'dimmer', value: null, key: 'light.dimmer',
        parityOk: true, restored: false, addressSure: true,
    });

    const speed = identifyFrame(buildFrame(HANDSET, 'fan.speed.4'));
    assert.deepEqual(speed, {
        address: HANDSET, domain: 'fan', command: 'speed', value: '4', key: 'fan.speed.4',
        parityOk: true, restored: false, addressSure: true,
    });
});

// The frame Homey's receiver actually delivered, taken from the log of the first
// time this app ever heard the handset. The press was Fan Off, from the handset
// the recordings came from, and it arrived one symbol short of the FRONT —
// 38ms before a full 25-symbol frame of the same press.
//
// It is here because it is the one payload in this file that no part of this app
// produced. It was also what found the bug it now guards: the 24-symbol
// allowance was written for the sibling Bear handset's receiver, which drops the
// TRAILING bit, so this frame was read as a light command that does not exist
// and logged as unrecognised.
const FROM_THE_RADIO = '101110011110011101010100'.split('').map(Number);

test('the frame the radio actually delivered reads as the button that was pressed', () => {
    assert.equal(FROM_THE_RADIO.length, RX_FRAME_LENGTH);

    const found = identifyFrame(FROM_THE_RADIO);
    assert.notEqual(found, null, 'the payload observed on air does not identify');
    assert.equal(found.key, 'fan.off');
    assert.deepEqual(found.address, HANDSET, 'the restored bit is address bit 0');

    // The restored frame is bit-for-bit the frame the app would transmit for
    // that button — which is the strongest statement available that the leading
    // bit was recovered correctly rather than merely plausibly.
    // The restored frame happens to come out bit-for-bit right, because this
    // transmitter's bit 24 is 0 and the guess below therefore lands. That is a
    // coincidence of this handset, not a rule — see the parity test below.
    assert.deepEqual(completeFrame(FROM_THE_RADIO).frame, buildFrame(HANDSET, 'fan.off'));
    assert.match(describeFrame(FROM_THE_RADIO), /^fan\.off \(24 symbols, one restored\)/);

    // **But address bit 0 was guessed, not heard**, so the frame cannot say
    // whose it is. Every caller that decides identity has to refuse it.
    assert.equal(found.restored, true);
    assert.equal(found.addressSure, false);
    assert.equal(identifyFrame(buildFrame(HANDSET, 'fan.off')).addressSure, true);
});

test('a leading bit lost names the command but cannot vouch for the address', () => {
    // The command field is present in full, so the frame is still worth naming
    // in a log. Address bit 0 is not: it was dropped, and bit 24 — which used to
    // recover it exactly — is not parity, so what comes out is a guess.
    for (const key of COMMAND_KEYS) {
        for (const address of [HANDSET, ODD]) {
            const found = identifyFrame(buildFrame(address, key).slice(1));

            assert.notEqual(found, null, `${key} did not identify with its leading bit lost`);
            assert.equal(found.key, key);
            assert.equal(found.addressSure, false, `${key} vouched for a guessed address`);
        }
    }
});

test('a trailing bit lost vouches for the address, having heard all of it', () => {
    // The difference that matters between the two truncations: here only bit 24
    // is missing, and the app uses nothing it carries, so the address arrived
    // whole and the frame identifies as firmly as a full-length one.
    for (const key of COMMAND_KEYS) {
        const whole = buildFrame(HANDSET, key);
        const found = identifyFrame(whole.slice(0, RX_FRAME_LENGTH));

        assert.equal(found.addressSure, true, key);
        assert.deepEqual(found.address, HANDSET, key);
    }
});

test('bit 24 is not parity, and the app no longer pretends otherwise', () => {
    // Settled on the radio, against the hypothesis. Frames arrived in thousands
    // with an even number of ones across bits 0-23 and bit 24 set — which even
    // parity forbids, and which the constant zero of all 33 recordings forbids
    // too. identifyFrame reports the disagreement and acts on the frame anyway,
    // which is the decision that kept the app working through the discovery.
    const whole = buildFrame(HANDSET, 'fan.speed.5');
    const asHeard = [...whole.slice(0, HEAD_LENGTH), 1];

    assert.equal(evenParity(asHeard.slice(0, HEAD_LENGTH)), 0, 'bits 0-23 are even');
    assert.equal(asHeard[HEAD_LENGTH], 1, 'and bit 24 is set anyway');

    const found = identifyFrame(asHeard);
    assert.notEqual(found, null, 'a frame was rejected for a bit the app cannot explain');
    assert.equal(found.key, 'fan.speed.5');
    assert.equal(found.parityOk, false);
    assert.equal(found.addressSure, true, 'nothing about this address was guessed');
});

test('a trailing bit lost is recovered too, as the sibling handset needs', () => {
    // Kept as insurance rather than as an observation: this receiver truncates
    // at the front, the Bear one at the back. Nothing is lost by reading both,
    // and requiring the full length there made that app completely deaf while
    // looking like a radio fault.
    for (const key of COMMAND_KEYS) {
        const whole = buildFrame(ODD, key);
        const short = whole.slice(0, RX_FRAME_LENGTH);

        const found = identifyFrame(short);
        assert.notEqual(found, null, `${key} did not identify with its trailing bit lost`);
        assert.equal(found.key, key);
        assert.deepEqual(buildFrame(found.address, found.key), whole);
    }
});

test('a frame whose parity is wrong is reported, not rejected', () => {
    // Rejecting it would make a handset whose address has odd weight impossible
    // to pair — and that is exactly the handset on which even parity and a
    // constant zero differ, so it is the one case where the unresolved bit
    // matters. A frame like this is evidence that bit 24 is a constant zero, and
    // the driver logs it; it is not evidence that the frame belongs to someone
    // else, which is what the length, selector and tail are for.
    const frame = buildFrame(ODD, 'fan.off');
    const flipped = [...frame.slice(0, HEAD_LENGTH), frame[HEAD_LENGTH] ^ 1];

    const found = identifyFrame(flipped);
    assert.notEqual(found, null);
    assert.equal(found.key, 'fan.off');
    assert.equal(found.parityOk, false);
    assert.match(describeFrame(flipped), /parity 0 where 1 was expected/);

    // And a frame that does agree says so, while a short one cannot.
    assert.equal(identifyFrame(frame).parityOk, true);
    assert.equal(identifyFrame(frame.slice(0, RX_FRAME_LENGTH)).parityOk, null);
});

test('an unrelated 433 MHz frame is not mistaken for the handset', () => {
    // The length, the selector and the command tail all have to fit. These are
    // full-length frames, which are read exactly as they arrive — see the test
    // below for how much weaker this gets at 24 symbols.
    const frame = (selector, command) => {
        const head = [...HANDSET, ...selector, ...command];
        return [...head, evenParity(head)];
    };
    const wrongLength = buildFrame(HANDSET, 'fan.off').slice(0, 20);

    for (const payload of [null, undefined, 'fan.off', [], wrongLength]) {
        assert.equal(identifyFrame(payload), null);
    }

    // 00 and 11 were never seen, and a frame carrying either is not ours.
    for (const selector of [[0, 0], [1, 1]]) {
        const bad = frame(selector, [0, 0, 0, 1, 0, 0]);
        assert.equal(identifyFrame(bad), null);
        assert.match(describeFrame(bad), /neither fan \(10\) nor light \(01\)/);
    }

    // A selector we know with a command we do not: the seventeenth button,
    // which cannot be synthesised and so cannot be sent either.
    const unknown = frame([1, 0], [1, 1, 1, 1, 1, 1]);
    assert.equal(identifyFrame(unknown), null);
    assert.match(describeFrame(unknown), /fan, unimplemented command 111111/);

    assert.equal(describeFrame([...HANDSET, 1, 0, 2, 0, 0, 0, 0, 0, 0]), 'not bits');
    assert.match(describeFrame(wrongLength), /20 symbols, expected 24 or 25/);
});

test('a 24-symbol frame is read by shifting, which discriminates less', () => {
    // Worth stating rather than discovering. A short frame has to be completed
    // before it can be read, and both completions are tried, so two 8-bit
    // windows are each held against the sixteen known tails instead of one.
    // Some bit patterns that are not ours therefore read as ours — this one is a
    // selector of 00, which at full length is rejected outright.
    const notOurs = [...HANDSET, 0, 0, 0, 0, 0, 1, 0, 0];
    assert.equal(notOurs.length, RX_FRAME_LENGTH);

    const found = identifyFrame(notOurs);
    assert.notEqual(found, null, 'shifts into a valid frame');
    assert.equal(found.key, 'fan.speed.1');
    // And into a different address, which is what actually protects a paired
    // device: sameAddress rejects it.
    assert.equal(sameAddress(found.address, HANDSET), false);

    // What keeps this from mattering is upstream of the bits: a payload reaches
    // identifyFrame at all only after matching the signal's preamble, both
    // symbol windows at 0.2 tolerance, the interval and the length. The bit
    // check is the last filter, not the only one.
});

test('buildFrame refuses what it cannot build rather than sending nonsense', () => {
    // An unknown key or a missing address would otherwise spread `undefined`
    // into the payload and fail deep inside tx() with nothing to point at.
    assert.throws(() => buildFrame(HANDSET, 'fan.speed.6'), /Unknown command: fan\.speed\.6/);
    assert.throws(() => buildFrame(HANDSET, 'fan.on'), /Unknown command: fan\.on/);
    assert.throws(() => buildFrame(HANDSET, undefined), /Unknown command/);
    assert.throws(() => buildFrame(HANDSET.slice(1), 'fan.off'), /Bad address/);
    assert.throws(() => buildFrame(null, 'fan.off'), /Bad address/);
    assert.throws(() => buildFrame(HANDSET.map(() => 2), 'fan.off'), /Bad address/);
});

test('sameAddress tells one household\'s handset from another\'s', () => {
    assert.equal(sameAddress(HANDSET, [...HANDSET]), true);
    assert.equal(sameAddress(HANDSET, ODD), false);
    assert.equal(sameAddress(HANDSET, HANDSET.slice(1)), false);
    assert.equal(sameAddress(HANDSET, null), false);
    assert.equal(sameAddress(undefined, undefined), false);
});
