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
button is pressed. Setting `lucci_speed` therefore implies `onoff` true. **Confirmed on the
hardware**, in both directions and from standing.

**The two share one debounced listener**, which is Homey's documented pattern for capabilities that
map to a single command, as `onoff` and `dim` do on a light. Three reasons here, two of them found
by running it:

- Every frame this driver sends is one absolute speed code or the off code. There is never a power
  command *and* a speed to coordinate, so two listeners were two routes to the same single frame.
- `onoff` leads when one request carries both, so a flow asking for off and a speed at once sends
  one frame rather than two contradictory ones.
- **A drag across the picker emits a value per step.** The first run put three on air inside 2.1
  seconds, each ~423ms of airtime, so they were queuing behind each other. Debounced at Homey's
  default 250ms a drag is one transmission of the step it landed on — and because speed is absolute,
  that was the only one carrying any information anyway.

**Implying `onoff` has to be written after the listener resolves, not inside it.** Setting it from
within the speed listener did not stick: the picker transmitted, the fan moved, and the tile stayed
off until an `onoff` toggle — which did nothing, the fan already running — put it right. Homey writes
the capabilities a request carried when the listener resolves, so the implied one waits its turn and
then reads itself back, which is what makes a log able to settle this rather than a user noticing it
again.

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
| 0% or 100%, position known | `|k - position|` presses **plus 4**, and let the end absorb them | **yes** — saturation |
| 0% or 100%, position unknown | 36 presses, enough to arrive from the far side | **yes** — saturation |
| anything else, position known | `|k - position|` presses, ~573ms each | **yes** — one press, one step |
| anything else, position unknown | saturate to the nearer end, then step | **yes**, but slow |
| calibrate / repair | 36 presses into an end stop | **yes** — cannot fail |

**The 10-second hold this table originally specified does not survive contact with Homey's
transmitter**, and the correction is in the app rather than only here. A hold on the handset steps
every ~219ms, but the smallest thing Homey can send is one 9-frame press — ~423ms, exactly one step —
so ten seconds of emulated holding buys about 17 steps and **cannot cross a 32-step range.** Nothing
was wrong with the measurement; it was a measurement of the handset, and the app is not a handset.

Counting presses instead needs no rate figure at all, which was this section's own argument for
preferring presses to a hold. The saturation is what makes it cheap: aiming at an end, the app sends
more presses than it believes are needed and the end stop absorbs the surplus, so **an end is both
the fastest target and the only exact one.** Four of margin covers an estimate that has drifted a few
steps; 36 covers one that is absent entirely.

A typical adjustment is a nudge of a few steps, so 1-2 seconds. A full-range move is ~18s, and
re-establishing from nowhere ~21s — which is why it happens only when the position is unknown or
being deliberately calibrated. Position is tracked between moves
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

`buildFrame(address, command, bit24)` returns address(16) + selector(2) + command(6) + bit24(1).

**Bit 24 is learned from the handset, not computed.** It was taken for even parity, and the radio
disproved that: frames arrived with an even number of ones across bits 0-23 and bit 24 set, which
neither parity nor the constant zero of all 33 recordings permits — see "Bit 24" in RF_PROTOCOL.md.
So pairing keeps the bit alongside the address and the devices transmit what they were given, which
is right whatever the bit turns out to mean. There is no fallback: `buildFrame` refuses a frame
without the bit, and a device with none stored makes itself unavailable rather than guess, because a
guessed bit looks like a working device driving nothing. Pairing needs a complete frame for the same
reason — the two truncations lose opposite ends, address bit 0 and bit 24, and neither is
recoverable.

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
4. **Direction and timer** on the fan. **Done, and both answered on the hardware.** Each gets a
   listener of its own rather than joining the coupled pair: both are absolute, but neither shares a
   frame with another capability, so there is nothing to pool. **A direction code starts a stopped
   fan**, confirmed, so it implies `onoff` true the way a speed code does. The timer implies
   nothing, having only ever been sent to a fan already running.
5. **Receiving**, and state mirroring from the handset. **Done, and heard a real press** — one
   handset press of speed 3 came through as `rx fan.speed.3 from the handset` and moved the tile,
   which is the first thing in this app to change a capability without a user asking. The device
   registers an RX
   listener and mirrors through `set`, not `reflect` — nothing is deferred because no capability
   listener is running on that path — and never through `triggerCapabilityListener`, which would
   transmit a received press back at the fan. Repeats of one press are collapsed over 2 seconds,
   which is safe here only because every fan command is absolute or idempotent; **the light's
   relative brighter and dimmer must not reuse that window.** Light frames reach this device because
   they carry the same address: they are ignored, and said once, since the light being audible is
   step 6's premise.

   **Homey does not hear its own transmissions**, which was the open question here and the one that
   mattered most to the light. Checked with the receiver on for the life of the device and a dozen
   commands sent: no received frame followed any of them. So the light's `dim` tracking does not
   have to filter its own presses out, which would otherwise have doubled every move it made.

   Pairing now **prefers a full-length frame** over a reconstructed one, holding a 24-symbol
   candidate 750ms for a 25-symbol frame before settling for it. Pairing is the one caller that
   cannot check an address after the fact — it is what establishes the address — and under the
   leading-bit reading the reconstructed symbol *is* address bit 0. A preference and not a
   requirement, because a receiver that only ever delivered 24 symbols would otherwise be
   impossible to pair.
6. **Light driver**: `onoff`, the two brightness buttons, the `dim` slider and a calibrate repair.
   **Written, and not one of its three codes has been transmitted.** The fan's 2-second
   repeat-collapsing window is deliberately *not* reused: it is safe only for absolute commands and
   would silently drop steps here, where one press is one step. Homey not hearing its own
   transmissions is what makes the received-press tracking sound.

   The position lives in the device store rather than being read back off `dim`, because `dim` is the
   target and is allowed to run ahead of the light while a move transmits. Each move records where it
   got to press by press, so an interrupted one leaves a usable estimate instead of nothing, and a
   move that reaches an end stop replaces the estimate with a fact. A press at the handset during a
   move abandons the move: both sides are stepping the same light and only one of them is counting. Then the `dim` slider: saturating holds for 0% and 100%, discrete presses in between,
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
- **Nothing is reported by the fan.** The radio is one-way; everything Homey shows is what it
  commanded or overheard.
- **A restart is where that bites hardest.** On init the capabilities hold what was last commanded,
  and the app has no way to ask the fan whether it is still true — the handset may have been used
  while the app was down. Nothing is transmitted on init to force the two into agreement, because
  that would mean a fan starting itself when Homey restarts. So the first command after a restart
  may be the one that looks wrong: `onoff` true sends the stored step, which is the step Homey
  remembers rather than the step the fan is on. The log says as much in those terms rather than
  claiming to have resumed anything.
- **Speed, direction and timer converge again** as soon as the handset is used, because every press
  is absolute and received. The light's `onoff` does not, being a stateless toggle — which is the
  asymmetry behind the two entries above it.
