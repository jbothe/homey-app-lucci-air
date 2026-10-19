'use strict';

// Lucci ceiling-fan handset. See RF_PROTOCOL.md for how this was decoded, and
// APP_PLAN.md for what it allows the app to offer.
//
// Every frame is 25 bits behind a 19-duration preamble, in four fields:
//
//   [ 0..15  ] address   identifies the handset, identical across every button
//   [ 16..17 ] selector  10 for the fan, 01 for the light. Never 00 or 11
//   [ 18..23 ] command   which button, and for most of them which value
//   [ 24     ] parity    even parity over bits 0-23
//
// A device stores its address once at pair time and transmits
// address + selector + command + parity for each action.
//
// Both drivers share this module, because the selector means one handset drives
// two devices: the address a fan is paired with is the same address its light
// answers to.

// One signal definition serves both directions: the properties that differ
// between transmitting and receiving (repetitions, sensitivity, rxTimeout) only
// affect one direction each, so there is no need to split them.
const SIGNAL_ID = 'lucci';

const ADDRESS_LENGTH = 16;
const SELECTOR_LENGTH = 2;
const COMMAND_LENGTH = 6;

// Everything the parity bit is computed over: the three fields above it.
const HEAD_LENGTH = ADDRESS_LENGTH + SELECTOR_LENGTH + COMMAND_LENGTH;
const FRAME_LENGTH = HEAD_LENGTH + 1;

// What Homey hands back on receive, as well as the 25 that go out.
//
// **Observed on the radio, and not what was predicted.** The allowance for 24
// was insurance against the sibling Bear handset's behaviour, where the receiver
// never closes the final word and drops it. This handset truncates at the other
// end: the first frame of a burst arrives one symbol short of the FRONT, its
// leading bit lost while the receiver's gain is still settling — the same
// artefact the recorder shows at the start of a capture (see "What the recorder
// does to the signal" in RF_PROTOCOL.md). completeFrame restores it.
const RX_FRAME_LENGTH = HEAD_LENGTH;

// Bits 16-17. Which device within the handset, and the only thing telling the
// light's "dimmer" apart from fan speed step 3 — they share a command field.
const SELECTORS = {
    fan: [1, 0],
    light: [0, 1],
};

// The sixteen commands, as a literal table.
//
// **Nothing here is synthesised, and nothing can be.** The rule generating bits
// 18-23 is not derived: as integers the six speed codes are 1, 2, 7, 11, 13 and
// 16 — monotonic with speed, but no counter and no rule six samples can settle.
// A seventeenth command cannot be computed, only captured. See "Adding a
// command" in RF_PROTOCOL.md.
//
// `value` is what the capability holds, so the enum ids in
// .homeycompose/capabilities and the keys below are the same strings.
const COMMANDS = [
    // Fan — selector 10.
    { domain: 'fan', command: 'off', value: null, bits: [1, 0, 1, 0, 1, 0] },

    // Absolute: the handset tracks the step and sends the one it is moving to,
    // which is why Homey can command a speed and then know what the fan is on.
    { domain: 'fan', command: 'speed', value: '0', bits: [0, 0, 0, 0, 0, 1] },
    { domain: 'fan', command: 'speed', value: '1', bits: [0, 0, 0, 0, 1, 0] },
    { domain: 'fan', command: 'speed', value: '2', bits: [0, 0, 0, 1, 1, 1] },
    { domain: 'fan', command: 'speed', value: '3', bits: [0, 0, 1, 0, 1, 1] },
    { domain: 'fan', command: 'speed', value: '4', bits: [0, 0, 1, 1, 0, 1] },
    { domain: 'fan', command: 'speed', value: '5', bits: [0, 1, 0, 0, 0, 0] },

    // Absolute, settled the same way: two presses taking the fan forward to
    // reverse were bit-identical, and the one going the other way differed.
    { domain: 'fan', command: 'direction', value: 'forward', bits: [1, 0, 0, 0, 1, 1] },
    { domain: 'fan', command: 'direction', value: 'reverse', bits: [1, 0, 0, 0, 0, 0] },

    // Absolute. A walking zero across bits 20-23, cycling cancel → 2h → 4h → 8h.
    { domain: 'fan', command: 'timer', value: 'off', bits: [1, 1, 0, 1, 1, 1] },
    { domain: 'fan', command: 'timer', value: '2h', bits: [1, 1, 1, 0, 1, 1] },
    { domain: 'fan', command: 'timer', value: '4h', bits: [1, 1, 1, 1, 0, 1] },
    { domain: 'fan', command: 'timer', value: '8h', bits: [1, 1, 1, 1, 1, 0] },

    // Light — selector 01.
    { domain: 'light', command: 'onoff', value: null, bits: [0, 0, 0, 1, 0, 0] },

    // Relative, and the exception to everything above: one code each way at any
    // level, because the fitting holds the brightness and the handset does not.
    { domain: 'light', command: 'brighter', value: null, bits: [0, 0, 1, 0, 0, 0] },
    { domain: 'light', command: 'dimmer', value: null, bits: [0, 0, 1, 0, 1, 1] },
];

// A command's name throughout the app: "fan.off", "fan.speed.3", "light.dimmer".
const keyOf = ({ domain, command, value }) => (value === null
    ? `${domain}.${command}`
    : `${domain}.${command}.${value}`);

// The enum values each capability offers, in order, taken from the table rather
// than written out again — a code missing here would otherwise show up as a
// picker entry that silently does nothing.
const valuesOf = (domain, command) => COMMANDS
    .filter(c => c.domain === domain && c.command === command)
    .map(c => c.value);

const FAN_SPEEDS = valuesOf('fan', 'speed');
const FAN_DIRECTIONS = valuesOf('fan', 'direction');
const FAN_TIMERS = valuesOf('fan', 'timer');

const COMMAND_KEYS = COMMANDS.map(keyOf);
const COMMAND_BY_KEY = new Map(COMMANDS.map(c => [keyOf(c), c]));

// Keyed by the 8-bit tail — selector and command together — which is how a
// received frame is named. The light's dimmer and fan speed step 3 share their
// command field and are distinct only here.
const COMMAND_BY_TAIL = new Map(COMMANDS.map(c => [[...SELECTORS[c.domain], ...c.bits].join(''), c]));

const DOMAIN_BY_SELECTOR = new Map(Object.entries(SELECTORS).map(([domain, bits]) => [bits.join(''), domain]));

const isBit = value => value === 0 || value === 1;

// Stands in for a symbol that never arrived, so a truncated frame can still be
// laid out and read. It is never transmitted and never trusted: whichever end
// was lost, the field it belonged to is reported as unknown.
const PLACEHOLDER = 0;

// Bit 24: even parity over the preceding 24.
//
// **Computed, never copied.** The bit is 0 in all sixteen recorded codes, and
// bits 0-23 hold an even number of ones in all sixteen, so 33 recordings cannot
// separate even parity from a constant zero — it would take a command whose
// first 24 bits are odd, and this handset has none. But the app learns whichever
// address the user's handset has, and an address of odd weight would need the
// bit set. On this handset computing it yields 0 throughout, bit-for-bit what
// was recorded, so it costs nothing here and is likelier to be right elsewhere.
const evenParity = bits => bits.reduce((parity, bit) => parity ^ bit, 0);

// Builds the frame to transmit for one command from one handset address.
//
// `bit24` is **required**, and is what that handset was heard to send there.
// There is nothing to fall back on: the bit is neither even parity over the
// preceding 24 nor a constant — frames arrived in thousands with even weight
// across bits 0-23 and bit 24 set, which rules out both (see "Bit 24" in
// RF_PROTOCOL.md) — so a frame built without it would be a guess on the air.
// Refusing is better: a device that cannot transmit says so, where a device
// transmitting a guessed bit looks fine and may drive nothing.
function buildFrame(address, key, bit24) {
    if (!Array.isArray(address) || address.length !== ADDRESS_LENGTH || !address.every(isBit)) {
        throw new Error(`Bad address: ${JSON.stringify(address)}`);
    }

    const command = COMMAND_BY_KEY.get(key);
    if (command === undefined) {
        // An unknown key would otherwise spread `undefined` into the payload and
        // fail deep inside tx() with nothing to point at.
        throw new Error(`Unknown command: ${key}`);
    }
    if (!isBit(bit24)) {
        throw new Error(`Bad bit 24: ${JSON.stringify(bit24)}`);
    }

    return [...address, ...SELECTORS[command.domain], ...command.bits, bit24];
}

// Restores the symbol missing from a 24-symbol frame, or null when neither
// reading gives a frame we know.
//
// Two things can be missing, and they are told apart by trying each: this
// receiver drops the LEADING bit of a burst's first frame, while the sibling
// Bear handset's drops the trailing one. The leading case is tried first,
// because it is the one actually observed here.
//
// **Neither truncation is fully recoverable, and they lose opposite ends.**
//
// The leading case loses address bit 0 and keeps bit 24, which arrives last. For
// a while that bit 0 was recoverable exactly — `R = F[1..24]`, so
// `F[0] = R[23] XOR (R[0] ... R[22])` — and it rested entirely on bit 24 being
// parity, which the radio disproved. So bit 0 is filled with a placeholder and
// the frame is marked `addressSure: false`; the guess is not even attempted,
// because it would be a coin toss and because the command field, which is what
// such a frame is still good for naming in a log, does not depend on bit 0.
//
// The trailing case is the mirror: the address arrived whole, so the frame can
// say whose it is, and bit 24 is exactly what went missing.
function completeFrame(payload) {
    const known = frame => {
        const tail = frame.slice(ADDRESS_LENGTH, HEAD_LENGTH).join('');
        return COMMAND_BY_TAIL.has(tail) ? frame : null;
    };

    const front = known([PLACEHOLDER, ...payload]);
    if (front !== null) return { frame: front, addressSure: false, bit24Heard: true };

    const back = known([...payload, PLACEHOLDER]);
    return back === null ? null : { frame: back, addressSure: true, bit24Heard: false };
}

// Identifies a received frame, accepting both the 25 bits that go out and the 24
// Homey hands back. Returns { address, domain, command, value, key, parityOk }
// when the selector is one of the two and the command tail is one of the sixteen,
// otherwise null.
//
// That structural check is what keeps pairing from latching onto an unrelated
// 433 MHz device that happens to fit these timings: 24 or 25 symbols, a selector
// of 10 or 01, and one of the sixteen known tails.
//
// **Parity is reported, not enforced.** Transmitting computes bit 24 as even
// parity, because that is the likelier rule and costs nothing on this handset
// (see buildFrame). But the rule is unresolved, and a handset whose address has
// odd weight is exactly where the two candidates differ — so rejecting a
// mismatch here would make such a handset impossible to pair, and would say so
// as "couldn't find your handset". Accepting it instead keeps the app working
// whichever rule holds, and `parityOk` false is the one piece of evidence that
// would settle the question: it means bit 24 is a constant zero rather than
// parity. The driver logs it. Nothing else turns on it, because parity adds a
// single bit of discrimination to the checks above.
//
// `restored` says a symbol was missing, which pairing cares about: it is the one
// caller with nothing stored to check the result against, and it needs both the
// whole address and bit 24.
function identifyFrame(payload) {
    if (!Array.isArray(payload)) return null;
    if (payload.length !== FRAME_LENGTH && payload.length !== RX_FRAME_LENGTH) return null;
    if (!payload.every(isBit)) return null;

    const completed = payload.length === RX_FRAME_LENGTH
        ? completeFrame(payload)
        : { frame: payload, addressSure: true, bit24Heard: true };
    if (completed === null) return null;
    const { frame, addressSure, bit24Heard } = completed;

    const head = frame.slice(0, HEAD_LENGTH);
    const domain = DOMAIN_BY_SELECTOR.get(head.slice(ADDRESS_LENGTH, ADDRESS_LENGTH + SELECTOR_LENGTH).join(''));
    if (domain === undefined) return null;

    const command = COMMAND_BY_TAIL.get(head.slice(ADDRESS_LENGTH).join(''));
    if (command === undefined) return null;

    return {
        address: head.slice(0, ADDRESS_LENGTH),
        domain,
        command: command.command,
        value: command.value,
        key: keyOf(command),
        restored: payload.length === RX_FRAME_LENGTH,
        // False when a bit of the address was guessed rather than heard. Every
        // caller that decides whose frame this is has to check it.
        addressSure,
        // Bit 24 as it arrived, or null when it did not. **This is the field to
        // transmit back**, rather than any rule computed from the rest: the bit
        // is not parity and not a constant, so the only sound source for it is
        // the handset that sent it. See "Bit 24" in RF_PROTOCOL.md.
        bit24: bit24Heard ? frame[HEAD_LENGTH] : null,
    };
}

// A short account of why a frame was not identified, for the log. Naming the
// field that failed is what separates an unimplemented button from noise, and
// from a decoding bug, without decoding the bits by hand — and the driver logs
// every payload it cannot identify, because that one line is the difference
// between "no frames arriving" and "frames arriving and not decoding".
function describeFrame(payload) {
    if (!Array.isArray(payload)) return 'not an array';
    if (payload.length !== FRAME_LENGTH && payload.length !== RX_FRAME_LENGTH) {
        return `${payload.length} symbols, expected ${RX_FRAME_LENGTH} or ${FRAME_LENGTH}`;
    }
    if (!payload.every(isBit)) return 'not bits';

    const completed = payload.length === RX_FRAME_LENGTH
        ? completeFrame(payload)
        : { frame: payload, addressSure: true };
    if (completed === null) return `${payload.length} symbols, no reading of which is a command we know`;
    const { frame } = completed;

    const head = frame.slice(0, HEAD_LENGTH);
    const selector = head.slice(ADDRESS_LENGTH, ADDRESS_LENGTH + SELECTOR_LENGTH);
    const tail = head.slice(ADDRESS_LENGTH);
    const domain = DOMAIN_BY_SELECTOR.get(selector.join(''));

    if (domain === undefined) return `selector ${selector.join('')} is neither fan (10) nor light (01)`;

    const command = COMMAND_BY_TAIL.get(tail.join(''));
    if (command === undefined) return `${domain}, unimplemented command ${tail.slice(SELECTOR_LENGTH).join('')}`;

    if (payload.length === RX_FRAME_LENGTH) {
        const lost = completed.addressSure ? 'bit 24' : 'its leading address bit';
        return `${keyOf(command)} (24 symbols, missing ${lost})`;
    }

    return keyOf(command);
}

// Whether a received frame came from a given handset, so one household's remote
// can't drive another's fan.
function sameAddress(a, b) {
    return Array.isArray(a)
        && Array.isArray(b)
        && a.length === b.length
        && a.every((bit, i) => bit === b[i]);
}

module.exports = {
    SIGNAL_ID,
    ADDRESS_LENGTH,
    SELECTOR_LENGTH,
    COMMAND_LENGTH,
    HEAD_LENGTH,
    FRAME_LENGTH,
    RX_FRAME_LENGTH,
    SELECTORS,
    COMMANDS,
    COMMAND_KEYS,
    FAN_SPEEDS,
    FAN_DIRECTIONS,
    FAN_TIMERS,
    evenParity,
    completeFrame,
    buildFrame,
    identifyFrame,
    describeFrame,
    sameAddress,
};
