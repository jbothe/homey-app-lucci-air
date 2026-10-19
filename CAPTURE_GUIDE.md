# Recording the Lucci handset

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

Record **fourteen** times: each of the seven buttons, twice.

| Pass | Label to use |
|---|---|
| A | `Fan On/Off:` |
| A | `Fan Speed Up:` |
| A | `Fan Speed Down:` |
| A | `Fan Direction:` |
| A | `Light On/Off:` |
| A | `Light Brightness Up:` |
| A | `Light Brightness Down:` |
| B | `Fan On/Off (repeat):` |
| B | `Fan Speed Up (repeat):` |
| B | `Fan Speed Down (repeat):` |
| B | `Fan Direction (repeat):` |
| B | `Light On/Off (repeat):` |
| B | `Light Brightness Up (repeat):` |
| B | `Light Brightness Down (repeat):` |

**Pass B is the part that cannot be skipped**, and it is not simply insurance against a bad
recording. Two questions can only be answered by pressing the same button twice:

- **Is the code fixed, or does it roll?** A fixed-code remote sends the same frame every time, so
  Homey can replay it. A rolling-code remote changes the frame on every press, and cannot be cloned
  by replay at all — which would end this approach and is much better known now than after an app
  is written. If pass B differs from pass A for every button, that is the first thing to suspect.
- **Do the toggles depend on state?** `Fan On/Off` and `Light On/Off` are single buttons, so they
  are probably one code that the fan interprets against what it is currently doing. Record pass A
  with the fan running and pass B with it stopped (or the reverse), and the two readings settle it.
  If they agree, the button sends one code and Homey cannot know the fan's state from the air alone
  — which decides how the app models on/off, so it is worth getting now.

Do the two passes a few minutes apart rather than back to back, so a rolling code has reason to
have moved on.

## 2. Save

Put them in `captures/raw-captures.txt`, as a label line ending in a colon, then the durations.
Durations may run over as many lines as the recorder gives you. Lines beginning with `#` are
ignored, so notes are fine.

```
# Lucci handset, kitchen fan. Recorded 2026-10-19.
# Pass A with the fan running, pass B stopped.

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
| two readings per button, each seen several times | normal for some handsets — Bear's sends each command plain, then complemented. Both are real and both matter on receive |
| a reading seen once, marked uncorroborated | a glitched frame. Ignored, and harmless, unless it is all you have |
| `no clean frames` for a button | record it again, closer to the Homey |
| `No consistent frame structure found` | too short, too noisy, or not fixed-code. Record two or three buttons again before concluding anything |
| a symbol's spread flagged as too wide | two symbols may have been read as one, which would make everything below it wrong. Say so rather than shipping it |

If pass A and pass B disagree for every button, but each is internally consistent, re-record once
more and compare all three. A rolling code gives three different answers; a dirty capture usually
gives two that agree and one that does not.

## 5. Write it up

Once the readings are clean and agree, the output becomes two things, following the pattern of the
sibling apps:

1. `.homeycompose/signals/433/lucci.json` — the signal definition, as printed.
2. `RF_PROTOCOL.md` — what the frame means: which positions are the address, which carry the
   command, what each button's code is, and what the captures cannot settle.

Then the app itself, which is phase 2.

## What one handset cannot tell you

Every recording comes from one remote, so the analysis cannot distinguish a field that identifies
*this* handset from one that is the same on every Lucci remote ever made. It also cannot show
whether part of the address is really a fixed manufacturer prefix.

The field map is honest about a related limit: a position only reads as "command" if some button
moves it. A field that happens to hold still across all seven buttons will read as address until a
button that moves it is recorded — which is why the sibling Bear app reads 29 constant bits where
the protocol has 28, the 29th being a channel bit no channel on that handset ever sets.

Settling any of this needs a second, independently paired handset. Until then the reading is a
working hypothesis, and `RF_PROTOCOL.md` should say so.
