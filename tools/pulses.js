'use strict';

// Works out, from Homey RF signal recorder output alone, what a transmission
// looks like: where its frames start, what symbol alphabet they use, and how
// long they are.
//
// The sibling Bear and RC300 apps decode with the timings already known. This
// module is for the step before that, when nothing about the protocol has been
// established yet, so it assumes as little as it can:
//
//   * a capture is alternating pulse and gap durations in microseconds,
//   * one button press puts several repeated frames on air, and
//   * the gap between repeats is much longer than any gap inside a frame.
//
// Everything else — preamble length, how many symbols the alphabet has, their
// durations, the frame length — is inferred and reported with the evidence, so
// a reading can be checked rather than taken on trust.

// The recorder reports a gap it could not measure as this, its overflow value.
const OVERFLOW = 65535;

// A separator has to be a large multiple of the gaps inside a frame, not merely
// larger than them: a preamble gap is itself several times a data gap, and must
// not be mistaken for the end of a frame.
const SEPARATOR_RATIO = 3;

// A separator also has to be rare — about one per frame. Without this, a stray
// short glitch early in a capture looks like an enormous jump up to the data
// durations, and the threshold lands below the whole transmission.
const SEPARATOR_SHARE = 0.25;

// Two durations belong to the same symbol if they are this close. Recorder
// jitter across the sibling captures is about +/-20us on a 330us pulse, so 20%
// clusters those together while still separating 332 from 690.
const CLUSTER_TOLERANCE = 0.2;

// Below this, a difference is jitter whatever the ratio says.
const CLUSTER_MIN_GAP = 25;

// How wide one symbol's durations may span. Without a cap, clustering chains:
// values 22% apart each sit within the tolerance of those between them, so two
// symbols merge into one class and the frame decodes to something plausible and
// wrong.
//
// No single cap works. Measured across the sibling captures, one symbol's gap
// really does span 22% (332-404us), while two distinct durations in the RC300
// preamble sit 22% apart (1225 and 1500us) — the same figure means the opposite
// thing in each case, so the alphabet cannot be settled by a tolerance chosen
// in advance.
//
// So every cap is tried, and the readings are judged on how well they fit the
// recording: see inferAlignment. A cap too tight splits one symbol in two and
// inflates the alphabet; too loose and the merged class sits further from the
// durations assigned to it. Both show up in the scoring.
const CLUSTER_WIDTHS = [1.12, 1.2, 1.3, 1.45, 1.6];

// A class wider than this is reported as probably two symbols read as one.
const SUSPECT_WIDTH = 1.35;

// How many durations a repair may merge, in the order tried. The odd lengths
// come first because they keep pulses and gaps alternating, which is what an
// invented pair of transitions needs; the even ones repair a lone transition,
// which has flipped them.
const SPIKE_WINDOWS = [3, 2, 5, 4];
const MAX_CLUSTER_WIDTH = CLUSTER_WIDTHS[CLUSTER_WIDTHS.length - 1];

// A real alphabet is small. Binary (Bear) or a four-entry table (RC300) are
// what the siblings use; more than four distinct pulse/gap pairs means the
// candidate alignment is wrong rather than that the protocol is exotic.
const MAX_ALPHABET = 4;

// How far into a frame a preamble could plausibly run. RC300's is 9 durations.
const MAX_SOF_LENGTH = 20;

// A body shorter than this is not a frame, which stops the search settling on
// an alignment that swallows the payload into the preamble.
const MIN_BODY_LENGTH = 8;

// A real symbol recurs within a frame, so a pair type is only admitted once it
// has been seen this many times per frame.
//
// It does two jobs. It throws out glitches — a dropped pulse, a collision with
// something else on the band — which matters because admitting one as a symbol
// is worse than dropping the frame that holds it: it inflates the alphabet,
// which renumbers every other symbol, and quietly changes what the whole
// capture appears to say. And it rejects an alignment that has left part of the
// preamble in the payload, since a preamble pair occurs exactly once per frame.
//
// It is a preference rather than a rule, because a protocol may legitimately
// use some symbol only once per frame. inferAlignment reads every capture both
// with the floor and without it, and lets the two compete.
const SYMBOL_MIN_PER_FRAME = 2;

// And most frames then have to be explained in full, with no pair left over.
//
// Without this the rule above turns on itself: a preamble occurs once per frame,
// so it falls below the recurrence floor, and a reading that claims no preamble
// at all can discard it as a glitch and come out looking like the simplest
// account of the capture. Requiring whole frames to decode is what forces the
// preamble to be accounted for as preamble. The allowance below 1 is for
// genuinely glitched frames, which do occur and are reported.
const MIN_EXPLAINED = 0.6;

// How much of a preamble may fail to match and the frame still be read.
//
// The recorder mistimes the first edge of a frame often — the moment it arms,
// or the receiver's gain settles — reporting 49,390 or 333,744 where the
// handset sent 493,610. Those durations are junk, but the payload behind them
// still sits at its proper offset, so the frame is perfectly readable. Holding
// every preamble position to the median threw away half of some captures and
// took the reading with them.
//
// A frame that began mid-preamble is a different matter, and is not what this
// lets in: a preamble of repeated pulses would match a shifted frame at most
// positions, but such a frame is short, and is already excluded for having the
// wrong number of durations.
const SOF_MISMATCH_SHARE = 0.2;

// A reading of a frame has to be corroborated by another repeat to count. One
// frame reading its own way is a glitched frame, and letting it through makes
// a position that never moves look as though it varies.
const CONSENSUS_MIN = 2;

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};
const modal = values => {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
};

// Splits a recorder dump into labelled blocks: a label line ending in a colon,
// then that button's durations over one or more lines. Lines starting with #
// are comments.
function parseCaptures(text) {
    const blocks = [];
    let current = null;

    for (const line of text.split('\n')) {
        if (line.trim().startsWith('#')) continue;

        // A label is any line ending in a colon that contains a letter, so
        // "Fan Speed Up:" and "Light On/Off (repeat):" both work.
        const label = line.match(/^\s*(.*\p{L}.*?)\s*:\s*$/u);
        if (label !== null) {
            current = { label: label[1].trim(), durations: [] };
            blocks.push(current);
            continue;
        }
        if (current === null) continue;

        // Empty fields are dropped before conversion: a blank line between
        // blocks, or a trailing comma, would otherwise read as a 0us duration
        // and corrupt the capture it sits in.
        const numbers = line.trim().split(',')
            .filter(field => field.trim() !== '')
            .map(Number)
            .filter(n => Number.isFinite(n));
        current.durations.push(...numbers);
    }

    return blocks.filter(b => b.durations.length > 0);
}

// Groups durations that are within tolerance of each other, smallest first.
// Each cluster is one candidate symbol duration, and its spread is the evidence
// for how tight the transmitter's timing is.
function clusterDurations(values, {
    tolerance = CLUSTER_TOLERANCE, minGap = CLUSTER_MIN_GAP, maxWidth = MAX_CLUSTER_WIDTH,
} = {}) {
    const sorted = [...values].sort((a, b) => a - b);
    const clusters = [];
    let current = null;

    for (const value of sorted) {
        const apart = current !== null
            && value - current.max > minGap
            && value > current.max * (1 + tolerance);
        const tooWide = current !== null && value > current.min * maxWidth;

        if (current === null || apart || tooWide) {
            current = { values: [value], min: value, max: value };
            clusters.push(current);
            continue;
        }
        current.values.push(value);
        current.max = value;
    }

    return clusters.map(c => ({
        min: c.min,
        max: c.max,
        mean: Math.round(mean(c.values)),
        count: c.values.length,
        // Wider than any one duration plausibly is, so this class has probably
        // chained two symbols together — which would make every reading
        // downstream of it wrong. Judged against a fixed ratio, not against the
        // cap in force: a class sitting at a tight cap is the ordinary case,
        // since inferAlignment tries every cap and keeps the reading that fits
        // best, and flagging that would warn on every clean capture.
        suspect: c.max > c.min * SUSPECT_WIDTH,
    }));
}

const clusterOf = (value, clusters) => clusters.findIndex(c => value >= c.min && value <= c.max);

// Repairs spurious transitions.
//
// The recorder sometimes reports one pulse as several shorter ones — a run like
// 262,208,10 where the handset sent a single 480us pulse. The fragments sum
// back to a real duration, which is what identifies them: the receiver invented
// transitions inside a pulse rather than mistiming its edges.
//
// Left alone they are fatal to the whole reading, not merely to the frame that
// holds them. Each invented transition adds durations to its frame, so the
// frames come out different lengths, and the extra durations fall at a
// different offset in each one, so no single preamble length explains them all.
// A capture with one chopped pulse per repeat reads as no structure at all.
//
// A duration belongs if it falls in a well-populated class. Starting from one
// that does not, the shortest window whose durations sum to a real duration is
// merged back into one. Windows that keep pulses and gaps alternating are
// preferred, since an invented transition usually comes in pairs; an odd one,
// which flips pulses for gaps through the rest of the frame, is repaired by a
// window that flips them back.
//
// Three things keep it from inventing repairs of its own. A window must hold at
// least two durations that do not belong, so a legitimate pair cannot be merged
// on the strength of one odd neighbour beside it. Its sum must land on a real
// class. And it is bounded, so a run of noise cannot swallow the preamble. What
// cannot be repaired this way — a mistimed edge, where the transition moved
// rather than multiplied — is left exactly as it was, for the frame to be
// reported unreadable.
//
// It does not catch everything. The classes are worked out from the glitched
// capture, so a fragment can happen to land inside a real class, and the repair
// then starts a position late and that frame is misread rather than dropped.
// What contains that is a reading needing a second repeat to corroborate it:
// the misread frame is set aside, and never reaches the field map.
function repairSpikes(durations) {
    const inRange = durations.filter(d => d < OVERFLOW);
    if (inRange.length === 0) return { durations, repaired: 0 };

    // Populated classes only: a glitch is rare by nature, and treating one as a
    // class of its own is what this is here to undo.
    const floor = Math.max(3, inRange.length * 0.015);
    const classes = clusterDurations(inRange).filter(c => c.count >= floor);
    if (classes.length === 0) return { durations, repaired: 0 };

    const belongs = v => v === OVERFLOW || classes.some(c => v >= c.min && v <= c.max);
    const real = v => classes.some(c => Math.abs(v - c.mean) <= c.mean * CLUSTER_TOLERANCE);

    const out = [];
    let repaired = 0;
    let i = 0;

    while (i < durations.length) {
        if (belongs(durations[i])) {
            out.push(durations[i]);
            i += 1;
            continue;
        }

        let merged = null;
        for (const length of SPIKE_WINDOWS) {
            if (i + length > durations.length) continue;

            const window = durations.slice(i, i + length);
            if (window.filter(v => !belongs(v)).length < 2) continue;

            const sum = window.reduce((a, b) => a + b, 0);
            if (!real(sum)) continue;

            merged = { sum, length };
            break;
        }

        if (merged === null) {
            out.push(durations[i]);
            i += 1;
            continue;
        }

        out.push(merged.sum);
        repaired += 1;
        i += merged.length;
    }

    return { durations: out, repaired };
}

// Which index parity holds the gaps. A capture alternates pulse and gap, and
// normally opens on a pulse, but it can open mid-frame — so rather than assume,
// take the side holding the longest durations: the gap between repeats is
// longer than any pulse in the transmission.
function gapParity(durations) {
    const maxOf = parity => Math.max(...durations.filter((_, i) => i % 2 === parity), 0);
    return maxOf(1) >= maxOf(0) ? 1 : 0;
}

// Finds the duration above which anything means "end of frame" rather than
// "part of one".
//
// This runs in two steps, because the two things that have to be told apart —
// the gap between repeats and the preamble's long pulse — occur exactly once
// per frame each, so no amount of counting separates them.
//
// First, which class of gap ends a frame. Only gaps are considered there:
// pooling pulses in would put the preamble pulse into the distribution, where
// it can sit between the preamble gap and the gap between repeats and break the
// chain of ratios.
//
// Then the threshold is lifted clear of everything shorter, pulses included.
// The gap between repeats is the longest thing in a transmission, so putting
// the threshold below it and above all else means a frame can be cut without
// knowing where its pulses fall. That matters: a preamble with an odd number of
// durations shifts the payload's pulses onto the offsets the preamble's gaps
// occupied, and a frame cut on position alone would then either take the
// preamble pulse for a separator or miss the separator altogether.
function separatorThreshold(durations) {
    const parity = gapParity(durations);
    const gaps = durations.filter((_, i) => i % 2 === parity);
    const inRange = gaps.filter(d => d < OVERFLOW);

    const floor = separatorFloor(inRange, gaps.length, gaps.length - inRange.length);
    if (floor === null) return OVERFLOW;

    const below = durations.filter(d => d < floor);
    if (below.length === 0) return Math.round(floor / 2);
    return Math.round(Math.sqrt(floor * Math.max(...below)));
}

// The shortest gap that still reads as the end of a frame, or null when the
// capture holds no second frame to be separated from.
//
// A boundary qualifies when the jump up to it is large, since a preamble gap is
// itself a couple of times a data gap and is not a frame boundary; when what
// lies above it is rare, one per frame against dozens of data gaps, which is
// what rejects a stray short glitch; and when it is drawn against a duration
// seen more than once, so a single glitched gap cannot stand in for a real
// class. The lowest qualifying boundary is the answer, not the largest jump,
// since both the interval between repeats and the recorder's overflow end a
// frame and the threshold belongs below the smaller of them.
function separatorFloor(inRange, total, overflows) {
    const noneMeasurable = overflows > 0 ? OVERFLOW : null;
    if (inRange.length === 0) return noneMeasurable;

    const clusters = clusterDurations(inRange).filter(c => c.count > 1);
    if (clusters.length < 2) return noneMeasurable;

    // Durations at or above each cluster, counting the overflows that never
    // entered the clusters.
    const atOrAbove = [];
    let running = overflows;
    for (let i = clusters.length - 1; i >= 0; i -= 1) {
        running += clusters[i].count;
        atOrAbove[i] = running;
    }

    for (let i = 1; i < clusters.length; i += 1) {
        if (clusters[i].mean / clusters[i - 1].mean < SEPARATOR_RATIO) continue;
        if (atOrAbove[i] / total > SEPARATOR_SHARE) continue;
        return clusters[i].min;
    }

    return noneMeasurable;
}

// Cuts a capture into frames at every duration at or above the threshold. The
// duration that ended each frame is kept: it is where the interval between
// repeats lives, and it is also where a frame's last symbol loses its own gap
// (see decodeFrame).
function splitFrames(durations, threshold) {
    const frames = [];
    let current = [];

    for (const value of durations) {
        if (value >= threshold) {
            frames.push({ durations: current, separator: value });
            current = [];
            continue;
        }
        current.push(value);
    }

    if (current.length > 0) frames.push({ durations: current, separator: null });
    return frames.filter(f => f.durations.length > 0);
}

// Scores one guess at how many leading durations are preamble. A guess is
// viable when the durations after it fall into a small alphabet of pulse/gap
// pairs, every frame comes out the same length, and the leading durations
// themselves are the same in every frame — which is what a preamble is.
function scoreAlignment(frames, sofLength, {
    floorPerFrame = SYMBOL_MIN_PER_FRAME, minExplained = MIN_EXPLAINED, maxWidth = MAX_CLUSTER_WIDTH,
} = {}) {
    // Which frames carry the same preamble. A preamble is identical on every
    // repeat, so this is also what identifies the frames worth reading: a
    // recorder that started mid-preamble delivers a frame of the right length
    // whose payload is shifted, and reading it alongside the others would
    // inject symbols that were never sent.
    //
    // Judged against the median rather than against each other. Requiring every
    // frame to agree lets one truncated repeat — and the first repeat of a
    // capture is often truncated — veto the whole reading.
    const centre = Array.from({ length: sofLength }, (_, i) => median(frames.map(f => f.durations[i])));
    const matches = (value, i) => value <= centre[i] * (1 + CLUSTER_TOLERANCE)
        && value >= centre[i] / (1 + CLUSTER_TOLERANCE);

    const allowed = Math.floor(sofLength * SOF_MISMATCH_SHARE);
    const aligned = frames.filter(
        f => centre.filter((_, i) => !matches(f.durations[i], i)).length <= allowed,
    );
    if (aligned.length / frames.length < minExplained) return null;

    const bodies = aligned.map(f => f.durations.slice(sofLength));
    if (bodies.some(b => b.length < MIN_BODY_LENGTH)) return null;

    // Position parity inside the body is what tells a pulse from a gap, which
    // is why the two are clustered separately: a 332us pulse and a 392us gap
    // are indistinguishable in a single pooled set.
    const pulses = bodies.flatMap(b => b.filter((_, i) => i % 2 === 0));
    const gaps = bodies.flatMap(b => b.filter((_, i) => i % 2 === 1));
    const pulseClusters = clusterDurations(pulses, { maxWidth });
    const gapClusters = clusterDurations(gaps, { maxWidth });

    const seen = new Map();
    for (const body of bodies) {
        for (let i = 0; i + 1 < body.length; i += 2) {
            const key = `${clusterOf(body[i], pulseClusters)},${clusterOf(body[i + 1], gapClusters)}`;
            seen.set(key, (seen.get(key) || 0) + 1);
        }
    }

    // Keep only the pairs that recur. What is dropped here is not decoded
    // later either, so a frame carrying a glitch is reported unreadable rather
    // than read as though the glitch meant something.
    const floor = floorPerFrame * bodies.length;
    const types = new Map([...seen].filter(([, count]) => count >= floor));
    if (types.size < 2 || types.size > MAX_ALPHABET) return null;

    // The preamble may not end on a symbol. Where it does, it has swallowed the
    // first of the payload, and the reading loses a position off the front of
    // every frame. The test above does not catch it, because the leading
    // payload is the address and holds just as still as a preamble — and with a
    // single frame to go on it catches nothing at all.
    if (sofLength >= 2) {
        const tail = `${clusterOf(centre[sofLength - 2], pulseClusters)}`
            + `,${clusterOf(centre[sofLength - 1], gapClusters)}`;
        if (types.has(tail)) return null;
    }

    const lengths = bodies.map(b => b.length);
    if (Math.max(...lengths) !== Math.min(...lengths)) return null;

    // How far the durations actually recorded sit from the class each was
    // assigned to. This is the measure of fit: a cap that chained two symbols
    // together leaves every duration of one of them well away from the merged
    // class's mean, while the right cap leaves only the transmitter's jitter.
    let residual = 0;
    const whole = bodies.filter(body => {
        let fits = true;
        for (let i = 0; i + 1 < body.length; i += 2) {
            const pulse = clusterOf(body[i], pulseClusters);
            const gap = clusterOf(body[i + 1], gapClusters);
            if (!types.has(`${pulse},${gap}`)) { fits = false; break; }
            residual = Math.max(
                residual,
                Math.abs(body[i] - pulseClusters[pulse].mean) / pulseClusters[pulse].mean,
                Math.abs(body[i + 1] - gapClusters[gap].mean) / gapClusters[gap].mean,
            );
        }
        return fits;
    });
    // Against every frame, not just the aligned ones, so a reading that had to
    // discard half the capture to work is ranked below one that did not.
    const explained = whole.length / frames.length;
    if (explained < minExplained) return null;

    return {
        sofLength,
        explained,
        residual,
        maxWidth,
        aligned: aligned.length,
        // Measured position by position, over only the frames that agree at that
        // position, so a mistimed first edge cannot drag the preamble's
        // durations off.
        sof: Array.from({ length: sofLength }, (_, i) => {
            const agreeing = aligned.map(f => f.durations[i]).filter(v => matches(v, i));
            return Math.round(agreeing.length > 0 ? mean(agreeing) : centre[i]);
        }),
        pulseClusters,
        gapClusters,
        alphabet: alphabetFrom(types, pulseClusters, gapClusters),
        bodyLength: lengths[0],
    };
}

// Turns the pulse/gap pairs seen on air into a numbered symbol table. The order
// is this module's own — sorted by duration so the output is stable — and says
// nothing about which symbol the transmitter calls zero. A protocol module is
// free to renumber them.
function alphabetFrom(types, pulseClusters, gapClusters) {
    return [...types.entries()]
        .map(([key, count]) => {
            const [p, g] = key.split(',').map(Number);
            return { pulse: pulseClusters[p], gap: gapClusters[g], count };
        })
        .sort((a, b) => a.pulse.mean - b.pulse.mean || a.gap.mean - b.gap.mean)
        .map((symbol, index) => ({ index, ...symbol }));
}

// Picks the reading that best explains the frames.
//
// Every clustering tolerance is tried, because no one of them is right for all
// transmitters (see CLUSTER_WIDTHS), and the candidates are ranked:
//
//   1. fewest symbols. A tolerance too tight splits one symbol into two, so a
//      reading needing more symbols than another is usually the split one.
//   2. most frames explained. A tolerance tight enough to leave a symbol's
//      outlying durations outside every class reads the frames holding them as
//      glitched, which throws away real recordings to buy a neater fit.
//   3. closest fit. Among readings covering the same frames with the same
//      number of symbols, the one whose durations sit nearest the classes they
//      were assigned to. This is what rejects a tolerance so loose it merged
//      two distinct durations: the merged class then sits halfway between them,
//      far from both.
//   4. least claimed as preamble, so payload is never eaten.
//
// The recurrence floor is applied and relaxed, and both results compete, so a
// protocol that uses some symbol only once per frame can still be read. The
// floor is not a precondition but a preference: a reading that admits a glitch
// as a symbol needs one more symbol than the same reading without it, and so
// loses on the first criterion.
function inferAlignment(frames) {
    const scored = [];

    for (const floorPerFrame of [SYMBOL_MIN_PER_FRAME, 0]) {
        for (const maxWidth of CLUSTER_WIDTHS) {
            for (let sofLength = 0; sofLength <= MAX_SOF_LENGTH; sofLength += 1) {
                const result = scoreAlignment(frames, sofLength, { floorPerFrame, maxWidth });
                if (result !== null) scored.push(result);
            }
        }
    }
    if (scored.length === 0) return null;

    scored.sort((a, b) => a.alphabet.length - b.alphabet.length
        || b.explained - a.explained
        || a.residual - b.residual
        || a.sofLength - b.sofLength);
    return scored[0];
}

// Reads one frame as symbol indices. A frame's last symbol is a special case:
// its gap on air is the long gap to the next repeat, not the symbol's own, so
// the pulse has to be matched on its own. Where the pulse alone does not single
// out one symbol the position is reported as null rather than guessed.
function decodeFrame(frame, alignment) {
    const body = frame.durations.slice(alignment.sofLength);
    const { alphabet } = alignment;
    const symbols = [];

    for (let i = 0; i < body.length; i += 2) {
        const pulse = body[i];
        const gap = body[i + 1];
        const byPulse = alphabet.filter(s => pulse >= s.pulse.min && pulse <= s.pulse.max);

        if (gap === undefined) {
            symbols.push(byPulse.length === 1 ? byPulse[0].index : null);
            continue;
        }
        const match = byPulse.find(s => gap >= s.gap.min && gap <= s.gap.max);
        symbols.push(match === undefined ? null : match.index);
    }

    return symbols;
}

// Lays a reading back out as durations, so what was inferred can be held
// against what was recorded. A profile that cannot reproduce the recording is
// wrong however plausible its numbers look, and this is the only check on that
// which does not need the radio.
//
// The frame's last symbol gives up its own gap, as it does on air: that gap
// runs into the interval before the next repeat.
function renderFrame(symbols, alignment, { interval = 0 } = {}) {
    const durations = [...alignment.sof];
    const merged = alignment.bodyLength % 2 === 1;

    symbols.forEach((symbol, i) => {
        const { pulse, gap } = alignment.alphabet[symbol];
        durations.push(pulse.mean);

        // Where the recorder reported the last gap and the interval as one
        // duration, render them as one, so this can be held against a recorded
        // frame element for element.
        if (i === symbols.length - 1 && merged) durations.push(gap.mean + interval);
        else durations.push(gap.mean);
    });

    if (!merged) durations.push(interval);
    return durations;
}

// Whether a rendered frame matches a recorded one everywhere, within the
// tolerance the signal definition will be given.
function framesAgree(rendered, recorded, sensitivity) {
    if (rendered.length !== recorded.length) return false;
    return rendered.every((value, i) => Math.abs(value - recorded[i]) <= value * sensitivity);
}

// Everything one capture says, for looking at a single button in isolation.
// Reads it through the same path as a whole session so that the two can never
// disagree about what a capture means.
function analyseCapture(durations, label = 'capture') {
    const result = analyseCaptures([{ label, durations }]);
    return { ...result, ...(result.reads[0] || {}) };
}

// Everything a whole recording session says, read as one protocol rather than
// one capture at a time. Pooling the frames is what makes the fields visible:
// a position is only address if it holds still across every button, and only
// command if it moves between them.
function analyseCaptures(blocks) {
    const captures = blocks.map(({ label, durations }) => {
        const { durations: clean, repaired } = repairSpikes(durations);
        const threshold = separatorThreshold(clean);
        const frames = splitFrames(clean, threshold);
        return { label, threshold, frames, repaired };
    });

    const all = captures.flatMap(c => c.frames);
    if (all.length === 0) return { captures: [], alignment: null, reads: [], positions: [] };

    // One frame length for the whole session. A capture opens and closes
    // mid-frame, so the odd short frame is a cut artefact, not a short frame.
    const length = modal(all.map(f => f.durations.length));
    const whole = captures.map(c => ({
        ...c,
        whole: c.frames.filter(f => f.durations.length === length),
    }));

    const pooled = whole.flatMap(c => c.whole);
    const alignment = pooled.length > 0 ? inferAlignment(pooled) : null;
    if (alignment === null) {
        return { captures: whole, frameLength: length, alignment: null, reads: [], positions: [] };
    }

    const reads = whole.map(c => {
        const tally = new Map();
        let unreadable = 0;
        for (const frame of c.whole) {
            const symbols = decodeFrame(frame, alignment);
            if (symbols.includes(null)) { unreadable += 1; continue; }
            const key = symbols.join('');
            tally.set(key, (tally.get(key) || 0) + 1);
        }

        // Corroborated readings, and the ones left over. A press that really
        // alternates two forms shows both here; a glitched frame shows up in
        // the leftovers, where it is reported but kept out of the field map.
        const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
        const corroborated = ranked.filter(([, count]) => count >= CONSENSUS_MIN);
        const distinct = corroborated.length > 0 ? corroborated : ranked.slice(0, 1);
        const discarded = ranked.filter(entry => !distinct.includes(entry));

        // The gap the recorder measures between repeats is not the interval to
        // give Homey. Where a frame's body has an odd number of durations its
        // last symbol never got its own gap — that gap ran into the silence
        // before the next repeat, and the recorder reports the two as one. So
        // the symbol's own gap comes back off before the rest is the interval.
        const trailing = alignment.bodyLength % 2 === 1;
        const intervals = [];
        for (const frame of c.whole) {
            if (frame.separator === null || frame.separator === OVERFLOW) continue;
            if (!trailing) { intervals.push(frame.separator); continue; }

            const symbols = decodeFrame(frame, alignment);
            const last = symbols[symbols.length - 1];
            if (last === null) continue;
            intervals.push(frame.separator - alignment.alphabet[last].gap.mean);
        }
        const measured = c.whole.map(f => f.separator).filter(v => v !== null && v !== OVERFLOW);

        return {
            label: c.label,
            threshold: c.threshold,
            frames: c.frames.length,
            whole: c.whole.length,
            repaired: c.repaired,
            // Frames that ended at a separator. The tail of a capture is
            // usually a fragment with nothing after it, so counting those too
            // would overstate what the handset sends by one.
            sent: c.frames.filter(f => f.separator !== null).length,
            unreadable,
            distinct,
            discarded,
            interval: intervals.length > 0 ? Math.round(mean(intervals)) : null,
            separator: measured.length > 0 ? Math.round(mean(measured)) : null,
        };
    });

    return {
        captures: whole,
        frameLength: length,
        alignment,
        reads,
        positions: comparePositions(reads),
    };
}

// For each symbol position, which values appear and whether they ever change.
// Positions that never change are the address; positions that change between
// buttons are the command. This is the whole of the field analysis, and it is
// only as good as the captures: a field that happens to be constant across the
// buttons recorded will read as address until a button that moves it is caught.
function comparePositions(reads) {
    const frames = reads.flatMap(r => r.distinct.map(([bits]) => ({ label: r.label, bits })));
    if (frames.length === 0) return [];

    const width = Math.max(...frames.map(f => f.bits.length));
    return Array.from({ length: width }, (_, i) => {
        const values = new Set(frames.map(f => f.bits[i]).filter(v => v !== undefined));
        return { position: i, values: [...values].sort(), constant: values.size === 1 };
    });
}

// Pairs each button recorded twice with its second recording, and says whether
// the two agree.
//
// This is what decides whether the handset can be cloned at all. A fixed code
// repeats and can be replayed; a rolling one changes on every press and cannot,
// however well the frame layout is understood. See CAPTURE_GUIDE.md.
function pairRepeats(reads) {
    const readings = read => read.distinct.map(([bits]) => bits).sort().join('|');
    const paired = [];

    for (const second of reads) {
        const match = second.label.match(/^(.*?)\s*\((?:repeat|repeated|again|2|b)\)$/i);
        if (match === null) continue;

        const first = reads.find(r => r.label.toLowerCase() === match[1].toLowerCase());
        if (first === undefined) continue;

        // Two captures that both decoded to nothing are not evidence of
        // agreement, so they do not count as agreeing.
        const both = readings(first);
        paired.push({ label: match[1], agrees: both !== '' && both === readings(second) });
    }

    return paired;
}

// Groups adjacent positions that agree on whether they move, so the field map
// reads as "0-27 constant, 28-31 varying" rather than position by position.
function fieldRuns(positions) {
    const runs = [];
    for (const p of positions) {
        const last = runs[runs.length - 1];
        if (last !== undefined && last.constant === p.constant) {
            last.end = p.position;
            continue;
        }
        runs.push({ start: p.position, end: p.position, constant: p.constant });
    }
    return runs;
}

module.exports = {
    OVERFLOW,
    CLUSTER_TOLERANCE,
    CLUSTER_WIDTHS,
    MAX_CLUSTER_WIDTH,
    parseCaptures,
    clusterDurations,
    clusterOf,
    gapParity,
    separatorThreshold,
    separatorFloor,
    splitFrames,
    repairSpikes,
    scoreAlignment,
    inferAlignment,
    decodeFrame,
    renderFrame,
    framesAgree,
    analyseCapture,
    analyseCaptures,
    comparePositions,
    pairRepeats,
    fieldRuns,
    mean,
    median,
    modal,
};
