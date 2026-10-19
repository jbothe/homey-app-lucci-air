'use strict';

// Builds recorder output for a protocol we chose, so the analyser can be tested
// against a known answer without a handset in the room.
//
// It reproduces the two things about real recordings that the analyser has to
// cope with. A frame's last symbol never gets its own gap: that gap runs into
// the silence before the next repeat and the recorder reports the two as one
// duration. And every duration carries jitter, so the analyser is never handed
// the exact values it is being asked to recover.

const OVERFLOW = 65535;

// A small deterministic generator, so a failure is the same failure next run.
function jitterer(seed, spread) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) & 0x7FFFFFFF;
        if (spread === 0) return 0;
        return ((state >> 8) % (2 * spread + 1)) - spread;
    };
}

// `frames` is one array of symbol indices per repeat, so a press that
// alternates two forms is expressed by passing both.
function synthesise({ sof, words, frames, interval, jitter = 0, seed = 7, trailing = true }) {
    const noise = jitterer(seed, jitter);
    const durations = [];

    for (const symbols of frames) {
        for (const duration of sof) durations.push(duration + noise());

        symbols.forEach((symbol, i) => {
            const [pulse, gap] = words[symbol];
            durations.push(pulse + noise());

            // The last gap of the frame is swallowed by the interval, which is
            // exactly what makes a received frame one symbol short of a
            // transmitted one.
            if (trailing && i === symbols.length - 1) durations.push(gap + interval + noise());
            else durations.push(gap + noise());
        });

        if (!trailing) durations.push(interval + noise());
    }

    // Recorders stop on a gap they cannot measure.
    durations[durations.length - 1] = OVERFLOW;
    return durations;
}

// A capture file as the recorder writes one: a label line, then the durations.
function captureFile(blocks) {
    return blocks.map(({ label, durations }) => `${label}:\n${durations.join(',')}\n`).join('\n');
}

// Bear-shaped: two symbols, a two-duration preamble, 40 bits.
const BINARY = {
    sof: [4770, 1538],
    words: [[332, 752], [690, 392]],
    interval: 9700,
};

// RC300-shaped: four symbols and a preamble of an odd number of durations,
// which shifts the payload's pulses onto the offsets the preamble's gaps used.
const TABLE = {
    sof: [800, 425, 375, 425, 900, 425, 400, 1225, 900],
    words: [[1500, 400], [1500, 900], [675, 400], [675, 900]],
    interval: 18000,
};

const repeat = (symbols, times) => Array.from({ length: times }, () => symbols);

module.exports = { synthesise, captureFile, jitterer, BINARY, TABLE, repeat, OVERFLOW };
