'use strict';

// Keeps transmissions far enough apart that the receiver counts them as
// separate presses.
//
// **`signal.tx()` resolves when Homey has queued a transmission, not when it has
// finished going out.** A press is nine frames — 423ms of airtime, derived from
// the signal definition and matching the handset — so anything that waits on
// `tx` and then transmits again is laying one burst on top of the last.
//
// The receiver reads that as a button held down, not as two presses. It was
// found on the light: two quick taps of the tile sent two toggles 134ms apart,
// the second queued 289ms before the first had finished, and the fitting saw
// 846ms of unbroken toggle code and moved once. The same mistake was in the
// brightness stepping, where every press of a long move was queued 150ms after
// the one before — so a thirty-press move went out as a single continuous
// transmission and would have moved the light by one step, or by a hold's worth.
//
// It also explains what already worked: the fan's two-change sequences on the
// hardware were 636ms and 716ms apart, both clear of the airtime, so they were
// heard as separate presses.
//
// The figure was never wrong — APP_PLAN.md says 573ms a step — it was measured
// from the wrong instant.

// One press, nine frames, as the signal definition specifies:
//   preamble 10280us + 25 bits x ~1091.5us = 37.57ms a frame,
//   plus the 9448us interval, nine times over.
// test/press-queue.test.js re-derives this from the signal so the two cannot
// drift apart.
const PRESS_AIRTIME = 423;

// Silence after a press before the next one, so the receiver sees the button
// come up. The conservative figure from APP_PLAN.md; there is no measurement of
// what the fitting's own threshold is, only that 636ms end-to-end worked and
// 134ms did not.
const RELEASE_GAP = 150;

// So: one press every 573ms, which is what a step has always been costed at.
const PRESS_INTERVAL = PRESS_AIRTIME + RELEASE_GAP;

// Returns a function that runs each transmission in turn, never starting one
// within PRESS_INTERVAL of the last.
//
// `wait` and `now` are injected so this can be tested against a virtual clock
// rather than by waiting twenty real seconds for a full-range move.
function pressQueue({ wait, now = Date.now, interval = PRESS_INTERVAL } = {}) {
    let chain = Promise.resolve();
    let lastAt = null;

    return function press(transmit) {
        const mine = chain.then(async () => {
            const since = lastAt === null ? Infinity : now() - lastAt;
            if (since < interval) await wait(interval - since);

            lastAt = now();
            return transmit();
        });

        // The chain carries on whatever this press did. A failed transmission
        // must not wedge every press after it — the radio being busy once is
        // not a reason to stop driving the fan.
        chain = mine.then(() => {}, () => {});
        return mine;
    };
}

module.exports = {
    PRESS_AIRTIME,
    RELEASE_GAP,
    PRESS_INTERVAL,
    pressQueue,
};
