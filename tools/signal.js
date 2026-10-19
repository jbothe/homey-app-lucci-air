'use strict';

// Turns an inferred alignment into a candidate Homey 433 MHz signal definition.
//
// The values come straight off the measurements, but three of the properties
// are judgement calls carried over from the sibling Bear and RC300 apps rather
// than anything a capture can show, and each is there for a reason:
//
//   * no `eof`. Homey will not match an incoming frame against a definition
//     declaring an eof unless it observes that eof on air, and the silence
//     after a frame is usually longer than an eof can express. Declaring one
//     makes the app deaf while looking like a radio fault.
//   * no `txOnly`. It defaults to false, so receiving works without touching
//     it, but setting it would switch receiving off.
//   * `rxTimeout` of 255. The 10ms default expires inside a frame of this
//     length, so frames never complete.
//
// `repetitions` matches what the handset sends. Transmitting for materially
// longer made the RC300 fireplace register one Homey command as two presses,
// because its receiver re-triggers while it keeps hearing the same command.

// Tolerances Homey is actually given in practice. A sensitivity is a fractional
// window around each duration, so a value that sounds safely permissive can
// widen the windows until two symbols overlap and nothing decodes at all.
const CANDIDATES = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];

const window = (mean, sensitivity) => [mean * (1 - sensitivity), mean * (1 + sensitivity)];
const overlaps = ([aLo, aHi], [bLo, bHi]) => aLo <= bHi && bLo <= aHi;

// Whether a sensitivity both keeps the symbols apart and still admits every
// duration measured. Homey matches a (pulse, gap) pair against each word, so
// two symbols are only ambiguous when they overlap on *both* halves.
function check(alphabet, sensitivity) {
    const windows = alphabet.map(s => ({
        pulse: window(s.pulse.mean, sensitivity),
        gap: window(s.gap.mean, sensitivity),
    }));

    const ambiguous = [];
    for (let i = 0; i < windows.length; i += 1) {
        for (let j = i + 1; j < windows.length; j += 1) {
            if (overlaps(windows[i].pulse, windows[j].pulse) && overlaps(windows[i].gap, windows[j].gap)) {
                ambiguous.push([i, j]);
            }
        }
    }

    // A window that does not reach the extremes actually recorded would reject
    // real frames at the edge of the transmitter's jitter.
    const excluded = alphabet.filter((s, i) => s.pulse.min < windows[i].pulse[0]
        || s.pulse.max > windows[i].pulse[1]
        || s.gap.min < windows[i].gap[0]
        || s.gap.max > windows[i].gap[1]);

    return { sensitivity, windows, ambiguous, excluded, ok: ambiguous.length === 0 && excluded.length === 0 };
}

// The usable tolerance furthest from either way of failing.
//
// Both failures are silent and look identical from outside — the app receives
// nothing — so the value wants to sit as far from each as it can rather than up
// against one of them. Too tight and real frames fall outside their own
// symbol's window, which happens as soon as a handset's timing differs from the
// one that was recorded. Too loose and two symbols' windows overlap, both match
// the same pulse, and nothing decodes at all.
//
// So the middle of the usable run, not an end of it. Taking the tightest would
// admit the recordings in hand and nothing else; the loosest sits one step from
// an alphabet that cannot be decided. The whole usable range is reported
// alongside, so the choice can be revisited on evidence.
function chooseSensitivity(alphabet) {
    const tried = CANDIDATES.map(s => check(alphabet, s));
    const usable = tried.filter(t => t.ok);
    if (usable.length === 0) return { chosen: null, usable, tried };

    return { chosen: usable[Math.floor((usable.length - 1) / 2)], usable, tried };
}

// The candidate definition. Lengths allow one symbol either way, because a
// frame's last symbol loses its own gap to the gap before the next repeat: the
// receiver never closes that word and hands back one symbol fewer than went
// out. Requiring the transmitted length exactly makes the app deaf.
function signalDefinition({ alignment, frameLength, interval, repetitions, sensitivity }) {
    return {
        sof: alignment.sof,
        words: alignment.alphabet.map(s => [s.pulse.mean, s.gap.mean]),
        interval,
        sensitivity,
        repetitions,
        minimalLength: frameLength - 1,
        maximalLength: frameLength,
        rxTimeout: 255,
    };
}

module.exports = { CANDIDATES, check, chooseSensitivity, signalDefinition, window };
