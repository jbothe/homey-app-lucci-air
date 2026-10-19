# Phase 2: the Homey app

What [`RF_PROTOCOL.md`](RF_PROTOCOL.md) makes possible, and what it rules out. Every decision below
follows from a finding there rather than from taste, so each one names the finding.

## Two devices from one handset

One `learn` pair step, listening for a 25-bit frame whose selector and command tail are recognised,
keeping the leading 16 bits as the address — then offering **two devices**, a fan and a light, both
holding that address. The sibling Bear app already offers five devices from one learned address, so
the pattern is established.

Two devices rather than one, because they are two things to a user and to Homey: a `fan` and a
`light`, each wanting its own tile, its own flow cards and its own voice control.

```
lib/lucci-protocol.js    the sixteen codes, frame building, identification
drivers/fan/             class "fan"
drivers/light/           class "light"
```

## Fan capabilities

| Capability | Type | Why it can exist |
|---|---|---|
| `onoff` | standard | — |
| `lucci_speed` | enum, 6 steps | speed is **absolute**: each step has its own code |
| `lucci_direction` | enum, forward/reverse | direction is **absolute** |
| `lucci_timer` | enum, off/2h/4h/8h | the timer is **absolute** |

Custom enums with `uiComponent: "picker"` and `preventInsights: true`, matching the sibling RC300
app's `fan_level` and `flame_level`.

**`onoff` is asymmetric, because the protocol is.** There is no "fan on" command — only an off code
and six absolute speed codes. So `false` sends the off code, and `true` sends the stored speed's
code, which is exactly how the handset behaves: the user observed the fan starting when a speed
button is pressed. Setting `lucci_speed` therefore implies `onoff` true.

## Light capabilities

| Capability | Type | Why |
|---|---|---|
| `onoff` | standard | one stateless toggle code |
| `lucci_brighter` | boolean, `uiComponent: "button"` | one tap, one step — always correct |
| `lucci_dimmer` | boolean, `uiComponent: "button"` | likewise |
| `dim` | standard slider | 32 steps, driven by discrete presses — see below |

Brightness is **relative**: one code for brighter, one for dimmer, at any level, because the fitting
holds the level and the handset does not. Four captures at the two ends of a range of about twenty
steps established it.

**Two buttons are the honest core.** A tap sends one press, the light moves one step, and nothing
has to be remembered. They are correct however the light got to where it is, which no slider can
claim. Flow actions alone would be poor UX for something people adjust by hand, so these are
capabilities, on the tile.

### The slider: discrete presses, with holds only at the ends

All three numbers are now measured on the hardware:

| | |
|---|---|
| steps across the range | **32** (a power of two; the fitting probably holds a 5-bit level) |
| a continuous hold, maximum to minimum | **~7s** (5 timings, 6.4-7.9s) |
| a single press | 9 frames, 423ms, **exactly one step** |
| both ends | **saturate** — a hold at minimum stays at minimum, at maximum stays at maximum |

A hold therefore steps every ~219ms, against ~423ms for a press. Against conservative discrete
presses — a press plus a 150ms gap, 573ms a step — **the hold is only 2.6x faster.** That changes
the mechanism, because the hold's small advantage is not worth what it costs:

- **A press is exactly one step.** Stepping by presses needs no rate figure at all, so there is
  nothing to estimate wrongly and no error to accumulate over a session.
- **The receiver gets time to settle** between commands, rather than being driven at the handset's
  maximum cadence for seconds at a stretch.
- **Hold emulation depends on a figure with a 20% spread.** 6.4 to 7.9 seconds across five timings
  is fine for knowing how long to saturate, and far too loose to position against: at 219ms a step,
  that spread is three or four steps of error on a full-range move.

So the slider steps with presses, and the hold is kept for the one job it is exact at.

| Target | Mechanism | Exact? |
|---|---|---|
| 0% or 100% | one hold, 10s (7.9s observed worst case plus margin) | **yes** — saturation |
| anything else, position known | `|k - position|` presses, ~573ms each | **yes** — one press, one step |
| anything else, position unknown | saturate to the nearer end, then step | **yes**, but slow |
| calibrate / repair | one hold, 10s | **yes** — cannot fail |

A typical adjustment is a nudge of a few steps, so 1-2 seconds. A full-range move is ~18s by presses
or 10s by saturating, and the extremes take the fast path anyway. Position is tracked between moves
and corrected from what the app overhears the handset do, but it is never *relied* on: every target
is reachable from a saturated anchor, and calibrating cannot fail.

Two implementation notes follow from the timings. A move takes seconds, so a new target arriving
mid-move must **cancel the one in flight** rather than queue behind it, or dragging the slider would
back up a minute of transmission. And the device should reflect the target immediately while the
transmission catches up, as a thermostat does.

### Dim does nothing while the light is off

Confirmed on the hardware: the brightness codes are ignored unless the light is already on. So
setting `dim` on a device that is off must turn the light on first and then adjust, and `dim` can
never be the thing that turns the light on. The buttons behave the same way, and should be no-ops
rather than silent failures when `onoff` is false.

## Receiving is worth the effort here

With `"rf433": { "satelliteMode": true }` the app follows the handset, and because speed, direction
and the timer are absolute, a received frame gives the **exact** state rather than a hint:

| Received | Effect |
|---|---|
| a speed code | set `lucci_speed` to that step, `onoff` true |
| fan off | `onoff` false |
| a direction code | set `lucci_direction` |
| a timer code | set `lucci_timer` |
| light toggle | flip the light's `onoff` |
| brighter / dimmer | advance the tracked `dim` position by one step, or by a hold's worth |

That is what keeps Homey honest when the household uses the handset, and it is the main reason the
light's optimistic `onoff` is tolerable.

Four things are needed to receive at all, and all four give the same symptom when missing. They are
listed in `RF_PROTOCOL.md`; the driver should log every payload it cannot identify, as the Bear app
does, because that one log line separates "no frames arriving" from "frames arriving and not
decoding".

## The protocol module

`buildFrame(address, command)` returns address(16) + selector(2) + command(6) + parity(1).

**Bit 24 is computed as even parity over the preceding 24 bits, not copied.** On this handset that
yields `0` for all sixteen commands — bit-for-bit what was recorded — but the app learns whichever
address the user's handset has, and one with odd weight would need it set. Computing it costs
nothing here and is likelier to be right elsewhere.

`identifyFrame(payload)` accepts 24 or 25 symbols, checks the selector is `10` or `01`, looks the
command tail up in the table, and returns `{ address, domain, command, value }` or null. That
structural check is also what stops pairing latching onto unrelated 433 MHz traffic.

The sixteen codes are a **literal table**. The rule generating bits 18-23 is not derived — the six
speed codes are 1, 2, 7, 11, 13, 16, monotonic but no counter — so nothing is synthesised.

## Transmitting

`repetitions: 9`, matching the handset, and **not more**. On the sibling RC300 app, transmitting for
materially longer than the real remote made the receiver re-trigger and register one Homey command
as two presses. A press is ~423ms of airtime.

## The test that matters

Mirror the Bear app's `captures.test.js`: decode `captures/raw-captures.txt` on every `npm test` and
assert `buildFrame` reproduces each recorded frame bit-for-bit, for all sixteen commands. Skip
rather than fail when the file is absent, so a fresh clone runs green.

That is the check that ties the shipped tables back to the hardware. Everything else tests the app
against itself.

## Order of work

1. **Protocol module and its tests.** No Homey involved. Ends with `buildFrame` reproducing all 33
   recordings.
2. **App scaffold** — `.homeycompose/app.json`, the signal definition (already written), locales,
   capabilities.
3. **Fan driver, transmit only**: `onoff` and `lucci_speed`, with the learn pair step. **Done, and
   the fan responded on the first attempt** — no complemented payload, no preamble adjustment, no
   change to `repetitions`, all of which were the contingencies. Then confirmed across two sessions:
   on, off, a speed set while the fan was off starting it at that speed, and speeds changed while
   running, over five of the six steps. Nothing double-stepped, so 9 repetitions is right for this
   receiver as well as for the handset. **The asymmetric `onoff` works in both directions**, which
   was the design's one real bet. Receiving also works, which was not being tested: a frame arrived
   and decoded on the first run, and it is what found the leading-bit truncation now handled in
   `completeFrame`.
4. **Direction and timer** on the fan.
5. **Receiving**, and state mirroring from the handset.
6. **Light driver**: `onoff` and the two brightness buttons first — they need no state and no
   timings. Then the `dim` slider: saturating holds for 0% and 100%, discrete presses in between,
   and a calibrate action.
7. **Flow cards**, store assets, README and locales.

Steps 1 and 2 can proceed now. Step 3 is where the protocol stops being a hypothesis.

## Known state drift

Worth stating in the app's own documentation rather than discovering in a support thread:

- **The timer has no feedback.** `lucci_timer` reflects what was last commanded, not time remaining,
  and the app cannot know when the fan's timer expires.
- **The light's on/off can invert** if its state is changed by something Homey cannot hear — a wall
  switch, a power cut, a second handset. The next toggle then does the opposite of what was asked.
- **The `dim` slider's position is an estimate between moves**, corrected by what the app overhears
  and re-anchored by calibrating, which works because the light saturates at both ends rather than
  wrapping. Each individual step is exact — one press, one step — so error enters only by missing
  what the handset did, not by mis-timing a transmission.
- **A slider move takes seconds**, up to ~18s across the full range. The app reflects the target
  immediately and cancels any move still in flight when a new one arrives.
- **Speed, direction and timer survive this**, because every handset press is absolute and received.
- **Nothing is reported by the fan.** The radio is one-way; everything Homey shows is what it
  commanded or overheard.
