# Recording the CR2032 remote (Lucci Whitehaven, Rhine RH787NRN)

The general method is [`CAPTURE_GUIDE.md`](CAPTURE_GUIDE.md); this is the plan for the second kind of
remote, which has nine buttons and a different protocol. Nothing here needs the fan: the remote only
has to be in range of the Homey.

The remote has six independent speed buttons (I to VI), one forward/reverse, one light toggle and one
power-off. No timer, no brightness.

## What the recordings have to answer

| Question | What answers it |
|---|---|
| Which bits are address and which are command? | Bits that are the same across all nine buttons vs bits that move between them |
| Does any button carry state? | Consecutive presses of **Reverse** and **Light** |
| Is the code fixed, or does it roll or count? | The same button pressed again, with other buttons pressed in between |
| Is there a bit like bit 24 on the USB-C remote? | A bit that moves between presses of **one** button, and the parity of the codes |

## What to record

**One press per recording**, labelled `Name (n)`. Tap each button; do not hold it. A hold sends more
frames than a press and, within 60 seconds of the fan being powered, a held button is how the receiver
is paired. Leave 2-3 seconds between presses.

| # | Label | Why |
|---|---|---|
| 1-7 | `Speed I (1)` … `Speed VI (1)`, then `Off (1)` | First pass, in order |
| 8-14 | `Speed VI (2)` … `Speed I (2)`, then `Off (2)` | Second pass, **in the reverse order**, so a counter has moved on and cannot hide behind a fixed order |
| 15-17 | `Reverse (1)`, `Reverse (2)`, `Reverse (3)` | Back to back, nothing else pressed between them |
| 18-20 | `Light (1)`, `Light (2)`, `Light (3)` | Back to back, nothing else pressed between them |

That is 20 recordings, and it is the minimum: the analyser lists anything short of it.

**Why three presses of Reverse and Light, not two.** Two presses that differ look the same whether the
remote alternates (absolute: it tracks the direction and sends the one it is moving to) or counts (a
rolling code). A third press separates them: `A B A` is absolute, `A A A` is a toggle or stateless, and
`A B C` is a counter. The USB-C remote's direction was settled this way.

**Optional, cheap, worth it:** `Reverse (4)` recorded after pressing `Speed III` in between, to see
whether another button resets the remote's idea of the direction.

**Do not** record with the fan powered if you can avoid it: it needs nothing from the fan, and a fan
that is powered will respond to (and, per the manual, be slow about) every press.

## Saving and reading

Paste the recordings back, or save them yourself as `captures/fan2-cr2032.txt` in the format
`CAPTURE_GUIDE.md` describes (a label line ending in a colon, then the durations). The file is **not
committed**: `captures/*` in [`.gitignore`](.gitignore) already excludes it, and it carries the code
that drives the fan. Then:

```bash
npm run analyse:cr2032
```

[`tools/analyse-cr2032.js`](tools/analyse-cr2032.js) reuses the inference in `tools/pulses.js` (which
repairs the recorder's artefacts: invented transitions and a mistimed opening edge) and adds what that
tool lacks for this remote.

- **Polarity.** `pulses.js` numbers a symbol by its shorter *first* duration. Here a symbol is a gap
  then a pulse, so that numbering makes the long-pulse symbol 0 and reads every code as the bitwise
  complement of the convention this remote was decoded in (long pulse = 1). The new tool assigns bits
  from the pulse. `test/cr2032.test.js` pins this.
- **Per button**, not per recording: alternating, the same every time, or neither.
- **A bit map** with three marks. `.` is the same in every code, `^` moves between buttons, `~`
  moves between presses of a button that alternates (state the remote carries), and `!` moves between
  presses of one button for no reason alternating explains. `!` is the one to be afraid of.
- **Parity of the distinct codes**, reported in the one direction it is evidence (see below).

## What the recordings cannot settle

- **Whether a bit identifies the remote.** On the USB-C remote the 25th bit passed every test one
  handset could give it, including even parity over the other 24, and only a *second handset* showed
  it was neither parity nor constant. There is no second CR2032 remote to record, so a bit like that,
  if it exists, **cannot be found by recording.** The app's answer is not to need to know: store every
  bit that is the same across the buttons as the remote's identity, learned at pair time, so such a bit
  is carried whatever it means.
- **Address versus command where a command bit is never set.** Constant across nine buttons means
  constant across nine buttons. Six speeds, off, reverse and light can leave a command bit unexercised.
- **Whether the fan checks the address at all.** That is a hardware question, and so is how many
  repetitions the receiver needs.
