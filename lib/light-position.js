'use strict';

// Where the light's brightness is, and how to get it somewhere else.
//
// No Homey and no radio here: this is the arithmetic, which is the part worth
// testing hard. See "The slider" in APP_PLAN.md for the measurements behind the
// numbers and RF_PROTOCOL.md for why brightness works this way at all.
//
// The constraint everything follows from: **brightness is relative.** One code
// means brighter and one means dimmer, at any level, because the fitting holds
// the level and the handset does not. So the app can only step, and it has to
// keep its own idea of where the light is.
//
// Three measured facts make that workable rather than hopeless:
//
//   * the range is 32 steps,
//   * **one press is exactly one step**, so stepping needs no rate figure and
//     accumulates no timing error, and
//   * **both ends saturate** rather than wrapping, so overshoot is free and a
//     deliberate overshoot re-anchors the estimate.

// Steps across the range, measured on the hardware. A power of two, so the
// fitting probably holds a 5-bit level.
const STEPS = 32;
const MIN = 0;
const MAX = STEPS - 1;

// Extra presses when the target is an end stop.
//
// This is the trick the saturation buys. Aiming at an end, the app can send more
// presses than it believes are needed: the surplus is absorbed by the end stop,
// and the light is then *known* to be there rather than estimated to be. Four
// covers an estimate that has drifted by a few steps without costing much time.
const MARGIN = 4;

// Presses to reach an end stop from anywhere at all, for when the position is
// unknown or being deliberately re-established.
//
// **This replaces the 10-second hold APP_PLAN.md originally specified**, which
// does not survive contact with Homey's transmitter. A hold on the handset steps
// every ~219ms, but the smallest thing Homey can send is one 9-frame press —
// ~423ms, one step — so 10 seconds of emulated holding buys about 17 steps and
// cannot cross a 32-step range. Counting presses needs no rate figure at all,
// which was APP_PLAN's own argument for preferring presses to a hold.
const SATURATE = STEPS + MARGIN;

const clampStep = step => Math.min(MAX, Math.max(MIN, step));
const isStep = value => Number.isInteger(value) && value >= MIN && value <= MAX;
const isEnd = step => step === MIN || step === MAX;

// Homey's `dim` is 0 to 1; the light's level is a step. 0% is the dimmest the
// light goes, not off — the light stays lit at its minimum, and `onoff` is what
// turns it off.
const toStep = dim => clampStep(Math.round(dim * MAX));
const toDim = step => clampStep(step) / MAX;

// Which end stop to re-establish from, when the position is unknown: whichever
// leaves less stepping afterwards.
const nearerEnd = step => (step * 2 >= MAX ? MAX : MIN);

const KEY_UP = 'light.brighter';
const KEY_DOWN = 'light.dimmer';

const towards = (from, to) => (to > from ? KEY_UP : KEY_DOWN);

// How to get from `from` to `to`, as a list of moves to transmit in order.
//
// `from` is a step, or null when the position is not known. Each move is a
// command key and how many times to press it, plus — when that move finishes
// against an end stop — the step it is then known to be at. `anchorsAt` is how a
// move that is interrupted halfway still leaves a usable estimate, and how the
// first half of a saturate-then-step plan hands a known position to the second.
//
// `anchored` says the whole plan finishes against an end stop, which is the
// difference between knowing where the light ended and believing it.
function plan(from, to) {
    if (!isStep(to)) throw new Error(`Not a step: ${JSON.stringify(to)}`);
    const known = isStep(from) ? from : null;
    const asked = { moves: [], endsAt: to, anchored: false };

    // An end stop: step the distance plus a margin and let the end absorb the
    // surplus — exact, self-correcting, and far quicker than re-establishing
    // from scratch. From nowhere, send enough to arrive from the far side.
    if (isEnd(to)) {
        const presses = known === null ? SATURATE : Math.abs(to - known) + MARGIN;
        const key = to === MAX ? KEY_UP : KEY_DOWN;
        return { ...asked, moves: [{ key, presses, anchorsAt: to }], anchored: true };
    }

    // Somewhere in the middle, from a known position: step the difference. Exact
    // while the estimate holds, and one press per step means no error of this
    // app's own making — only a press the light never heard.
    if (known !== null) {
        if (to === known) return asked;
        return { ...asked, moves: [{ key: towards(known, to), presses: Math.abs(to - known) }] };
    }

    // Somewhere in the middle, from nowhere: saturate to the nearer end, which
    // cannot fail, then step off it. Slow, and the only way to be right.
    const end = nearerEnd(to);
    const moves = [{ key: end === MAX ? KEY_UP : KEY_DOWN, presses: SATURATE, anchorsAt: end }];
    if (to !== end) moves.push({ key: towards(end, to), presses: Math.abs(to - end) });

    return { ...asked, moves };
}

// Where one overheard press leaves the estimate. A press the app did not make
// is someone at the handset, and the light moved one step — unless it was
// already against the end it was pressed towards, where nothing happened.
//
// Null in, null out: a step cannot be counted from a position that is not known.
function stepped(from, key) {
    if (!isStep(from)) return null;
    if (key === KEY_UP) return Math.min(MAX, from + 1);
    if (key === KEY_DOWN) return Math.max(MIN, from - 1);
    return from;
}

// How long a plan will take to transmit, in milliseconds, so a caller can say
// so rather than leave the user watching a slider that has not moved yet.
const airtime = (moves, perPress) => moves.reduce((total, move) => total + move.presses * perPress, 0);

module.exports = {
    STEPS,
    MIN,
    MAX,
    MARGIN,
    SATURATE,
    KEY_UP,
    KEY_DOWN,
    isStep,
    isEnd,
    toStep,
    toDim,
    nearerEnd,
    plan,
    stepped,
    airtime,
};
