'use strict';

// The Lucci Whitehaven "CR2032" remote, with its Rhine RH787NRN receiver. A
// different protocol from lucci-protocol.js's, not a variant of it. See
// RF_PROTOCOL_CR2032.md for how it was decoded and what is and is not verified.
//
// Every frame is 24 bits behind a ONE-pulse preamble:
//
//   [ 0..15  ] address  identical across every button recorded
//   [ 16..21 ] command  which button, a literal table below
//   [ 22..23 ] tail     `11` in all nine codes recorded
//
// **The tail is stored with the address, not assumed.** On the USB-C remote the
// 25th bit looked like parity or a constant on every test one handset allowed,
// and a second handset showed it was neither: it belonged to the handset. Whether
// either of these two does cannot be learned from one remote, so a device keeps
// whatever tail its remote was heard to send, exactly as the fan keeps bit 24.
//
// The words are in BIT order: index 0 is bit 0 (a long gap, then a short pulse)
// and index 1 is bit 1 (a short gap, then a long pulse). tools/pulses.js numbers
// them the other way round; tools/cr2032.js corrects it.

// A separate signal from the USB-C remote's: different preamble, timing and
// length, so the two never match each other's frames and never share a
// definition.
const SIGNAL_ID = 'lucci_cr2032';

const ADDRESS_LENGTH = 16;
const COMMAND_LENGTH = 6;
const TAIL_LENGTH = 2;

const HEAD_LENGTH = ADDRESS_LENGTH + COMMAND_LENGTH;
const FRAME_LENGTH = HEAD_LENGTH + TAIL_LENGTH;

// What the signal definition will deliver as a short frame, to be explained in
// the log and never acted on. The recorder loses the opening edge of a burst
// while the receiver's gain settles (lines of odd length open every capture), and
// Homey's receiver may do the same. Which end a 23-symbol frame lost is not
// known, so it cannot say whose it is, and nothing here guesses.
const SHORT_FRAME_LENGTH = FRAME_LENGTH - 1;

// Airtime of one press, in milliseconds: the signal definition's nine
// repetitions of a 348us preamble pulse, 24 bits at 1042us each, and the 10512us
// interval. test/cr2032-protocol.test.js re-derives it from the definition so the
// two cannot drift apart.
//
// **Hardware: OFF worked at 9 repetitions and not at 1, 2 or 5.** Nine is the
// verified count and the one used.
const PRESS_AIRTIME = 323;

// `value` is what the capability holds, so the enum ids in
// .homeycompose/capabilities and the keys below are the same strings. The six
// speed buttons are I to VI and map to the capability's steps 0 to 5.
//
// Reverse and light are TOGGLES: three presses of each sent the same code every
// time, so unlike the USB-C remote's direction there is no "go to reverse" and
// the app can only flip and keep a belief.
const COMMANDS = [
    { domain: 'fan', command: 'off', value: null, bits: [1, 1, 0, 1, 1, 1] },

    { domain: 'fan', command: 'speed', value: '0', bits: [0, 0, 1, 1, 1, 1] },
    { domain: 'fan', command: 'speed', value: '1', bits: [0, 1, 1, 0, 0, 1] },
    { domain: 'fan', command: 'speed', value: '2', bits: [1, 0, 1, 1, 1, 1] },
    { domain: 'fan', command: 'speed', value: '3', bits: [1, 0, 1, 0, 1, 1] },
    { domain: 'fan', command: 'speed', value: '4', bits: [0, 1, 1, 0, 1, 0] },
    { domain: 'fan', command: 'speed', value: '5', bits: [0, 1, 1, 1, 1, 1] },

    { domain: 'fan', command: 'reverse', value: null, bits: [0, 0, 1, 0, 1, 1] },

    { domain: 'light', command: 'toggle', value: null, bits: [1, 0, 0, 1, 1, 1] },
];

const keyOf = ({ domain, command, value }) => (value === null
    ? `${domain}.${command}`
    : `${domain}.${command}.${value}`);

const FAN_SPEEDS = COMMANDS.filter(c => c.command === 'speed').map(c => c.value);

const COMMAND_KEYS = COMMANDS.map(keyOf);
const COMMAND_BY_KEY = new Map(COMMANDS.map(c => [keyOf(c), c]));
const COMMAND_BY_BITS = new Map(COMMANDS.map(c => [c.bits.join(''), c]));

const isBit = value => value === 0 || value === 1;
const isBits = (value, length) => Array.isArray(value) && value.length === length && value.every(isBit);

// Builds the frame to transmit for one command from one remote's address and
// tail. Both are required: a frame built from a guessed tail is a guess on the
// air, and a device that cannot transmit says so where one transmitting a guess
// looks fine and may drive nothing.
function buildFrame(address, key, tail) {
    if (!isBits(address, ADDRESS_LENGTH)) throw new Error(`Bad address: ${JSON.stringify(address)}`);

    const command = COMMAND_BY_KEY.get(key);
    if (command === undefined) throw new Error(`Unknown command: ${key}`);
    if (!isBits(tail, TAIL_LENGTH)) throw new Error(`Bad tail: ${JSON.stringify(tail)}`);

    return [...address, ...command.bits, ...tail];
}

// Identifies a received frame, or returns null.
//
// Only a full 24 symbols is identified. A device acts on a frame only once it
// can say whose it is, and a 23-symbol frame has lost an unknown end: guessing
// the missing bit would be a coin toss on one address bit, which is the
// mistake the USB-C remote's receiver taught this app to stop making. The rest
// of a burst arrives in full, so nothing is lost by waiting for it.
//
// The command must be one of the nine known. That is the structural check that
// keeps pairing off unrelated 433 MHz traffic: the timings, the length and one
// of nine out of 64 command values. The tail is NOT checked against `11` -
// another remote may send something else, and a device keeps its own.
function identifyFrame(payload) {
    if (!isBits(payload, FRAME_LENGTH)) return null;

    const command = COMMAND_BY_BITS.get(payload.slice(ADDRESS_LENGTH, HEAD_LENGTH).join(''));
    if (command === undefined) return null;

    return {
        address: payload.slice(0, ADDRESS_LENGTH),
        tail: payload.slice(HEAD_LENGTH),
        domain: command.domain,
        command: command.command,
        value: command.value,
        key: keyOf(command),
        // The same shape as the USB-C remote's frames, so a caller can ask the
        // same questions of either: nothing here is ever reconstructed.
        restored: false,
        addressSure: true,
    };
}

// A short account of why a frame was not identified, for the log. The app logs
// every payload it cannot identify, because that one line separates "no frames
// arriving" from "frames arriving and not decoding".
function describeFrame(payload) {
    if (!Array.isArray(payload)) return 'not an array';
    if (payload.length === SHORT_FRAME_LENGTH) {
        return `${payload.length} symbols, one short of ${FRAME_LENGTH}: the start of a burst, with its opening edge lost`;
    }
    if (payload.length !== FRAME_LENGTH) return `${payload.length} symbols, expected ${FRAME_LENGTH}`;
    if (!payload.every(isBit)) return 'not bits';

    const command = COMMAND_BY_BITS.get(payload.slice(ADDRESS_LENGTH, HEAD_LENGTH).join(''));
    if (command === undefined) return `unimplemented command ${payload.slice(ADDRESS_LENGTH, HEAD_LENGTH).join('')}`;
    return keyOf(command);
}

function sameAddress(a, b) {
    return Array.isArray(a)
        && Array.isArray(b)
        && a.length === b.length
        && a.every((bit, i) => bit === b[i]);
}

module.exports = {
    SIGNAL_ID,
    ADDRESS_LENGTH,
    COMMAND_LENGTH,
    TAIL_LENGTH,
    HEAD_LENGTH,
    FRAME_LENGTH,
    SHORT_FRAME_LENGTH,
    PRESS_AIRTIME,
    COMMANDS,
    COMMAND_KEYS,
    FAN_SPEEDS,
    buildFrame,
    identifyFrame,
    describeFrame,
    sameAddress,
};
