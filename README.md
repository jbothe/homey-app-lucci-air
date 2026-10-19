# Lucci

Homey app for Beacon Lighting **Lucci** ceiling fans driven by their 433 MHz handset — fan on/off,
speed up and down, direction, and the light's on/off and brightness.

Built the same way as its siblings, by recording the handset and cloning what it sends, so the fan
needs no hub, no bridge and no account:

- [Heat & Glo IntelliFire RC300](https://github.com/jbothe/homey-heatnglo-rc300)
- [Bear blinds](https://github.com/jbothe/homey-bear-blind-automation)

## Status

**Phase 1 is done: the protocol is settled.** No app yet — the drivers come next.

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
npm test               # 38 tests, no hardware or captures needed
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
