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
| *(no `dim`)* | — | brightness is **relative** — see below |

**There is deliberately no `dim` capability.** The light's level is tracked by the fitting, not the
handset: brighter and dimmer are one code each at any level, which four captures at the two ends of
a twenty-step range established. A `dim` capability would have to count its own steps from an
unknown starting point and would be wrong the first time anyone touched the handset or the wall
switch. Offering it would be a worse lie than not offering it.

Brightness gets **flow actions** instead — "Brighten", "Dim", and a step-count variant that sends
the code `n` times — which is all the protocol can honestly support.

**`onoff` on the light is best-effort, and must be implemented as a toggle.** The code is a toggle,
not discrete on and off, so the app sends it only when its own state differs from the target. That
is correct whenever Homey's state is right and inverted whenever it is not, which is why receiving
matters.

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
| brighter / dimmer | nothing to update — there is no state to track |

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
6. **Light driver**: `onoff` plus the brightness actions.
7. **Flow cards**, store assets, README and locales.

Steps 1 and 2 can proceed now. Step 3 is where the protocol stops being a hypothesis.

## Known state drift

Worth stating in the app's own documentation rather than discovering in a support thread:

- **The timer has no feedback.** `lucci_timer` reflects what was last commanded, not time remaining,
  and the app cannot know when the fan's timer expires.
- **The light's on/off can invert** if its state is changed by something Homey cannot hear — a wall
  switch, a power cut, a second handset. The next toggle then does the opposite of what was asked.
- **Speed, direction and timer survive this**, because every handset press is absolute and received.
- **Nothing is reported by the fan.** The radio is one-way; everything Homey shows is what it
  commanded or overheard.
