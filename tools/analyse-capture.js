#!/usr/bin/env node
'use strict';

// Reads a capture file off the Lucci Air handset and reports what it says about the
// protocol: frame structure, symbol alphabet, which positions hold still and
// which move between buttons, and a candidate Homey signal definition.
//
//   node tools/analyse-capture.js captures/raw-captures.txt
//
// Nothing here is a specification. It is a reading of the recordings, and every
// number comes with the spread it was measured over so it can be argued with.
// See CAPTURE_GUIDE.md for how to record, and RF_PROTOCOL.md for the reading
// that was settled on.

const fs = require('node:fs');
const {
    parseCaptures, analyseCaptures, fieldRuns, pairRepeats, modal, mean,
} = require('./pulses');
const { chooseSensitivity, signalDefinition } = require('./signal');

const file = process.argv[2] || 'captures/raw-captures.txt';
if (!fs.existsSync(file)) {
    console.error(`No such capture file: ${file}`);
    console.error('Record one first — see CAPTURE_GUIDE.md.');
    process.exit(2);
}

const blocks = parseCaptures(fs.readFileSync(file, 'utf8'));
if (blocks.length === 0) {
    console.error(`No labelled captures in ${file}.`);
    console.error('Expected a label line ending in a colon, then the durations. See CAPTURE_GUIDE.md.');
    process.exit(1);
}

const warnings = [];
const result = analyseCaptures(blocks);

// Repeats of one button are not separate buttons, and several of the checks
// below only mean anything once more than one button has been recorded.
const baseLabel = label => label.replace(/\s*\((?:repeat|repeated|again|2|b)\)$/i, '').toLowerCase();
const buttons = new Set(blocks.map(b => baseLabel(b.label))).size;

console.log(`# ${file}`);
console.log(`${blocks.length} capture${blocks.length === 1 ? '' : 's'}: ${blocks.map(b => b.label).join(', ')}`);

if (result.alignment === null) {
    console.log('\nNo consistent frame structure found.');
    console.log(`Frames were cut to a common length of ${result.frameLength} durations, but no preamble`);
    console.log('length explains the rest as a small alphabet of pulse/gap pairs.');
    console.log('\nUsually this means the capture is too short or too noisy — record again, closer to');
    console.log('the receiver. If it persists, the transmission may not be plain fixed-code: see');
    console.log('CAPTURE_GUIDE.md on rolling codes.');
    process.exit(1);
}

const { alignment, reads, positions } = result;
const symbolLength = Math.max(...reads.flatMap(r => r.distinct.map(([bits]) => bits.length)), 0);

// ---------------------------------------------------------------- structure --

console.log('\n## Frame structure\n');
console.log(`  preamble    ${alignment.sofLength} duration${alignment.sofLength === 1 ? '' : 's'}`
    + `${alignment.sofLength > 0 ? `: ${alignment.sof.join(',')}` : ''}`);
console.log(`  payload     ${symbolLength} symbols, from an alphabet of ${alignment.alphabet.length}`);
console.log(`  frame       ${result.frameLength} durations between separators`);

const intervals = reads.map(r => r.interval).filter(i => i !== null);
const interval = intervals.length > 0 ? Math.round(mean(intervals)) : null;
const separators = reads.map(r => r.separator).filter(i => i !== null);
const repetitions = modal(reads.map(r => r.sent));
console.log(`  repeats     ${repetitions} per press`);
if (interval !== null) {
    console.log(`  interval    ${interval}us between repeats`);
    if (alignment.bodyLength % 2 === 1) {
        console.log(`              (the recorder measures ${Math.round(mean(separators))}us, which includes the`);
        console.log("               last symbol's own gap — see the note in pulses.js)");
    }
}

console.log('\n## Symbol alphabet\n');
console.log('  sym   pulse (min-max)        gap (min-max)          seen');
for (const s of alignment.alphabet) {
    console.log(
        `  ${String(s.index).padEnd(4)}`
        + `  ${String(s.pulse.mean).padStart(5)} (${s.pulse.min}-${s.pulse.max})`.padEnd(23)
        + `  ${String(s.gap.mean).padStart(5)} (${s.gap.min}-${s.gap.max})`.padEnd(23)
        + `  ${s.count}`,
    );
}
if (alignment.alphabet.length === 2) {
    console.log('\n  Two symbols, so the payload is plain binary. Which one the handset calls');
    console.log('  zero is not something a capture can show; symbol 0 here is just the shorter');
    console.log('  pulse.');
} else {
    console.log(`\n  ${alignment.alphabet.length} symbols, so the payload is indices into a table rather than bits.`);
}

for (const s of alignment.alphabet) {
    for (const [half, c] of [['pulse', s.pulse], ['gap', s.gap]]) {
        if (c.suspect) {
            warnings.push(`symbol ${s.index}'s ${half} spans ${c.min}-${c.max}us, too wide for one`
                + ' duration — two symbols may have been clustered together, which would make'
                + ' every reading below wrong');
        }
    }
}

// ------------------------------------------------------------------- frames --

console.log('\n## What each button sent\n');
for (const r of reads) {
    const detail = `${r.whole} whole of ${r.frames} frames`
        + `${r.unreadable > 0 ? `, ${r.unreadable} unreadable` : ''}`;
    console.log(`  ${r.label}  (${detail})`);

    if (r.distinct.length === 0) {
        console.log('    no readable frame — record this one again');
        warnings.push(`"${r.label}" produced no readable frame`);
        continue;
    }
    for (const [bits, count] of r.distinct) console.log(`    x${String(count).padEnd(3)} ${bits}`);
    // Shown, not hidden: a reading no other repeat corroborates is kept out of
    // the field map, and saying so is what distinguishes a dirty capture from
    // a handset that really sends more than one form.
    for (const [bits, count] of r.discarded) {
        console.log(`    x${String(count).padEnd(3)} ${bits}  (uncorroborated, ignored)`);
    }

    // More than one reading, and the order is the finding rather than a fault:
    // the recorder keeps running, so a capture can hold several presses, and a
    // button that cycles through states shows its cycle here. Nothing else in
    // this report would reveal it.
    if (r.runs.length > 1) {
        console.log('    in the order sent:');
        for (const run of r.runs) {
            console.log(`      x${String(run.count).padEnd(3)} ${run.bits === null ? '(unreadable)' : run.bits}`);
        }
    }

    if (r.distinct.length > 1) {
        const cycles = r.runs.length > 2 && r.runs[0].bits === r.runs[r.runs.length - 1].bits;
        warnings.push(`"${r.label}" decoded ${r.distinct.length} different ways.`
            + (cycles
                ? ' The order sent returns to where it started, so this capture holds several'
                    + ' presses of a button that cycles through states — each needs its own label'
                : ' Either the capture holds more than one press, the handset alternates forms'
                    + ' within one press, or the capture is dirty — check the order sent above'));
    }
    if (r.distinct.some(([bits]) => bits.length !== symbolLength)) {
        warnings.push(`"${r.label}" has a frame of a different length to the rest`);
    }
}

// -------------------------------------------------------------------- fields --

console.log('\n## Field map\n');
const runs = fieldRuns(positions);
for (const run of runs) {
    const span = run.start === run.end ? `${run.start}` : `${run.start}-${run.end}`;
    const width = run.end - run.start + 1;
    console.log(`  [${span.padEnd(7)}] ${width.toString().padStart(3)} symbols  `
        + `${run.constant ? 'constant across every capture' : 'varies between captures'}`);
}

const constantPrefix = positions.findIndex(p => !p.constant);
if (constantPrefix > 0) {
    console.log(`\n  The leading ${constantPrefix} symbols never change. On a handset the fan learns`);
    console.log('  rather than one set by switches, that is the address: it identifies this');
    console.log('  handset, and the app stores it once at pair time.');
    console.log('\n  Suffixes, with that prefix stripped:\n');
    const width = Math.max(...reads.map(r => r.label.length));
    for (const r of reads) {
        for (const [bits, count] of r.distinct) {
            console.log(`    ${r.label.padEnd(width)}  ${bits.slice(constantPrefix)}  (x${count})`);
        }
    }
} else if (constantPrefix === 0) {
    warnings.push('the first symbol already varies between captures, so no address prefix was'
        + ' found — if the handset has no switches, check the captures are all from one handset');
}

if (buttons === 1) {
    console.log(`\n  Only one button has been recorded, so nothing here distinguishes the parts of`);
    console.log('  the frame that identify the handset from the parts that carry the command.');
    console.log('  That needs a second button. See CAPTURE_GUIDE.md.');
}

if (positions.every(p => p.constant) && buttons > 1) {
    warnings.push(`every position is constant across all ${buttons} buttons recorded, which cannot`
        + ' be right — check the captures are labelled correctly and are not the same recording'
        + ' pasted twice');
}

// How closely the reading fits what was recorded. A poor fit is the symptom of
// two symbols having been read as one, which no other check here would catch.
if (alignment.residual > 0.15) {
    warnings.push(`durations sit up to ${(alignment.residual * 100).toFixed(0)}% away from the symbol`
        + ' each was assigned to, which is a loose fit. Two symbols may have been read as one, or'
        + ' the handset is transmitting less consistently than it should');
}

// ----------------------------------------------------------------- repeats --

// Whether pressing the same button again sent the same thing. This is what
// decides whether the handset can be cloned at all: a fixed code can be
// replayed, a rolling one cannot, and no amount of work on the frame layout
// changes that. See CAPTURE_GUIDE.md.
const paired = pairRepeats(reads);

if (paired.length > 0) {
    console.log('\n## Pressed twice\n');
    for (const { label, agrees } of paired) {
        console.log(`  ${label.padEnd(Math.max(...paired.map(x => x.label.length)))}  `
            + `${agrees ? 'same frame both times' : 'DIFFERENT the second time'}`);
    }

    const differ = paired.filter(x => !x.agrees);
    if (differ.length === 0) {
        console.log('\n  Every button repeated itself, so the code is fixed and can be replayed.');
        console.log('  That is what makes a Homey app possible, and it is the main thing these');
        console.log('  recordings had to establish.');
    } else if (differ.length === paired.length) {
        warnings.push('every button sent something different the second time. Either all the'
            + ' captures are dirty, or the handset uses a rolling code — which cannot be cloned'
            + ' by replay, and would mean this approach does not work. Record a third pass before'
            + ' concluding anything: a rolling code gives three different answers, while dirty'
            + ' captures usually give two that agree and one that does not');
    } else {
        warnings.push(`${differ.length} of ${paired.length} buttons sent something different the`
            + ` second time (${differ.map(x => x.label).join(', ')}) while the rest repeated`
            + ' themselves. A rolling code would have moved for every button, so that is not this.'
            + ' Either those captures are dirty, or those buttons carry a value rather than a'
            + ' fixed code — a handset that tracks the speed, or the direction, and transmits the'
            + ' one it is moving to. Press each of them a third time: a dirty capture gives a'
            + ' third answer, while a value returns to an earlier one when the state does');
    }

    const missing = reads.filter(r => !/\(repeat/i.test(r.label)).length - paired.length;
    if (missing > 0) {
        console.log(`\n  ${missing} button(s) were only recorded once, so they were not checked.`);
        console.log('  CAPTURE_GUIDE.md asks for two passes for a reason.');
    }
}

// ------------------------------------------------------------- sensitivity --

console.log('\n## Sensitivity\n');
console.log('  Homey matches a received (pulse, gap) against each symbol within a fractional');
console.log('  window. Too tight and real frames are rejected; too loose and the windows');
console.log('  overlap, two symbols both match, and nothing decodes.\n');
console.log('  value   verdict');
const { chosen, usable, tried } = chooseSensitivity(alignment.alphabet);
for (const t of tried) {
    const why = t.ambiguous.length > 0
        ? `symbols ${t.ambiguous.map(([i, j]) => `${i}/${j}`).join(', ')} become ambiguous`
        : (t.excluded.length > 0
            ? `too tight: excludes measured durations for symbol ${t.excluded.map(s => s.index).join(', ')}`
            : 'usable');
    console.log(`  ${t.sensitivity.toFixed(2)}    ${why}`);
}
if (chosen === null) {
    warnings.push('no tolerance in the usual range both separates the symbols and admits every'
        + ' measured duration — the alphabet may be misread, or the capture is unusually noisy');
} else {
    const range = usable.map(t => t.sensitivity.toFixed(2)).join(', ');
    console.log(`\n  Usable: ${range}.`);
    console.log(`  Taking ${chosen.sensitivity.toFixed(2)}, the middle of that run — furthest from rejecting a handset`);
    console.log('  whose timing differs from this one, and from the symbols becoming ambiguous.');
}

// ---------------------------------------------------------------- definition --

if (chosen !== null && interval !== null) {
    console.log('\n## Candidate signal definition\n');
    console.log('  .homeycompose/signals/433/lucci.json\n');
    const definition = signalDefinition({
        alignment,
        frameLength: symbolLength,
        interval,
        repetitions,
        sensitivity: chosen.sensitivity,
    });
    console.log(JSON.stringify(definition, null, 2).split('\n').map(l => `  ${l}`).join('\n'));
    console.log('\n  No eof and no txOnly, deliberately — see the note in tools/signal.js.');
}

// ------------------------------------------------------------------ warnings --

console.log('\n## Warnings\n');
if (warnings.length === 0) {
    console.log('  None. Every capture cut into frames of one length, decoded into one small');
    console.log('  alphabet, and agreed with its own repeats.');
} else {
    for (const w of warnings) {
        const [first, ...rest] = w.split(/\s+/).reduce((lines, word) => {
            const last = lines[lines.length - 1];
            if (last !== undefined && `${last} ${word}`.length <= 76) lines[lines.length - 1] = `${last} ${word}`;
            else lines.push(word);
            return lines;
        }, []);
        console.log(`  - ${first}`);
        for (const line of rest) console.log(`    ${line}`);
    }
}

// A capture that produced no separator at all never saw a second frame, which
// is the one cross-check available without recording again.
const single = reads.filter(r => r.whole < 2);
if (single.length > 0) {
    console.log(`\n  ${single.length} capture(s) hold fewer than two whole frames, so their repeats`);
    console.log('  could not be checked against each other: ' + single.map(r => r.label).join(', '));
}

console.log('');
