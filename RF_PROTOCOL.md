# Lucci fan handset 433 MHz RF protocol

Reverse-engineered from 33 recordings off a single Lucci ceiling-fan handset, taken with Homey's
built-in RF signal recorder. Every button is covered, and every code below was seen in at least two
independent recordings.

This is a working hypothesis, not a manufacturer specification. Treat the structure section as a
guide for decoding further commands, and the caveats as the list of things one handset cannot
settle.

**The fan has now answered.** Homey paired off this handset, and the fan's power and all six speed
steps are confirmed on the hardware — the frame layout, the address, the symbol alphabet, the timing
profile and the absolute speed ladder, not merely consistent with the recordings but driving a real
fan. Direction, the timer and the light have still only been listened to; see the caveats.

## Frame layout

Every frame is a 19-duration preamble followed by 25 bits:

```
[ 0..15  ]  address    identifies the handset, same for every button
[ 16..17 ]  selector   10 for the fan, 01 for the light. Never 00 or 11
[ 18..23 ]  command    which button, and for most of them which value
[ 24     ]  always 0   see "Bit 24" below
```

The app stores one address per paired device and prepends it to a command's 9-bit tail.

## Signal definition

[`.homeycompose/signals/433/lucci.json`](.homeycompose/signals/433/lucci.json), compiled into
`app.json` as `signals.433.lucci`. One definition serves both transmit and receive: the properties
that differ between the two directions (`repetitions`, `sensitivity`, `rxTimeout`) each only affect
one of them.

| Property | Value | Notes |
|---|---|---|
| `sof` | `497,590` nine times, then `497` | ten pulses, nine gaps, in us |
| `words` | `[295,797]`, `[790,301]` | index 0 is bit `0`, index 1 is bit `1` |
| `interval` | `9448` | gap between repetitions |
| | `repetitions` | `9` | transmit only; matches the handset, and sets the 423ms airtime of one press |
| `sensitivity` | `0.2` | match tolerance (receive), see below |
| `rxTimeout` | `255` | receive only; a frame is ~37.6ms, well past the 10ms default |
| `minimalLength` / `maximalLength` | `24` / `25` | see "Receiving" below |

There is deliberately **no `eof`**, and no `txOnly`. See "Receiving".

Which symbol the handset calls zero is not something a capture can show. Bit `0` here is simply the
shorter pulse, and every code in this document is written in that convention.

### Measured timings

Across all 33 recordings:

| | median | min | max | seen |
|---|---|---|---|---|
| preamble pulse | 496 | 486 | 514 | 2831 |
| preamble gap | 596 | 578 | 636 | 2546 |
| bit `0` pulse / gap | 295 / 797 | 276 / 782 | 316 / 818 | 2987 |
| bit `1` pulse / gap | 790 / 301 | 772 / 280 | 812 / 320 | 3650 |

Both symbols run ~1091us, so a 25-bit payload is 27.3ms whatever it carries. With the preamble a
frame is 37.6ms, and nine repeats 9.4ms apart occupy about 423ms of airtime.

**The preamble is transmitted as a uniform `497,590`, not as the per-position values measured.**
Positions 6 to 18 are tight — pulses 494-498, gaps 588-596 — while positions 0 to 5 drift (the
first gap measures 612 against 588 at the end) and 20 to 25 frames per position had to be discarded
there entirely. That pattern is the receiver settling at the start of a burst, not the handset
changing its timing, so the stable region is the better estimate of what actually goes out.

## One press is 423ms, and that is a transmit-side constraint

Nine repetitions at 47ms each — a 37.6ms frame plus the 9448us interval — so **a press occupies
423ms of air.** The figure appears above as a timing; it matters as a rule.

`signal.tx()` resolves when Homey has *queued* a transmission, not when it has finished. So anything
that awaits `tx` and immediately transmits again lays one burst on top of the last, and **the
receiver reads a continuous stream of one code as a button held down rather than as several
presses.** Two toggles 134ms apart moved the light once; the fan's own sequences at 636ms and 716ms
apart were heard correctly, which is the same rule seen from the other side.

So consecutive presses are spaced 573ms apart, start to start: the 423ms of airtime plus a 150ms
silence for the button to come up. There is no measurement of the fitting's own release threshold —
only that 636ms worked and 134ms did not.

This is the mirror of the caution about `repetitions`. Transmitting *longer* than the handset made a
sibling app's receiver count one command as two presses; transmitting *sooner* than the handset makes
this one count two commands as a single press.

## Commands

Sixteen codes, all distinct. `sel` is bits 16-17, `command` bits 18-23; bit 24 is `0` throughout.

### Fan — selector `10`

| Command | command bits | full 9-bit tail |
|---|---|---|
| Off | `101010` | `101010100` |
| Speed step 0 (minimum) | `000001` | `100000010` |
| Speed step 1 | `000010` | `100000100` |
| Speed step 2 | `000111` | `100001110` |
| Speed step 3 | `001011` | `100010110` |
| Speed step 4 | `001101` | `100011010` |
| Speed step 5 (maximum) | `010000` | `100100000` |
| Direction forward | `100011` | `101000110` |
| Direction reverse | `100000` | `101000000` |
| Timer cancel | `110111` | `101101110` |
| Timer 2 hours | `111011` | `101110110` |
| Timer 4 hours | `111101` | `101111010` |
| Timer 8 hours | `111110` | `101111100` |

### Light — selector `01`

| Command | command bits | full 9-bit tail |
|---|---|---|
| On/off | `000100` | `010001000` |
| Brighter | `001000` | `010010000` |
| Dimmer | `001011` | `010010110` |

The light's "dimmer" tail is `001011`, which is also fan speed step 3's. They are told apart only by
the selector — which is the best evidence that the selector field is real, rather than a coincidence
of the four fan buttons that first suggested it.

### The timer is a walking zero

The timer's four states are `11` in bits 18-19, then a single zero walking across bits 20-23:

| State | bits 20-23 |
|---|---|
| cancel | `0111` |
| 2 hours | `1011` |
| 4 hours | `1101` |
| 8 hours | `1110` |

The cycle runs cancel → 2h → 4h → 8h → cancel. One recording caught five presses and closed the
cycle, which is what fixed the mapping; two further recordings, entering the cycle at different
points, agree.

### The speed codes are a table, not a counter

As integers the six speed codes are 1, 2, 7, 11, 13 and 16 — monotonic with speed, but not a
counter and not any rule derivable from six samples. **They are stored literally.** An earlier
reading of five of them looked like a 4-bit counter in bits 18-21; the sixth, at the bottom of the
range, shares `0000` with step 1 and disproves it.

## What the handset tracks, and what it does not

This is the most consequential finding here, and it differs per control.

| Control | Behaviour | Codes |
|---|---|---|
| Fan off | stateless — one code, confirmed over four presses in both fan states | 1 |
| Light on/off | stateless — one code, confirmed over four presses in both light states | 1 |
| Fan speed | **absolute** — the handset tracks the step and sends the one it is moving to | 6 |
| Fan direction | **absolute** — sends the direction it is moving to | 2 |
| Timer | **absolute** — sends the state it is moving to | 4 |
| Light brightness | **relative** — one code for brighter, one for dimmer, at any level | 2 |

Fan speed is absolute, and the proof is that **speed up on one press transmitted exactly what speed
down had transmitted on another.** A relative command can never equal its own opposite. Walking the
six steps up from the minimum then produced six distinct codes, and every earlier speed recording
slots into that ladder.

Direction was settled the same way, by a third press: presses 1 and 3 both took the fan forward to
reverse and are bit-identical, while press 2 (reverse to forward) differs.

Brightness is the exception. Four recordings were taken at the two ends of a range of about twenty
steps — brightest and dimmest — and both "up" presses sent one code while both "down" presses sent
the other. So the fitting tracks the light's level, and the handset does not.

**For the app this means fan speed, direction and the timer can be commanded absolutely and known
afterwards, while brightness can only be stepped.** A Homey `dim` capability for the light would
have to count its own steps and would drift from reality the first time anyone touched the handset.
Offering the light as on/off plus brighter/dimmer actions reports only what is true.

## Bit 24

**Bit 24 is not parity. It is not a constant zero either. What it is remains unknown.**

Across the 33 recordings the bit is `0` in all sixteen codes, and bits 0-23 hold an even number of
ones in all sixteen — so it was consistent with **even parity over the preceding 24** and equally
consistent with a constant zero, and nothing in those recordings separated the two. The call was
even parity, on the grounds that it reproduced every recording exactly and would be likelier to be
right on a handset whose address had odd weight.

**The radio disproved it.** With the receiver on all day, frames arrived in their thousands reading

```
rx light.onoff with bit 24 set where even parity wants 0
rx fan.speed.5 with bit 24 set where even parity wants 0
```

That message can only mean two things at once: bits 0-23 held an **even** number of ones, and bit 24
was **1**. Even parity forbids the combination, and so does a constant zero. Both candidates are
gone.

An odd-weight address does not explain it either, which is worth stating because it was the
predicted escape: an odd-weight address under even parity gives bit 24 `1` *and* agreement, so such
a frame logs nothing at all.

### What it probably is

These frames came from a transmitter whose address is not the paired one — the fan device never
mirrored them, so `sameAddress` rejected every one. This household has more than one Lucci fan. The
likeliest reading is therefore that **bit 24 identifies the handset or the fitting**, a 25th bit of
addressing rather than a check over the 24 before it, and that this household's two handsets differ
in it. That would also settle, in the affirmative, the caveat below about a field that identifies
*this* handset: there is now evidence of a per-unit bit, just not of what else it might encode.

It is a reading and not a finding. Settling it needs the second handset's own recordings, which
would show whether its bit 24 is constant across all sixteen of its commands — that is the test, and
it is the same test the first handset was put to.

**The app no longer depends on the answer.** It learns the bit rather than deriving it, so it is
right about bit 24 whether the bit identifies a handset, a fitting, a production batch or something
nobody has thought of. What remains unknown is what it *means*, which matters for documenting the
protocol and not for driving a fan.

### What the app does about it

- **Transmitting sends the bit the handset was heard to send, and nothing else.** It is learned at
  pair time alongside the address and stored with it, because the only sound source for a bit that
  follows no rule is the transmitter that produced it. There is **no fallback**: `buildFrame` refuses
  a frame without it, and a device with none stored makes itself unavailable with the same remedy as
  a missing address. A guessed bit on the air would look like a working device driving nothing, which
  is the worse failure.
- **Pairing therefore needs a complete frame.** The two truncations this receiver produces lose
  opposite ends — the leading one drops address bit 0, the trailing one drops bit 24 — and neither is
  recoverable, so neither is enough to pair on. The full-length frame arrives inside the same press.
- **A learn step sees one press, so it learns one sample of the bit.** Whether a handset holds it
  constant across its sixteen commands is checked at runtime instead, where there are thousands of
  frames to check against: a received frame whose bit 24 disagrees with what the device stores is
  logged once, and that line is what would show the bit varies by command rather than by handset.
  Nothing has disagreed yet.
- **Receiving never enforced the bit, which is why the app kept working through the discovery.** The
  decision was made before any of this was known, on the grounds that the bit adds a single bit of
  discrimination over the length, the selector and the command tail. Frames that disagreed with the
  parity rule were acted on rather than mistaken for someone else's traffic, and their disagreement
  is what disproved the rule.
- **A dropped leading bit is no longer recoverable.** It used to be, exactly: `R = F[1..24]`, so
  `F[0] = R[23] XOR (R[0] ... R[22])` restored address bit 0 from the parity bit. With parity gone
  that is a coin toss on one address bit, so such a frame is marked `addressSure: false` and every
  caller that decides whose frame it is refuses it — pairing, and both devices' receive paths. The
  command is still named in the log, which costs nothing and is occasionally useful.
- **The log that found it is gone**, having done its job: it compared every frame against a rule now
  known to be false. What replaced it is narrower and says more — each device compares an arriving
  bit 24 against the one it learned, which is a question still open rather than one already answered.

## Receiving

Four things are needed, all carried over from the sibling
[RC300](https://github.com/jbothe/homey-heatnglo-rc300) and
[Bear](https://github.com/jbothe/homey-bear-blind-automation) apps, where each was found the hard
way. All four give the same symptom — `enableRX()` resolving while nothing reaches a device.

**1. The driver must declare itself an RF receiver**, in `driver.compose.json`:

```json
"rf433": { "satelliteMode": true }
```

**2. The signal must omit `eof`.** Homey will not match an incoming frame against a definition
declaring an `eof` unless it observes that eof on air.

**3. `sensitivity` must keep the two symbols apart.** It is a fractional tolerance, so a value that
sounds safely permissive can make the alphabet ambiguous:

| sensitivity | verdict |
|---|---|
| 0.10 - 0.40 | usable |
| 0.50 | bit `0` and bit `1` become ambiguous |

`0.2` is the middle of the usable run — as far as possible from rejecting a handset whose timing
differs from this one, and from the symbols becoming undecidable.

**4. `minimalLength` allows 24 symbols as well as 25.** This was written as insurance against the
Bear handset's behaviour, where the receiver never closes the final word and drops it. **The radio
then showed that it is not insurance at all, and that the truncation is at the other end.**

The first time the app heard the handset, one press of Fan Off arrived as two frames 38ms apart: a
24-symbol one, then a full 25-symbol one. The short one was the real frame **minus its leading
bit** —

```
sent      0101110011110011 10 101010 0
delivered  101110011110011101010100
```

— which is the receiver's gain settling at the start of a burst, the same artefact the recorder
shows in the first few preamble positions. Read as though the *trailing* bit were missing, those 24
symbols decode as selector `01` and command `010100`: a light button that does not exist. That is
exactly what the driver's unrecognised-frame log reported, and it is what the log line is for.

**A dropped leading bit was briefly recoverable from the parity bit** — `R = F[1..24]`, so
`F[0] = R[23] XOR (R[0] ... R[22])` — and that recovery was verified against the frame above,
restoring address bit `0` exactly. It rested entirely on bit 24 being parity, which it is not; see
"Bit 24". The guess is still made, because it is right whenever the transmitter's bit 24 is `0` and
because naming the command in a log costs nothing, but the frame is marked `addressSure: false` and
every caller that decides identity refuses it. Both truncations are still tried: the trailing one
loses only bit 24, which the app uses nothing from, so those frames identify as firmly as full ones.

The cost is that 24 symbols discriminate less than 25, since two 8-bit windows are each held against
the sixteen known tails rather than one. A pattern that is not ours can shift into one that is — but
it reaches the bit check only after matching the preamble, both symbol windows at 0.2 tolerance, the
interval and the length, and a frame carrying the wrong address is then rejected by the device. The
one place it is not is pairing, which has no stored address to check against — it is what
establishes one.

So **pairing prefers a full-length frame**: it holds a reconstructed one briefly and takes a full one
if it arrives. Observed doing exactly that on the hardware — a restored frame, then the full frame
70ms later, which won:

```
matched fan.off on a restored frame; holding 750ms for a full one
matched fan.off on a full frame; address: 0101110011110011
```

Both of those were flagged as the start of a burst, so the pairing view counted two signals for one
press. That is why its label reads "Signals heard" rather than presses.

**Pairing now requires the full frame rather than merely preferring it**, since the restored one's
address bit 0 became a guess. On this receiver that costs nothing — the full-length twin arrives
within the same press — and it makes a receiver that only ever delivers 24 symbols unpairable, which
is the better failure: it is loud and says so, where a guessed address gives a device that is added,
looks right and never works.

**Homey does not hear its own transmissions.** Checked with the receiver on for the life of the
device and a dozen commands sent: no received frame followed any of them. That matters less to the
fan, whose commands are all absolute, than to the light, whose brighter and dimmer are relative — an
echo there would have counted every press twice.

## Addressing and pairing

Positions 0-15 never change, across every button and every recording, which makes them the
per-handset address. The handset has no DIP switches or channel selector; the fan learns it.

The app should therefore **learn the address from the user's own handset at pair time** rather than
shipping one. Listen on 433 MHz, wait for a 25-bit frame whose selector is `10` or `01` and whose
command tail is one of the sixteen known, and keep the leading 16 bits. Matching on that structure
is what stops pairing latching onto an unrelated 433 MHz device in range.

This clones the existing handset rather than inventing an address and teaching it to the fan, so it
needs only the remote the user already has and leaves the fan's own pairing untouched.

## Captures

The recorder output is **not committed**: it carries the code that operates the fan, and anyone
within 433 MHz range who has it can drive it. Keep your own at `captures/raw-captures.txt`, which
[`.gitignore`](.gitignore) excludes. See [`CAPTURE_GUIDE.md`](CAPTURE_GUIDE.md) for how to record,
and run `npm run analyse` to read it.

### What the recorder does to the signal

Two artefacts matter, and both are handled in [`tools/pulses.js`](tools/pulses.js) rather than
worked around by hand:

- **It invents transitions inside a pulse**, reporting one 480us pulse as `262,208,10`. Unrepaired
  this costs the whole reading, not just the frame: each invented transition lengthens its frame,
  the extra durations fall at a different offset in each repeat, and no single preamble length then
  explains them all. One recording decoded as "no structure found" entirely for this reason.
- **It mistimes the opening edge of a frame**, reporting `49,390` or `333,744` where the handset
  sent `493,610`. Those durations are junk but the payload behind them is at its proper offset, so
  the frame reads perfectly. Judging the preamble against the median repeat rather than requiring
  every repeat to agree is what keeps those frames.

Across the 33 recordings, 6 to 9 of each press's 9 frames decode cleanly and agree. The residual
mismatch against the shipped profile is 88% of frames reproduced on the payload, with 63 of the 72
preamble mismatches confined to the first four positions — that is, to the artefact above.

## Caveats

- **One handset.** The recordings cannot distinguish a field that identifies *this* handset from one
  identical on every Lucci remote, and cannot show whether part of the address is a fixed
  manufacturer prefix. Settling it needs a second, independently paired handset.
- **Bit 24** is unresolved, as above.
- **The encoding of bits 18-23 is not derived.** Sixteen codes are known and tabulated; the rule
  that generates them is not. A seventeenth command cannot be synthesised, only captured.
- **"Up at maximum" rests on one clean frame.** It repeats step 5, so the ladder appears to top out
  rather than wrap, but that is the weakest claim here. It does not affect the app, which never
  needs to send a relative step.
- **Every fan code has now been sent, and the fan answered all of them.** Pairing, the off code,
  five of the six speed steps, both direction codes and all four timer states — commanded from
  Homey, and each doing what the table says. Speed step 4 is the only code never transmitted, and it
  sits between two that were. **The three light codes remain unsent** — the light driver is written
  and its codes are built the same way from the same tables, which is reason to expect them to work
  and not evidence that they do.
- **The light keeps its brightness across off and on.** Observed: a move was interrupted by turning
  the light off at about half, and it came back on at about half. So the level lives in the fitting
  and survives the toggle, which is why Homey's position estimate is not thrown away when the light
  goes off — and why a stale estimate stays wrong rather than being reset by a power cycle.
- **A direction code starts a stopped fan**, confirmed, so it is a power command as much as a
  setting. **Whether a timer code does is still unknown** — it has only been sent to a fan already
  running, and a direction code's behaviour is no evidence about it.
- **What speed the fan starts at when a direction code starts it is unknown and unknowable.** The
  fan picks one, nothing reports it, and no speed code was involved. So Homey's speed is a guess
  from that moment until the next speed command or overheard press. This is the one place the app
  knowingly shows something it cannot stand behind, and the alternative — sending a speed code
  alongside, to force the matter — would override a choice the user did not make.
- **A speed code starts the fan from off**, which the handset's behaviour implied and the radio now
  confirms. It is what makes Homey's asymmetric `onoff` honest: there is no "fan on" code, and
  sending a speed is how the fan is started.

## The discrete on/off experiment: answered, and the answer is no

The light has one stateless toggle code and no discrete on or off, which is why Homey's `onoff` for
it is a belief rather than a fact. A discrete on and a discrete off would have fixed that properly,
and the fitting's firmware might have answered to codes no handset button is wired to — three of the
command field's 64 values are known under the light selector, leaving 61 unexplored.

**Six were tried and none of them did anything.** Everything within three of the toggle at `000100`,
on the one weak theory available — that a designer numbering light commands would put on, off and
toggle together:

| | | | | | |
|---|---|---|---|---|---|
| `000001` | `000010` | `000011` | `000101` | `000110` | `000111` |

No response from the light, on or off. So the theory is wrong, or the codes are elsewhere, or there
are none. `000000` was deliberately not tried: an all-zeros command field is the classic sentinel —
null command, reset, enter-pairing — and the single value most likely to do something that cannot be
undone from the sofa.

**What this cost and what it bought.** It cost six button presses and told us six of 61 values are
inert, which is not much. The remaining 55 are a different proposition: a ceiling fan receiver's
command space almost certainly contains its pairing or learn command and possibly a factory reset,
so sweeping it risks the fitting forgetting the handset. That is recoverable — the fitting has a
physical procedure — but it is no longer a cheap experiment, and the apparatus has been removed.

The honest alternative is in place instead: see "Why on/off cannot be trusted" below.

## Why on/off cannot be trusted

Worth stating as a property of the installation rather than a defect of the app.

**These fans are installed behind wall switches.** So the fitting can be unpowered, and then every
command Homey sends does nothing at all — no error, no feedback, nothing to detect. Homey cannot
know whether the light is lit, whether it is off, or whether the fitting is even listening. No
amount of inference closes that, because the radio is one way and the thing that broke the link is
upstream of it.

Three things follow, and the app does all three:

1. **`onoff` is idempotent against what Homey believes**, and transmits only when the belief has to
   change. "Turn it on" twice turns it on once, which is what `onoff` means everywhere else.

   Comparing against the belief correctly is the subtle part, and took two attempts. **Inside a
   listener the capability is stale**: Homey writes a requested value when the listener resolves,
   not before it runs. So reading `onoff` there gave the value from before the current press, and
   two quick presses sent one toggle between them — the second concluded the light was already
   where it was being asked to go. The belief is now a field, committed before anything is awaited,
   and the capability is its display. The same ordering is why `reflect` exists.
2. **A toggle button sits beside it**, sending one toggle per press and claiming nothing. A press is
   an event, so it cannot be collapsed by value the way a state change can, and it is correct
   however the light got to where it is. It is the way out when the belief has drifted: press until
   the light does what you want, and Homey follows along.
3. **What the handset does is overheard and believed**, because a received frame is evidence and a
   stored belief is not. **A received brightness press is taken to mean the light is on**, since
   those codes do nothing while it is off — nobody presses dimmer at a dark light, they reach for
   the toggle. It is an inference rather than a reading, and it is the only self-correction
   available for a belief with no feedback behind it: ordinary use of the handset quietly puts Homey
   back in step.
4. **The first belief is asked for, not guessed.** Pairing ends with one question — is the light on
   right now — because that is the only moment someone is standing in front of the light on purpose,
   and because it is the one fact about this device that cannot be measured. Without it the belief
   began as a coin toss and every toggle afterwards preserved it faithfully. After a restart the
   capability wins instead, holding everything that has happened since.

## Adding a command

1. **Capture it.** See [`CAPTURE_GUIDE.md`](CAPTURE_GUIDE.md). Press it several times: a button that
   carries a value rather than a fixed code will show it, and the report lists readings in the order
   they were sent so a cycle is visible.
2. **Check it against the structure above.** Selector `10` or `01`, 25 bits, even parity over bits
   0-23. If it does not fit, document what actually differs rather than forcing it into the model.
3. **Add the tail** to the command table in the protocol module, then wire it to a capability.
4. **Update this document**, including the caveats if the new command settles or unsettles one.
