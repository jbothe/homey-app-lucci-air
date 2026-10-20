# Recording the Lucci Air handset

Phase 1: get the handset's transmissions onto disk, and turn them into a signal profile the
Homey app can use. Nothing here needs the fan — only the remote, in range of the Homey.

The analysis is done by [`tools/analyse-capture.js`](tools/analyse-capture.js), which assumes
nothing about the protocol: it infers where frames start, how many symbols the alphabet has and
how long they are, straight from the durations. It was checked against the sibling
[Bear handset](https://github.com/jbothe/homey-bear-blind-automation) recordings, where the answer
is already known and documented, and recovers that protocol's preamble, alphabet, frame length,
repeat count, interval and tolerance without being told any of them.

## 1. Record

Open **Homey Developer Tools** (`tools.developer.homey.app`), sign in, and find the **signal
recorder** under the RF or 433 MHz tools. Put the handset within a metre or so of the Homey, press
one button once, and copy out the list of numbers it produces — raw pulse and gap durations in
microseconds, one press per recording.

Record **every button, several times each**. The handset has eight controls, not the seven a
glance suggests — the timer is easy to miss:

| Control | What to record |
|---|---|
| Power (off) | 2 presses, one with the fan running and one with it already off |
| Light on/off | 2 presses, one in each light state |
| Fan speed up | the whole ladder: from the minimum, one press per step to the top |
| Fan speed down | one press at the bottom, to catch the minimum step |
| Fan direction | 3 presses, so the third can be checked against the first |
| Timer | 4 or 5 presses in a row, enough to go round the cycle and close it |
| Brightness up | 2 presses, at opposite ends of the range |
| Brightness down | 2 presses, at opposite ends of the range |

**Pressing each control more than once is the part that cannot be skipped**, and not merely as
insurance against a bad recording. Three questions can only be answered by repeating a press:

- **Is the code fixed, or does it roll?** A fixed-code handset sends the same frame every time, so
  Homey can replay it. A rolling-code one changes the frame on every press and cannot be cloned by
  replay at all — which would end this approach, and is much better known now than after an app is
  written.
- **Is the control stateless, or does it carry a value?** This handset's power and light buttons
  send one fixed code. Its speed, direction and timer buttons do not: the handset tracks the state
  and transmits the one it is moving to, so every position needs its own recording. The giveaway was
  speed *up* on one press sending exactly what speed *down* had sent on another — a relative
  command can never equal its own opposite. The test is a third press: a dirty capture gives a third
  answer, while a value returns to an earlier one when the state does.
- **Or is it relative after all?** The brightness buttons send one code for brighter and one for
  dimmer whatever the level, because the fitting tracks the light and the handset does not. Two
  recordings at each end of the range settle it: identical codes mean relative, different codes mean
  a ladder.

One recording may hold several presses — the recorder keeps running — and that is useful rather
than a problem. `npm run analyse` lists readings **in the order they were sent**, so a button that
cycles shows its cycle, and a cycle closing is visible as the first and last reading agreeing. That
is how the timer's four states were mapped.

Leave a little time between repeats of the same button rather than pressing back to back, so a
rolling code has reason to have moved on.

## 2. Save

Put them in `captures/raw-captures.txt`, as a label line ending in a colon, then the durations.
Durations may run over as many lines as the recorder gives you. Lines beginning with `#` are
ignored, so notes are fine.

```
# Lucci Air handset, kitchen fan. Recorded 2026-10-19.
# Fan running and light on unless a block says otherwise.

Fan On/Off:
4770,1538,332,752,690,392,...,65535

Fan Speed Up:
4770,1538,...
```

That file is **not committed** — [`.gitignore`](.gitignore) excludes `captures/`. It carries the
code that operates your fan, and anyone within 433 MHz range who has it can drive it.

## 3. Analyse

```bash
npm run analyse
```

It prints what the recordings say: the frame structure, the symbol alphabet with the spread each
duration was measured over, what each button sent, which positions hold still across every button
and which move, a workable tolerance, and a candidate signal definition.

Then read the **Warnings** section before anything else. It is the part that says whether the
reading can be trusted.

## 4. Judge the captures

A capture is good when its repeats agree. Within one press the handset sends the same frame several
times, so the repeats are a free cross-check — the only one available without recording again.

| What the report says | What it means |
|---|---|
| one reading per button, seen several times | clean; this is what to aim for |
| several readings, each seen several times | usually one recording holding several presses — check the order sent, printed below the readings. On some handsets it is instead one press sending two forms, as Bear's does (plain, then complemented), and both matter on receive |
| a reading seen once, marked uncorroborated | a glitched frame. Ignored, and harmless, unless it is all you have |
| `no clean frames` for a button | record it again, closer to the Homey |
| `No consistent frame structure found` | too short, too noisy, or not fixed-code. Record two or three buttons again before concluding anything |
| a symbol's spread flagged as too wide | two symbols may have been read as one, which would make everything below it wrong. Say so rather than shipping it |

If pass A and pass B disagree for every button, but each is internally consistent, re-record once
more and compare all three. A rolling code gives three different answers; a dirty capture usually
gives two that agree and one that does not.

## 5. Write it up

For this handset that is done: [`RF_PROTOCOL.md`](RF_PROTOCOL.md) has the frame layout, the sixteen
command codes and what each control does, and
[`.homeycompose/signals/433/lucci.json`](.homeycompose/signals/433/lucci.json) is the signal
definition the analyser produced.

Re-recording is still worth doing if a fan does not respond, or to settle something the caveats in
`RF_PROTOCOL.md` leave open — most of which need a **second handset** rather than more recordings
from this one.

## What one handset cannot tell you

Every recording comes from one remote, so the analysis cannot distinguish a field that identifies
*this* handset from one that is the same on every Lucci Air remote ever made. It also cannot show
whether part of the address is really a fixed manufacturer prefix.

The field map is honest about a related limit: a position only reads as "command" if some button
moves it. A field that happens to hold still across all seven buttons will read as address until a
button that moves it is recorded — which is why the sibling Bear app reads 29 constant bits where
the protocol has 28, the 29th being a channel bit no channel on that handset ever sets.

Settling any of this needs a second, independently paired handset. Until then the reading is a
working hypothesis, and `RF_PROTOCOL.md` should say so.
