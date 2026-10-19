'use strict';

// **THROWAWAY. Delete this file, and everything that references it, when the
// experiment is over.** See "The discrete on/off experiment" in RF_PROTOCOL.md.
//
// The light has one stateless toggle code and no discrete on or off, which is
// why Homey's `onoff` for it is a belief rather than a fact and drifts the first
// time anything changes the light that Homey cannot hear. The receiver's command
// field is six bits — 64 values — and exactly three of them are known under the
// light selector. Discrete on and off may well exist in the fitting's firmware
// with no handset button wired to them.
//
// This is a guess at where they would be, not a derivation. The encoding of bits
// 18-23 is not understood (RF_PROTOCOL.md says so, and still does), so nothing
// here is synthesised from a rule — these are six addresses in a space, probed
// one at a time by hand, with a person watching the light.
//
// It lives in its own file, away from lucci-protocol.js, so that module keeps
// its guarantee: it builds only the sixteen codes that were actually recorded,
// and refuses everything else. An experiment should not be able to borrow that
// module's authority.

const { ADDRESS_LENGTH, SELECTORS } = require('./lucci-protocol');

// Where to look, and why.
//
// The toggle is `000100`, which is 4. If the firmware has discrete on and off,
// the cheapest guess is that they sit beside it — a designer numbering light
// commands would plausibly put on, off and toggle together. So: everything
// within three of the toggle, except the toggle itself and zero.
//
// **Zero is deliberately excluded.** An all-zeros command field is the classic
// sentinel — null command, reset, enter-pairing — and it is the single value most
// likely to do something you cannot undo from the sofa. If the six below come
// back empty, zero is still there to try, with the fitting's recovery procedure
// to hand.
const PROBE_CODES = [1, 2, 3, 5, 6, 7];

const toBits = (value, width) => Array.from(
    { length: width }, (_, i) => (value >> (width - 1 - i)) & 1,
);

const probeBits = code => toBits(code, 6);
const probeLabel = code => `${probeBits(code).join('')} (${code})`;

// A frame for one probe code, under the light selector.
//
// Takes the address and bit 24 the device learned, so the frame is addressed to
// the user's own fitting and carries the bit that fitting expects — the probe is
// about the command field and nothing else.
function probeFrame(address, bit24, code) {
    if (!Array.isArray(address) || address.length !== ADDRESS_LENGTH) {
        throw new Error(`Bad address: ${JSON.stringify(address)}`);
    }
    if (bit24 !== 0 && bit24 !== 1) {
        throw new Error(`Bad bit 24: ${JSON.stringify(bit24)}`);
    }
    if (!PROBE_CODES.includes(code)) {
        throw new Error(`Not a probe code: ${JSON.stringify(code)}`);
    }

    return [...address, ...SELECTORS.light, ...probeBits(code), bit24];
}

module.exports = {
    PROBE_CODES,
    probeBits,
    probeLabel,
    probeFrame,
};
