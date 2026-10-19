# Lucci

Homey app for Beacon Lighting **Lucci** ceiling fans driven by their 433 MHz handset — fan on/off,
speed up and down, direction, and the light's on/off and brightness.

Built the same way as its siblings, by recording the handset and cloning what it sends, so the fan
needs no hub, no bridge and no account:

- [Heat & Glo IntelliFire RC300](https://github.com/jbothe/homey-heatnglo-rc300)
- [Bear blinds](https://github.com/jbothe/homey-bear-blind-automation)

## Status

**The protocol is settled, and the app transmits nothing yet.**

The fan driver and the pairing flow are written, but no frame has ever been put on air: every code
here comes from listening to the handset. The first hardware test is the next step, and the first
real risk — see [`APP_PLAN.md`](APP_PLAN.md) for what to try if the fan does not respond.

| | |
|---|---|
| protocol, frame building, identification | [`lib/lucci-protocol.js`](lib/lucci-protocol.js) |
| fan driver — `onoff` and speed, transmit only | [`drivers/fan/`](drivers/fan) |
| pairing — learns the address off your own handset | [`drivers/fan/pair/learn.html`](drivers/fan/pair/learn.html) |
| still to come | direction, timer, receiving, the light, flow cards |

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

In short, what the handset turned out to be: a 19-duration preamble, 25 bits, a 16-bit address and a
fan/light selector. Fan speed, direction and the timer are **absolute** — the handset tracks the
state and sends the one it is moving to — so Homey can command them and know the result. The
light's brightness is **relative**, so it can only be stepped.

Recordings are **not committed** — they carry the code that operates the fan.

## Licence

GPL-3.0
