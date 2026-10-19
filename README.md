# Lucci

Homey app for Beacon Lighting **Lucci** ceiling fans driven by their 433 MHz handset — fan on/off,
speed up and down, direction, and the light's on/off and brightness.

Built the same way as its siblings, by recording the handset and cloning what it sends, so the fan
needs no hub, no bridge and no account:

- [Heat & Glo IntelliFire RC300](https://github.com/jbothe/homey-heatnglo-rc300)
- [Bear blinds](https://github.com/jbothe/homey-bear-blind-automation)

## Status

**Phase 1: capturing the protocol.** No app yet — the drivers come once the handset's frames are
understood.

- [`CAPTURE_GUIDE.md`](CAPTURE_GUIDE.md) — how to record the handset, and how to tell a good
  recording from a bad one.
- [`tools/analyse-capture.js`](tools/analyse-capture.js) — reads a capture and reports the frame
  structure, symbol alphabet, field map and a candidate Homey signal definition.
- `RF_PROTOCOL.md` — not written yet. It is the output of phase 1.

```bash
npm run analyse        # read captures/raw-captures.txt
npm test               # 25 tests, no hardware or captures needed
```

The analyser assumes nothing about the protocol; it infers the structure from the durations. It is
checked against the Bear handset's recordings, where the answer is already documented, and recovers
that protocol's preamble, alphabet, frame length, repeat count, interval and tolerance without
being given any of them.

Recordings are **not committed** — they carry the code that operates the fan.

## Licence

GPL-3.0
