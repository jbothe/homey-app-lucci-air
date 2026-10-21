'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const p = require('../lib/cr2032-protocol');
const signal = require('../.homeycompose/signals/433/lucci_cr2032.json');
const speedCapability = require('../.homeycompose/capabilities/lucci_speed.json');
const { parseCaptures } = require('../tools/pulses');
const { analyseRemote } = require('../tools/cr2032');
const { check } = require('../tools/signal');
const { PRESS_AIRTIME: USB_C_AIRTIME } = require('../lib/press-queue');

// An invented remote. The real address and tail are not committed: they drive
// a fan.
const ADDRESS = '1100010100101110'.split('').map(Number);
const TAIL = [1, 0];

const frameFor = key => p.buildFrame(ADDRESS, key, TAIL);

test('a frame is the address, the command and the tail, in that order', () => {
    const frame = frameFor('fan.off');

    assert.equal(frame.length, p.FRAME_LENGTH);
    assert.deepEqual(frame.slice(0, 16), ADDRESS);
    assert.deepEqual(frame.slice(16, 22), [1, 1, 0, 1, 1, 1]);
    assert.deepEqual(frame.slice(22), TAIL);
});

test('every command has a distinct code', () => {
    const codes = p.COMMANDS.map(c => c.bits.join(''));
    assert.equal(new Set(codes).size, codes.length);
    assert.equal(new Set(p.COMMAND_KEYS).size, p.COMMAND_KEYS.length);
    assert.ok(p.COMMANDS.every(c => c.bits.length === p.COMMAND_LENGTH));

    // Nine buttons on the remote: off, six speeds, reverse, light.
    assert.equal(p.COMMANDS.length, 9);
});

test('the speed buttons are the capability\'s six steps, in order', () => {
    assert.deepEqual(p.FAN_SPEEDS, speedCapability.values.map(v => v.id));
    assert.deepEqual(p.FAN_SPEEDS, ['0', '1', '2', '3', '4', '5']);
});

test('buildFrame refuses what would be a guess on the air', () => {
    assert.throws(() => p.buildFrame(ADDRESS.slice(1), 'fan.off', TAIL), /Bad address/);
    assert.throws(() => p.buildFrame(ADDRESS, 'fan.timer.2h', TAIL), /Unknown command/);
    assert.throws(() => p.buildFrame(ADDRESS, 'fan.off'), /Bad tail/);
    assert.throws(() => p.buildFrame(ADDRESS, 'fan.off', [1]), /Bad tail/);
    assert.throws(() => p.buildFrame(ADDRESS, 'fan.off', [1, 2]), /Bad tail/);
});

test('every command reads back as what was sent, with its tail intact', () => {
    for (const key of p.COMMAND_KEYS) {
        const frame = p.identifyFrame(frameFor(key));

        assert.equal(frame.key, key);
        assert.deepEqual(frame.address, ADDRESS);
        // The tail is whatever the remote sent, not a constant of the protocol.
        assert.deepEqual(frame.tail, TAIL);
        assert.equal(frame.addressSure, true);
        assert.equal(frame.restored, false);
    }
});

test('domains: the light toggle is the light, everything else is the fan', () => {
    const domainOf = key => p.identifyFrame(frameFor(key)).domain;
    assert.equal(domainOf('light.toggle'), 'light');
    for (const key of p.COMMAND_KEYS.filter(k => k !== 'light.toggle')) assert.equal(domainOf(key), 'fan');
});

test('a short frame is explained and never acted on', () => {
    const frame = frameFor('fan.off');

    // Either end gone: which one was lost is unknown, so neither is guessed.
    assert.equal(p.identifyFrame(frame.slice(1)), null);
    assert.equal(p.identifyFrame(frame.slice(0, -1)), null);
    assert.match(p.describeFrame(frame.slice(1)), /one short of 24/);
});

test('what is not one of the nine is not ours', () => {
    assert.equal(p.identifyFrame([...frameFor('fan.off'), 0]), null, 'too long');
    assert.equal(p.identifyFrame(null), null);
    assert.equal(p.identifyFrame(frameFor('fan.off').map(String)), null, 'not bits');

    // A command field that is none of the nine.
    const stray = [...ADDRESS, 0, 0, 0, 0, 0, 0, ...TAIL];
    assert.equal(p.identifyFrame(stray), null);
    assert.match(p.describeFrame(stray), /unimplemented command 000000/);

    assert.equal(p.describeFrame(frameFor('fan.speed.3')), 'fan.speed.3');
    assert.match(p.describeFrame([1, 0, 1]), /3 symbols, expected 24/);
});

test('another remote\'s tail is not rejected', () => {
    // Pairing has nothing stored to check a tail against, and another remote may
    // send something other than what this one does.
    for (const tail of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        assert.deepEqual(p.identifyFrame(p.buildFrame(ADDRESS, 'fan.off', tail)).tail, tail);
    }
});

test('sameAddress compares bit for bit', () => {
    assert.equal(p.sameAddress(ADDRESS, [...ADDRESS]), true);
    assert.equal(p.sameAddress(ADDRESS, ADDRESS.map((b, i) => (i === 15 ? 1 - b : b))), false);
    assert.equal(p.sameAddress(ADDRESS, null), false);
    assert.equal(p.sameAddress(ADDRESS, ADDRESS.slice(1)), false);
});

test('the airtime is what the signal definition actually transmits', () => {
    // Re-derived from the definition so the two cannot drift apart: a preamble
    // pulse, 24 bits, and the interval, repeated.
    const preamble = signal.sof.reduce((total, d) => total + d, 0);
    const perBit = signal.words.map(([a, b]) => a + b);
    assert.equal(perBit[0], perBit[1], 'both symbols run the same time, so a frame is 25.4ms whatever it carries');

    const frame = preamble + p.FRAME_LENGTH * perBit[0];
    const press = signal.repetitions * (frame + signal.interval);

    assert.equal(Math.round(press / 1000), p.PRESS_AIRTIME);
    assert.ok(p.PRESS_AIRTIME < USB_C_AIRTIME, 'a shorter press than the USB-C remote\'s, so its figure must not be reused');
});

// ---------------------------------------------------------------------------
// The check that ties the table back to the hardware: decode the recordings of
// the real remote and hold every command against them. Skipped, not failed, when
// the file is absent, so a fresh clone runs green - it is not committed, because
// it carries the code that drives the fan.

const CAPTURES = path.join(__dirname, '..', 'captures', 'fan2-cr2032.txt');

const KEY_OF = new Map([
    ['off', 'fan.off'],
    ['speedi', 'fan.speed.0'], ['speedii', 'fan.speed.1'], ['speediii', 'fan.speed.2'],
    ['speediv', 'fan.speed.3'], ['speedv', 'fan.speed.4'], ['speedvi', 'fan.speed.5'],
    ['reverse', 'fan.reverse'],
    ['light', 'light.toggle'],
]);

test('the command table reproduces every recording of the real remote', { skip: !fs.existsSync(CAPTURES) && 'captures/fan2-cr2032.txt is not present' }, () => {
    const analysis = analyseRemote(parseCaptures(fs.readFileSync(CAPTURES, 'utf8')));
    assert.equal(analysis.ok, true);

    const read = analysis.presses.filter(press => press.code !== null);
    assert.ok(read.length >= 9, `only ${read.length} readable presses`);

    // The address and tail are whatever the remote sent, taken from the first
    // press: the point is that the COMMAND bits in between come out of the table.
    const address = [...read[0].code.slice(0, 16)].map(Number);
    const tail = [...read[0].code.slice(22)].map(Number);

    for (const press of read) {
        const key = KEY_OF.get(press.button.toLowerCase().replace(/\s+/g, ''));
        assert.ok(key, `no command for the recorded button "${press.button}"`);
        assert.equal(p.buildFrame(address, key, tail).join(''), press.code, `${press.label}`);
    }

    // And all nine buttons were recorded, or the above proves less than it says.
    const seen = new Set(read.map(press => KEY_OF.get(press.button.toLowerCase().replace(/\s+/g, ''))));
    assert.deepEqual([...seen].sort(), [...p.COMMAND_KEYS].sort());
});

test('the shipped sensitivity keeps the recorded symbols apart', { skip: !fs.existsSync(CAPTURES) && 'captures/fan2-cr2032.txt is not present' }, () => {
    const analysis = analyseRemote(parseCaptures(fs.readFileSync(CAPTURES, 'utf8')));
    const verdict = check(analysis.alignment.alphabet, signal.sensitivity);

    assert.deepEqual(verdict.ambiguous, [], 'the two symbols overlap at this sensitivity');
    assert.deepEqual(verdict.excluded.map(s => s.index), [], 'a measured duration falls outside its symbol\'s window');
});
