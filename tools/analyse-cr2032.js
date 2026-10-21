#!/usr/bin/env node
'use strict';

// Reads a capture file off the CR2032 remote (Lucci Whitehaven, Rhine RH787NRN).
//
//   node tools/analyse-cr2032.js captures/fan2-cr2032.txt
//
// The file format is CAPTURE_GUIDE.md's: a label line ending in a colon, then
// the durations. Label each press "Button (n)" - "Reverse (1)", "Reverse (2)" -
// so that consecutive presses of one button are read together. See
// CAPTURE_GUIDE_CR2032.md for what to record and why.
//
// The capture file is not committed: it carries the code that drives the fan.

const fs = require('node:fs');
const { parseCaptures } = require('./pulses');
const { analyseRemote, reportLines } = require('./cr2032');

const file = process.argv[2] || 'captures/fan2-cr2032.txt';
if (!fs.existsSync(file)) {
    console.error(`No such capture file: ${file}`);
    console.error('Record one first - see CAPTURE_GUIDE_CR2032.md.');
    process.exit(2);
}

const blocks = parseCaptures(fs.readFileSync(file, 'utf8'));
if (blocks.length === 0) {
    console.error(`No labelled captures in ${file}.`);
    process.exit(1);
}

console.log(`# ${file}`);
console.log(`${blocks.length} recording${blocks.length === 1 ? '' : 's'}\n`);

const analysis = analyseRemote(blocks);
if (!analysis.ok) {
    if (analysis.reason === 'not-binary') {
        console.log('The recordings read as an alphabet of more or fewer than two symbols, or two that differ');
        console.log('only in their gaps. This tool reads plain binary with a pulse-width difference; use');
        console.log('tools/analyse-capture.js for the general case.');
    } else {
        console.log('No consistent frame structure found. Too short, too noisy, or not fixed-code:');
        console.log('record two or three buttons again, closer to the Homey, before concluding anything.');
    }
    process.exit(1);
}

console.log(reportLines(analysis).join('\n'));
console.log('');
