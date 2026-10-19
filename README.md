# Lucci

Homey app for Beacon Lighting **Lucci** ceiling fans driven by their 433 MHz handset — fan on/off,
speed up and down, direction, and the light's on/off and brightness.

Built the same way as its siblings, by recording the handset and cloning what it sends, so the fan
needs no hub, no bridge and no account:

- [Heat & Glo IntelliFire RC300](https://github.com/jbothe/homey-heatnglo-rc300)
- [Bear blinds](https://github.com/jbothe/homey-bear-blind-automation)

## Status

**It drives a real fan.** Homey paired off the handset, and the fan now answers on, off, and every
speed step it has been asked for — including a speed set while it was off, which starts it there. So
the protocol is no longer a hypothesis.

| | |
|---|---|
| protocol, frame building, identification | [`lib/lucci-protocol.js`](lib/lucci-protocol.js) |
| fan driver — `onoff` and speed, **confirmed on the hardware** | [`drivers/fan/`](drivers/fan) |
| direction and timer — **confirmed on the hardware** | [`drivers/fan/device.js`](drivers/fan/device.js) |
| follows the handset, so Homey is not left guessing | [`drivers/fan/device.js`](drivers/fan/device.js) |
| the light — on/off, two step buttons, a slider, calibrate | [`drivers/light/`](drivers/light) |
| brightness arithmetic, tested on its own | [`lib/light-position.js`](lib/light-position.js) |
| pairing — learns the address off your own handset | [`lib/lucci-driver.js`](lib/lucci-driver.js) |
| still to come | flow cards, store assets |

Because speed, direction and the timer are absolute — the handset sends the state it is moving to,
not "faster" — a frame Homey overhears gives the exact state rather than a hint. So using the
handset keeps Homey honest instead of putting it out of step.

Every fan code has now been commanded from Homey and answered. The light is written and none of its
three codes has been transmitted yet.

The light is the awkward one. Its on/off is a single stateless toggle and the fittings are behind
wall switches, so Homey can never be sure the light is lit — or that the fitting has power to hear
it. `onoff` is therefore idempotent against what Homey believes, and a toggle button sits beside it
that claims nothing and is always correct. Six candidate command codes were tried on the hardware in
the hope of a discrete on and off; none did anything.

Its brightness is **relative** too, one code each way at any level, so there is nothing to read and
nothing to set. Two buttons are the honest core — one tap, one step,
correct however the light got there. The slider works anyway because the light **saturates** at both
ends rather than wrapping: aim past an end and the end absorbs the overshoot, which turns an estimate
into a fact and makes calibrating something that cannot fail.
Receiving is how the receiver's habit of dropping a burst's first bit turned up — see "Receiving"
in [`RF_PROTOCOL.md`](RF_PROTOCOL.md).

- [`RF_PROTOCOL.md`](RF_PROTOCOL.md) — the frame layout, all sixteen command codes, and what each
  control does. Reverse-engineered from 33 recordings covering every button.
- [`.homeycompose/signals/433/lucci.json`](.homeycompose/signals/433/lucci.json) — the signal
  definition.
- [`APP_PLAN.md`](APP_PLAN.md) — what the protocol makes possible, and what it rules out.
- [`CAPTURE_GUIDE.md`](CAPTURE_GUIDE.md) — how to record a handset, and how to tell a good
  recording from a bad one.
- [`tools/analyse-capture.js`](tools/analyse-capture.js) — reads a capture and reports the frame
  structure, symbol alphabet, field map and a candidate signal definition.

```bash
npm run analyse        # read captures/raw-captures.txt
npm test               # 69 tests; the capture tests skip without a recording
homey app validate     # --level verified passes
```

The analyser assumes nothing about the protocol; it infers the structure from the durations. It is
checked against the sibling Bear handset's recordings, where the answer is already documented, and
recovers that protocol's preamble, alphabet, frame length, repeat count, interval and tolerance
without being given any of them.

One bit of the frame follows no rule at all. Bit 24 was consistent with even parity across all 33
recordings, and the radio later disproved it, so the app learns that bit from your own handset at
pair time rather than deriving it — and refuses to transmit without it, since a guess there looks
like a working device driving nothing. What the bit *means* is still unknown; see "Bit 24" in
[`RF_PROTOCOL.md`](RF_PROTOCOL.md).

In short, what the handset turned out to be: a 19-duration preamble, 25 bits, a 16-bit address and a
fan/light selector. Fan speed, direction and the timer are **absolute** — the handset tracks the
state and sends the one it is moving to — so Homey can command them and know the result. The
light's brightness is **relative**, so it can only be stepped.

Recordings are **not committed** — they carry the code that operates the fan.

## Licence

GPL-3.0
