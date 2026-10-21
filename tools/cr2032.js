'use strict';

// Reads recordings of the CR2032 remote (Lucci Whitehaven, Rhine RH787NRN
// receiver) and answers the three questions the recordings can settle.
//
// The inference is pulses.js's, unchanged: it finds the preamble, the alphabet
// and the interval without being told. What it does not do, and this module
// does, is the part that depends on this remote being a different shape from
// the USB-C one:
//
//   * POLARITY. pulses.js numbers its symbols by the shorter FIRST duration of
//     the pair. Here a symbol is (gap, pulse) behind a one-pulse preamble, so
//     the first duration is a gap and "symbol 0" is the symbol with the LONG
//     pulse. Read naively, every code comes out as the bitwise complement of
//     the convention this remote was decoded in (long pulse = 1). Bits are
//     therefore assigned here from the pulse itself.
//   * BUTTONS, not recordings. Three presses of one button are one question.
//   * ABSOLUTE OR TOGGLE. Does the remote carry state, or send the same code
//     every time? Only consecutive presses of one button can say.
//   * WHICH BITS MOVE, and which move for no reason a button explains.
//
// Everything is a reading of the recordings in hand. See reportLines for what
// each finding can and cannot support.

const { analyseCaptures, modal } = require('./pulses');
const { chooseSensitivity, signalDefinition } = require('./signal');

// The recording plan, as the minimum that answers the questions. Names are
// matched case-insensitively, ignoring spaces.
const PLAN = [
    ...['I', 'II', 'III', 'IV', 'V', 'VI'].map(n => ({ name: `Speed ${n}`, presses: 2 })),
    // Three, not two: two presses that differ look the same whether the remote
    // alternates (absolute) or counts (rolling). The third press separates them.
    { name: 'Reverse', presses: 3 },
    { name: 'Light', presses: 3 },
    { name: 'Off', presses: 2 },
];

const normalise = name => name.toLowerCase().replace(/\s+/g, '');

// "Reverse (2)" and "Reverse #2" are the second press of "Reverse"; a label
// with no number is a button recorded once.
function buttonOf(label) {
    const match = label.match(/^(.*?)\s*(?:\(\s*(\d+)\s*\)|#\s*(\d+))$/);
    if (match === null) return { button: label.trim(), press: 1 };
    return { button: match[1].trim(), press: Number(match[2] || match[3]) };
}

// Which analyser symbol is bit 1: the one whose PULSE is longer.
//
// A frame is cut at the long gap between repeats, so it opens on a pulse, and
// duration `i` is a pulse when `i` is even. The body starts at `sofLength`, so
// the first duration of each pair is a pulse only when the preamble has an even
// number of durations. This remote has one, so the pair is (gap, pulse).
function polarity(alignment) {
    if (alignment.alphabet.length !== 2) return null;

    const pulseFirst = alignment.sofLength % 2 === 0;
    const symbols = alignment.alphabet.map(s => ({
        index: s.index,
        pulse: pulseFirst ? s.pulse : s.gap,
        gap: pulseFirst ? s.gap : s.pulse,
        first: s.pulse,
        second: s.gap,
    }));
    const [a, b] = symbols;
    if (a.pulse.mean === b.pulse.mean) return null;

    const long = a.pulse.mean > b.pulse.mean ? a : b;
    const short = long === a ? b : a;
    return {
        bitOf: index => (index === long.index ? 1 : 0),
        // Words in bit order, as the signal definition wants them: index = bit.
        words: [short, long].map(s => [s.first.mean, s.second.mean]),
        pulses: { short: short.pulse.mean, long: long.pulse.mean },
    };
}

const differingPositions = (a, b) => [...a].flatMap((c, i) => (c === b[i] ? [] : [i]));

// What a run of presses of one button says about the remote.
//
//   * the same every time: a stateless code, or a relative one (a toggle). The
//     recordings cannot tell those apart and the app does not need them to.
//   * alternating, A B A: absolute. The remote tracks the state and sends the
//     one it is moving to. Two codes cannot show this, which is why Reverse and
//     Light are asked for three times.
//   * anything else: it moves for a reason no button explains.
function verdictFor(codes) {
    if (codes.length < 2) return { kind: 'once', text: 'recorded once, so nothing can be said about it' };

    if (codes.every(c => c === codes[0])) {
        return {
            kind: 'same',
            text: `the same code on all ${codes.length} presses: stateless, or a relative toggle`
                + ' (a recording cannot tell those apart; the app does not need it to)',
        };
    }

    const alternates = codes.length >= 3
        && new Set(codes).size === 2
        && codes.every((c, i) => i < 2 || c === codes[i - 2]);
    if (alternates) {
        return {
            kind: 'alternates',
            text: `alternates between two codes over ${codes.length} presses: ABSOLUTE,`
                + ' the remote tracks the state and sends the one it is moving to',
        };
    }

    const where = [...new Set(codes.flatMap((c, i) => (i === 0 ? [] : differingPositions(codes[0], c))))].sort((x, y) => x - y);
    if (codes.length === 2) {
        return {
            kind: 'two-differ',
            text: `two presses differ (bit ${where.join(', ')}). Two cannot separate alternating (absolute) from`
                + ' counting (rolling) - record a third press',
        };
    }
    return {
        kind: 'moves',
        text: `${new Set(codes).size} different codes over ${codes.length} presses without alternating`
            + ` (bit ${where.join(', ')} differ): a counter or rolling bit, not a state`,
    };
}

// Reads blocks as { label, durations } and returns the whole analysis. Pure, so
// it can be tested against recordings built to a known answer.
function analyseRemote(blocks) {
    // shortestPreamble: this receiver's first symbols of a burst are noisy, and
    // the default tie-break rewards swallowing them into the preamble. Seen on
    // the first real OFF recording, which read as 7 durations of preamble and 21
    // symbols instead of 1 and 24.
    const result = analyseCaptures(blocks, { shortestPreamble: true });
    if (result.alignment === null) return { ok: false, reason: 'no-structure', result };

    const pol = polarity(result.alignment);
    if (pol === null) return { ok: false, reason: 'not-binary', result };

    const toBits = symbols => [...symbols].map(c => pol.bitOf(Number(c))).join('');

    const presses = result.reads.map(read => {
        const codes = read.distinct.map(([bits, count]) => ({ bits: toBits(bits), count }));
        return {
            label: read.label,
            ...buttonOf(read.label),
            frames: read.frames,
            whole: read.whole,
            unreadable: read.unreadable,
            interval: read.interval,
            sent: read.sent,
            codes,
            // One reading is a press; several is a recording holding more than
            // one, or a dirty one. Either way it is not a single code.
            code: codes.length === 1 ? codes[0].bits : null,
            // In the order sent, polarity corrected: how a recording holding
            // several presses shows what each one sent.
            order: read.runs.map(r => ({ bits: r.bits === null ? null : toBits(r.bits), count: r.count })),
        };
    });

    const buttons = new Map();
    for (const p of presses) {
        if (!buttons.has(p.button)) buttons.set(p.button, []);
        buttons.get(p.button).push(p);
    }
    for (const list of buttons.values()) list.sort((a, b) => a.press - b.press);

    const summary = [...buttons].map(([button, list]) => {
        const codes = list.map(p => p.code).filter(c => c !== null);
        return { button, presses: list, codes, verdict: verdictFor(codes) };
    });

    return {
        ok: true,
        alignment: result.alignment,
        polarity: pol,
        presses,
        buttons: summary,
        fields: fieldMap(summary),
        parity: parityOf(summary),
        coverage: coverage(summary),
        definition: definition(result, pol, presses),
    };
}

// Which bit positions are the same in every code, which move between buttons,
// and which move between presses of one button.
//
// Two kinds of the last, because they mean opposite things. A button that
// ALTERNATES (A B A) moves bits for a reason the user supplied - the remote is
// carrying state - and those bits are marked `~`. Any other movement between
// presses of one button is `!`: nothing the user pressed explains it, and it is
// the shape of a counter, a rolling code or - as bit 24 was on the USB-C
// remote - something the model does not have a name for yet.
function fieldMap(summary) {
    const all = summary.flatMap(s => s.codes);
    if (all.length === 0) return null;

    const width = Math.max(...all.map(c => c.length));
    const state = new Set();
    const unexplained = new Set();
    for (const s of summary) {
        const into = s.verdict.kind === 'alternates' ? state : unexplained;
        for (const c of s.codes) differingPositions(s.codes[0], c).forEach(i => into.add(i));
    }

    const mask = Array.from({ length: width }, (_, i) => {
        if (unexplained.has(i)) return '!';
        if (state.has(i)) return '~';
        return new Set(all.map(c => c[i])).size === 1 ? '.' : '^';
    }).join('');

    // Constant bits first, then everything from the first mover on.
    const prefix = mask.search(/[^.]/) === -1 ? width : mask.search(/[^.]/);
    return {
        mask,
        width,
        prefix,
        within: [...unexplained].sort((a, b) => a - b),
        state: [...state].sort((a, b) => a - b),
    };
}

// Whether every distinct code has the same weight.
//
// **This cannot separate parity from address.** Fan 1's bit 24 passed exactly
// this test on 33 recordings and was not parity: a second handset disproved it.
// One remote can only fail to rule parity out, or rule it out when the weights
// are mixed - and ruling it out is the only direction that is evidence.
function parityOf(summary) {
    const codes = [...new Set(summary.flatMap(s => s.codes))];
    if (codes.length === 0) return null;

    const weights = codes.map(c => [...c].filter(b => b === '1').length);
    const even = weights.filter(w => w % 2 === 0).length;
    return { codes: codes.length, even, odd: codes.length - even };
}

function coverage(summary) {
    const have = new Map(summary.map(s => [normalise(s.button), s]));
    return PLAN.map(({ name, presses }) => {
        const got = have.get(normalise(name));
        const readable = got === undefined ? 0 : got.codes.length;
        return { name, wanted: presses, readable, short: readable < presses };
    });
}

function definition(result, pol, presses) {
    const { alignment } = result;
    const { chosen } = chooseSensitivity(alignment.alphabet);
    const intervals = presses.map(p => p.interval).filter(i => i !== null);
    if (chosen === null || intervals.length === 0) return null;

    const symbolLength = Math.max(...presses.flatMap(p => p.codes.map(c => c.bits.length)));
    const base = signalDefinition({
        alignment,
        frameLength: symbolLength,
        interval: Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length),
        repetitions: modal(presses.map(p => p.sent)),
        sensitivity: chosen.sensitivity,
    });
    // In bit order, so that transmitting [0,1,...] means what it says.
    return { ...base, words: pol.words };
}

function reportLines(analysis) {
    const lines = [];
    const out = (...s) => lines.push(s.join(''));

    const { alignment, polarity: pol, presses, buttons, fields, parity } = analysis;

    out('## Frame');
    out('');
    out(`  preamble   ${alignment.sofLength} duration(s): ${alignment.sof.join(',')}`);
    out(`  pulses     short ${pol.pulses.short}us = bit 0, long ${pol.pulses.long}us = bit 1`);
    out('             (pulses.js numbers these the other way round; every code below is corrected)');
    out(`  body       ${alignment.bodyLength / 2} symbols`);
    out('');

    out('## What each press sent');
    out('');
    for (const p of presses) {
        const detail = `${p.whole} whole of ${p.frames} frames${p.unreadable > 0 ? `, ${p.unreadable} unreadable` : ''}`;
        if (p.code !== null) {
            out(`  ${p.label.padEnd(16)} ${p.code}  (${detail})`);
            continue;
        }
        out(`  ${p.label.padEnd(16)} ${p.codes.length === 0 ? 'NO READABLE FRAME' : `${p.codes.length} different readings`}  (${detail})`);
        for (const c of p.codes) out(`  ${''.padEnd(16)} x${String(c.count).padEnd(3)} ${c.bits}`);
        if (p.order.length > 1) {
            out(`  ${''.padEnd(16)} in the order sent: ${p.order.map(r => `${r.bits === null ? '?' : r.bits} x${r.count}`).join('  ->  ')}`);
        }
    }

    out('');
    out('## Per button: absolute or toggle');
    out('');
    for (const b of buttons) out(`  ${b.button.padEnd(10)} ${b.verdict.text}`);

    if (fields !== null) {
        out('');
        out('## Which bits move');
        out('');
        out('  .  same in every code        ^  moves between buttons');
        out('  ~  moves between presses of one button that ALTERNATES (state the remote carries)');
        out('  !  moves between presses of one button and is NOT explained by alternating');
        out('');
        out(`  ${fields.mask}`);
        out('');
        const moving = fields.mask.length - fields.prefix;
        out(`  ${fields.prefix} leading bits never change; ${moving} from bit ${fields.prefix} on can.`);
        if (fields.within.length > 0) {
            out('');
            out(`  Bit(s) ${fields.within.join(', ')} change between presses of the same button without alternating.`);
            out('  Nothing the user pressed explains that: it is the shape of a counter, a rolling code or a');
            out('  toggle bit. Settle it before building anything - a replayed fixed code would be ignored.');
        } else {
            out('  No bit moves between presses in a way alternating does not explain, so every code recorded');
            out('  is fixed and can be replayed.');
        }
        out('');
        out('  "Never changes" means never changes across the buttons recorded. A command bit no recorded');
        out('  button sets reads as address until one does (CAPTURE_GUIDE.md, "What one handset cannot tell you").');
    }

    if (parity !== null) {
        out('');
        out('## Parity (the bit-24 question)');
        out('');
        if (parity.odd === 0 || parity.even === 0) {
            const kind = parity.odd === 0 ? 'even' : 'odd';
            out(`  All ${parity.codes} distinct codes have ${kind} weight over the 24 bits. That is CONSISTENT with a`);
            out('  parity bit and equally with nothing at all, and one remote cannot tell the two apart.');
            out('  The USB-C remote passed exactly this test on 33 recordings and a second handset disproved it.');
        } else {
            out(`  ${parity.even} of ${parity.codes} distinct codes have even weight and ${parity.odd} odd, so NONE of the 24 bits`);
            out('  is a parity bit over the others, even or odd. That is real evidence, in the one direction');
            out('  a single remote can give it.');
        }
        out('');
        out('  Whether a bit identifies THE REMOTE rather than the command needs a second remote,');
        out('  which cannot be recorded. The design answer is not to need it: learn every bit that is the');
        out('  same across the buttons as the remote\'s identity, so a bit like 24 is stored whatever it means.');
    }

    out('');
    out('## Plan coverage');
    out('');
    for (const c of analysis.coverage) {
        out(`  ${c.name.padEnd(10)} ${c.readable} of ${c.wanted} readable presses${c.short ? '   <- record more' : ''}`);
    }

    if (analysis.definition !== null) {
        out('');
        out('## Candidate signal definition (words in bit order: index = bit)');
        out('');
        out(JSON.stringify(analysis.definition, null, 2).split('\n').map(l => `  ${l}`).join('\n'));
        out('');
        out('  No eof and no txOnly, deliberately - see tools/signal.js. Repetitions here is what the remote sent,');
        out('  not what the fan needs: that is a hardware question.');
    }

    return lines;
}

module.exports = {
    PLAN, buttonOf, polarity, verdictFor, analyseRemote, fieldMap, parityOf, reportLines,
};
