# Lucci Whitehaven "CR2032" remote, 433 MHz RF protocol

The second kind of remote this app drives. The first, the rechargeable USB-C handset of the Lucci
Air fans, is in [`RF_PROTOCOL.md`](RF_PROTOCOL.md); **this is a different protocol, not a variant of
it**, with its own signal, its own protocol module and its own drivers.

|  | |
|---|---|
| fan | Lucci Whitehaven 56in DC, SKU 213042, model PFC56-3B-ABS-BC/KOA |
| receiver | Rhine Electronic RH787NRN |
| remote | handheld, 3V CR2032 coin cell |
| buttons | six speeds (I to VI), power off, one reverse, one light toggle |
| not on the remote | timer, brightness, an "on" button |

Decoded from 20 recordings of one remote, taken with Homey's built-in RF recorder. This is a working
hypothesis, not a manufacturer specification, and the section below says exactly how much of it the
fan has confirmed.

## What is verified on the fan, and what is not

Verified by watching the fan, from Homey with this app. Anything not in the first block is consistent
with the recordings and has not been seen to work.

| | status |
|---|---|
| OFF at 9 repetitions stops a running fan | **verified**, twice |
| OFF at 1, 2 or 5 repetitions | **does not work** (one trial each; 3, 4, 6, 7, 8 untried) |
| the speeds | **verified**: all six work from Homey, each seen sent in a log and confirmed on the fan |
| Reverse flips the direction **once per press** at 9 repetitions | **verified**; the double-flip risk did not appear |
| `onoff` true from off starts the fan at the stored speed | **verified** |
| the remote's OFF and light button, received | **verified** (the tiles followed them) |
| the light's toggle, transmitted | **not testable**: no light fitted on this fan |
| pairing both devices off the real remote | **verified on a Homey** (address and tail learned and stored) |
| receiving this signal on Homey | **verified for `light.toggle`** (the belief followed the remote, twice); other buttons not yet watched |

| Reverse sent to a stopped fan | **verified**: ignored, and not remembered. Restarted, the fan turns the way it was |
| a power cut at the wall while running at VI, then a different speed | **verified**: the fan resumed at VI and Speed I was honoured at once. No "start on VI first" obstacle in this case |
| a power cut while the fan was stopped, then a non-VI speed | **not tested** |
| response time | **observed**: a speed change shows within a few seconds; a direction change is slow, because the fan slows to a stop before turning the other way |
| a second Reverse press while the fan is still reversing | **verified**: the fan **queues** it. It reverses, stops, and reverses back |
| whether 9 repetitions flips a toggle twice | **unknown** |
| the light | **the fan this was built against has none fitted** |

The command table is held against the recordings by `test/cr2032-protocol.test.js` on every `npm test`
that has `captures/fan2-cr2032.txt` (it skips without it). That ties the table to the *remote*, not to
the *fan*.

## Frame

24 bits behind a one-pulse preamble, then 10512us before the next frame.

```
[ 0..15  ]  address   identical across every button recorded
[ 16..21 ]  command   which button, a literal table
[ 22..23 ]  tail      the same in all nine codes recorded
```

On air: one leading 348us pulse, then 24 times (gap, pulse), the **long pulse being a 1**. A bit is
1042us whichever it is. As a Homey signal definition,
[`.homeycompose/signals/433/lucci_cr2032.json`](.homeycompose/signals/433/lucci_cr2032.json):
`sof [348]`, `words [[694,348],[348,694]]` in **bit order** (index = bit), `interval 10512`,
`repetitions 9`, `sensitivity 0.2`, `minimalLength 23`, `maximalLength 24`, `rxTimeout 255`, and as
ever no `eof` and no `txOnly`.

A frame is 25.4ms, so nine repetitions are **323ms of air** (`PRESS_AIRTIME`), against the USB-C
remote's 423ms. The press queue is spaced for that, plus the same unmeasured 150ms release gap.

### The tail is stored with the address

The USB-C remote's 25th bit passed every test one handset allowed, including even parity over the
other 24, and a second handset showed it was neither parity nor constant: it belonged to the handset.
Nobody has a second CR2032 remote, so whether bits 22-23 identify the remote or are a protocol
constant **cannot be learned**. The app does not need to: pairing keeps the 16 address bits **and**
the two tail bits from the remote's own frame, and `buildFrame` refuses to build without both. A
device with no tail stored makes itself unavailable, as one without an address does. A received frame
whose tail disagrees with the stored one is logged once, which is the line that would show the tail
varies.

## Commands

Nine codes, all distinct. Bits 16-21:

| Button | command | key | what the recordings show |
|---|---|---|---|
| Off | `110111` | `fan.off` | same code, two presses |
| Speed I | `001111` | `fan.speed.0` | same, two presses |
| Speed II | `011001` | `fan.speed.1` | same, two presses |
| Speed III | `101111` | `fan.speed.2` | same, two presses |
| Speed IV | `101011` | `fan.speed.3` | same, two presses |
| Speed V | `011010` | `fan.speed.4` | same, two presses |
| Speed VI | `011111` | `fan.speed.5` | same, two presses |
| Reverse | `001011` | `fan.reverse` | **same code, three presses: a toggle** |
| Light | `100111` | `light.toggle` | **same code, three presses: a toggle** |

The speeds are a table and not a counter, as on the USB-C remote: `001111`, `011001`, `101111`,
`101011`, `011010`, `011111` follow no rule six samples can settle. **A tenth command cannot be
synthesised, only captured.** Bits 22-23 were `11` in all nine, so a command that sets them is
possible and would first show up as an unrecognised frame in the log.

No parity bit: the nine distinct codes have six even and three odd weights, so no bit among the 24 is
a parity bit over the others. That is the one direction a single remote can give evidence.

## What the remote tracks, and what it does not

| Control | Behaviour |
|---|---|
| Off, Speed I-VI | **absolute**: one fixed code each |
| Reverse | **a toggle**: the same code every press, so the remote cannot say "reverse" or "forward", only "flip". Offered as a *Change direction* button |
| Light | **a toggle**: likewise |

This is the difference from the USB-C remote, whose direction is absolute (it sends the state it is
moving to). Here there is no "go to reverse", so the app can only flip.

### Reverse is a button, and deliberately not a state

An earlier version of the CR2032 fan tracked a direction, with a picker, a flip button and a "correct
direction" button, the way the USB-C remote's light tracks its on/off. It was removed. A picker claims
a direction nobody knows: the fan reports nothing, the first value is a guess, and it drifts whenever
the remote, the wall switch or a power cut changes the fan. A **Change direction** button claims only
what is true (one flip was sent), is correct however the fan got where it is, and suits a fan that takes
a while to answer, where a person presses, watches, and presses again.

**A direction change is ignored while the fan is stopped, and not remembered**: restarted, it turns the
way it was. The button is still sent when Homey believes the fan off: the remote's own button behaves the
same, and the belief can be wrong, so an unsent press cannot be right. (The USB-C light refuses
brightness while believed off; this deliberately does not.) The one line it logs says what the press
will do.

What it costs: no direction on the tile, and nothing to build a flow condition on. A device paired
while the picker existed keeps its old capabilities: remove it and add it again.

The **light** keeps a believed on/off, because there the value is real: a standard Homey light has
voice control, grouping and flows that read whether it is on. It carries the USB-C light's protections:

1. **`onoff` is idempotent against the belief.** Turning on twice turns on once.
2. **A toggle button** (`lucci_toggle`) sends one toggle per press and claims nothing.
3. **A resync button** (`lucci_resync`) flips Homey's belief and transmits nothing.
4. **What the remote does is overheard and believed**, collapsed over one second so a press that
   arrives as two receptions is one flip. That window is a judgement and is unverified.
5. **The first belief is asked for at pair time.**

## Receiving

The same four requirements as the USB-C signal (`rf433.satelliteMode`, no `eof`, a sensitivity that
keeps the symbols apart, a length range that allows a short frame), with one difference in how a short
frame is treated. The recorder opens every capture with a fragment, which is the receiver's gain
settling over the first edge of a burst, and Homey's receiver may do the same. **Only a full 24
symbols is ever acted on**: a 23-symbol frame has lost an unknown end, and guessing the missing bit
is the mistake the USB-C remote taught this app to stop making. It is logged, throttled, and the rest
of the burst arrives whole. Pairing therefore needs a full frame, and a receiver that only ever
delivers 23 would be unpairable and say so.

**Observed on a Homey: the first reception of every burst is offset by junk.** It arrives as 24
symbols that are **five spurious `0` symbols, then the 16 address bits, then only the first three
command bits** (`00000`, address, `110` for OFF; `100` for the light). The receiver starts decoding
before the real preamble, and `maximalLength` cuts the frame, so the real one is chopped. It is logged
as `unimplemented command`, which is misleading: it is not a tenth button. It is never acted on, the
full frames of the same press follow within about 35ms, and pairing and receiving both worked off
them. This is a different shape from the one-symbol-short frame the recordings suggested, which has
not been seen. Because the log line is stateless it cannot tell this from a genuinely new button
without an address to compare against.

Sensitivity `0.2` keeps the 348us and 694us symbols apart with room either side: they overlap from
about `0.33`.

The app creates this receiver the first time a CR2032 device asks for it and counts it separately
from the USB-C one: Homey's `enableRX` acts on the signal, so one shared count would let the last
USB-C device switch off the CR2032 receiver.

## Constraints from the manual, and what is done about them

- **"Must be started on speed VI first after power-on."** Tested once and **not observed**. The fan
  was running at VI, power was cut at the wall and restored, and the fan **resumed in its previous
  state** (running at VI); a different speed sent from Homey was honoured immediately. So the rule did
  not get in the way, though the case was one where the fan was already on VI, which may be exactly
  what the manual means. **Not tested:** cutting power while the fan was stopped or on another speed.
  If the fan always resumes its previous state, a power cut also does not put Homey's picture of the
  fan out of step, which is a better property than the wall-switched USB-C light has.
- **"Takes 5 to 10 seconds to respond to speed or direction changes."** Observed, and the two are
  not alike. **A speed change is quick**: the fan is accelerating within a few seconds, so the
  picker's 250ms debounce and the 473ms press spacing are not a problem and nothing was changed.
  **A direction change is slow**: the fan has to slow to a stop before it turns the other way.
  Nothing is done about that, deliberately. The Change direction button sends one flip per press and
  has no state to get wrong, so the cost of an impatient person is a second press.
  **A second Reverse press while the fan is still stopping is queued by the fan**: it reverses, stops,
  and reverses back, so two quick presses end where they began, slowly. That is the correct result
  for two flips, so the button has **no cooldown**: one would be a guess at whether the second press
  was impatience or intent, and would silently drop a press from a flow that meant it. The cost of an
  impatient double-tap is time.

## Repetitions

`repetitions` is **9**, the only count verified: OFF stopped the fan at 9 and not at 1, 2 or 5. The
recorder cannot tell us how many frames the remote sends, because that depends on how long the button
is held: taps gave 4 to 7 clean frames and one longer press about 10.

For an absolute command a higher count than the minimum is harmless. For a toggle it can matter: on the
sibling RC300, sending longer than the real remote made the receiver count one command as two presses.
**It did not here**: nine repetitions of `fan.reverse` flipped the direction once per press.

## Adding a command

1. **Capture it**, a press at a time, labelled `Name (n)`. See
   [`CAPTURE_GUIDE_CR2032.md`](CAPTURE_GUIDE_CR2032.md) and run `npm run analyse:cr2032`.
2. **Check it against the structure above**: 24 bits, the same 16-bit address, a command in bits 16-21.
   If bits 22-23 or the address move, document what actually differs rather than forcing it in.
3. **Add it to `COMMANDS`** in [`lib/cr2032-protocol.js`](lib/cr2032-protocol.js), then wire it to a
   capability.
4. **Update this document**, including the table of what is verified.
