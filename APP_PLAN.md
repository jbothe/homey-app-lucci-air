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
drivers/lib/lucci-protocol.js    the sixteen codes, frame building, identification
drivers/fan/                     class "fan"
drivers/light/                   class "light"
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
| `dim` | standard slider | only with tracked position — see below |

Brightness is **relative**: one code for brighter, one for dimmer, at any level, because the fitting
holds the level and the handset does not. Four captures at the two ends of a range of about twenty
steps established it.

**Two buttons are the honest core.** A tap sends one press, the light moves one step, and nothing
has to be remembered. They are correct however the light got to where it is, which no slider can
claim. Flow actions alone would be poor UX for something people adjust by hand, so these are
capabilities, on the tile.

### The slider, and why it is possible after all

A hold was recorded: **holding the handset's dimmer sends the same code repeatedly at the same
9.4ms cadence as a single press** — 59 frames over 2.76s against a press's 9 — with no
hold-specific code. So the app can emulate a hold faithfully by transmitting the same payload with
more repetitions, which is far quicker than sending discrete presses.

That makes a real `dim` slider workable, on three conditions:

1. **The app tracks position itself**, 0 to 31. A move to `k` transmits the appropriate code with
   roughly `|k - position| x framesPerStep` repetitions, then stores `k`.
2. **Receiving keeps it honest.** Every handset press and hold is overheard, so the estimate can be
   corrected as the household uses the remote rather than drifting silently. A burst of frames is
   one press; a longer run is a hold, and its duration converts to steps at the same rate.
3. **A calibrate action can always re-anchor it.** Transmitting well past the full range drives the
   light to an extreme, where it saturates, and position is then known exactly. Offered as a flow
   action and as a repair step, so a user who thinks the slider has drifted can fix it in one tap.

Unlike the RC300 lesson — where transmitting longer than the real remote made the receiver register
one command as two presses — a long transmission here *is* what the handset does on a hold, so
extended repetition is correct for brightness specifically. It is not licence to raise
`repetitions` for any other command.

The slider is marked best-effort in the app's own documentation. The two buttons are not, and remain
the thing to reach for when it matters.

### The range is 32 steps, so the slider must emulate a hold

Counted on the hardware: **32 brightness steps**. A power of two, which suggests the fitting holds
a 5-bit level — not something the recordings can confirm, but it fits.

32 settles the mechanism. As discrete presses a full-range move is 32 x 423ms = **13.5s of airtime
before any gaps**, which is no use as a slider. So emulating a hold with extra repetitions is not a
refinement here, it is the only workable approach.

If the 2.76s hold that was recorded crossed the whole range, then a step is ~1.8 frames or ~87ms,
a full-range move takes 2.76s and a four-step nudge 350ms — a perfectly usable slider. That "if" is
the one measurement still missing.

### The measurement still outstanding

One experiment gives both remaining answers: **from maximum, hold the dimmer down and time how long
until the light stops changing.**

- The elapsed time is **T**, and `framesPerStep = (T x 21.4) / 32`.
- Whether it stops at all answers **saturation**. If holding past the bottom leaves the light at
  minimum, calibrate works: drive deliberately past the end and position is known exactly. If it
  instead wraps round to maximum, the slider has no anchor, and it should be dropped in favour of
  the two buttons rather than shipped as a guess.

Until that is measured the app ships the two buttons and no slider, which is a complete and honest
device on its own.

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
3. **Fan driver, transmit only**: `onoff` and `lucci_speed`, with the learn pair step.
   **This is the first milestone that touches the radio, and the first real risk.** Nothing has been
   transmitted yet. If the fan does not respond, the things to try in order are: the complemented
   form of the payload, `repetitions` nearer the handset's exact burst, and the preamble as measured
   per-position rather than uniform.
4. **Direction and timer** on the fan.
5. **Receiving**, and state mirroring from the handset.
6. **Light driver**: `onoff` plus the two brightness buttons. The `dim` slider follows once N and
   T are measured; the device is complete and honest without it.
7. **Flow cards**, store assets, README and locales.

Steps 1 and 2 can proceed now. Step 3 is where the protocol stops being a hypothesis.

## Known state drift

Worth stating in the app's own documentation rather than discovering in a support thread:

- **The timer has no feedback.** `lucci_timer` reflects what was last commanded, not time remaining,
  and the app cannot know when the fan's timer expires.
- **The light's on/off can invert** if its state is changed by something Homey cannot hear — a wall
  switch, a power cut, a second handset. The next toggle then does the opposite of what was asked.
- **The `dim` slider's position is an estimate**, corrected by what the app overhears and re-anchored
  by calibrating. The two brightness buttons are exact and need no estimate at all.
- **Speed, direction and timer survive this**, because every handset press is absolute and received.
- **Nothing is reported by the fan.** The radio is one-way; everything Homey shows is what it
  commanded or overheard.
