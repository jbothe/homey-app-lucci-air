# Lucci Air Homey App

Homey app for Lucci Air ceiling fans. It sends the same 433 MHz codes as the handset, so the fan needs no
hub, bridge or account. It emulates the handset only; it does not work with Lucci Connect (the separate
Wi-Fi add-on).

Both handsets are reverse-engineered from recordings of the real remote, and each pairs by pressing a
button on your own handset so Homey learns its address.

## Devices

### What you can add

Each remote can be added as a fan, a light, or both on one tile. Each device is paired by pressing a
button on your own remote.

| | USB-C remote | CR2032 remote (legacy) |
|---|---|---|
| fan | Ceiling fan | Ceiling fan (legacy) |
| light | Fan light | Fan light (legacy) |
| fan and light on one tile | Ceiling fan + light | Ceiling fan + light (legacy) |

### What each remote controls

The controls each remote has, and so what Homey can do with it.

| | USB-C remote | CR2032 remote |
|---|---|---|
| fan | on/off, six speeds, direction, timer | off, six speeds, reverse |
| light | on/off, brighter, dimmer, brightness slider | toggle |

The fan and light report nothing back. Homey shows what it last sent or overheard, and keeps listening so
handset presses update it. The light's on/off is a toggle, so pairing asks whether the light is on, and a
button corrects Homey without transmitting. The combined devices have the remote's buttons, not a light
on/off or slider.

## Status

| | USB-C remote | CR2032 remote |
|---|---|---|
| fan on/off and speeds | confirmed on a fan | confirmed on a fan |
| direction | confirmed on a fan | confirmed on a fan |
| timer | confirmed on a fan | not on this remote |
| light | confirmed on a fan | not tested |
| receiving the handset | works | works |

## Flow cards

Homey makes cards for `onoff` and `dim` itself; these cover the rest.

| | cards | devices |
|---|---|---|
| fan speed | changed to, is, set | all four fans |
| direction, timer | changed to, is, set | USB-C fans |
| change direction | action (a flip, nothing tracked) | CR2032 fans |
| toggle light | action | lights, and the combined fans |
| light brighter, dimmer | actions (one step each) | USB-C light and combined fan |

Triggers fire on a change made from Homey or from the handset. They have not been run on a Homey yet;
the tests cover the card definitions and the code behind them.

## Development

```bash
npm test                              # capture tests skip without recordings
homey app validate --level publish
npm run analyse                       # infer a protocol from captures/raw-captures.txt
```

`app.json` is generated from `.homeycompose/`. Recordings are not committed because they carry the code
that operates the fan; see [CONTRIBUTING.md](CONTRIBUTING.md).

| | |
|---|---|
| [RF_PROTOCOL.md](RF_PROTOCOL.md), [RF_PROTOCOL_CR2032.md](RF_PROTOCOL_CR2032.md) | frame layouts, command codes, what is verified |
| [APP_PLAN.md](APP_PLAN.md) | design decisions and why |
| [CAPTURE_GUIDE.md](CAPTURE_GUIDE.md), [CAPTURE_GUIDE_CR2032.md](CAPTURE_GUIDE_CR2032.md) | recording a handset |

## Licence

GPL-3.0. Not made, endorsed or supported by Beacon Lighting or Lucci.
