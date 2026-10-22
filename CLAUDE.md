# Lucci Air

Homey app (SDK 3, id `com.lucci.fan`) that drives Lucci Air ceiling fans over 433 MHz by cloning their
handsets. No hub, no bridge, no account. Two handset families, each with its own signal, protocol
module and drivers:

- **USB-C remote** (Lucci Air): `fan`, `light`, `fan-light`. Protocol in `lib/lucci-protocol.js`,
  described in `RF_PROTOCOL.md`.
- **CR2032 remote** (Lucci Whitehaven, Rhine RH787NRN receiver): `fan-cr2032`, `light-cr2032`,
  `fan-light-cr2032`. Protocol in `lib/cr2032-protocol.js`, described in `RF_PROTOCOL_CR2032.md`. It is a
  different protocol, not a variant; share nothing between the two except the app and `lib/press-queue.js`.

## Commands

```bash
npm test                              # node --test; capture tests skip without recordings
homey app validate --level publish    # must pass before any release
homey app run                         # run on a Homey over the network
npm run analyse                       # read captures/raw-captures.txt (USB-C remote)
npm run analyse:cr2032                # read captures/fan2-cr2032.txt
```

## Layout

- `app.js` owns the 433 MHz receivers, one per signal, with a reference count. Homey's `enableRX` and
  `disableRX` act on the signal, not on the caller, so the count lives in one place.
- `lib/` holds the protocols, the pairing base classes, `press-queue.js` (spacing transmissions) and
  `reflect.js` (deferred capability writes) and `flow.js` (flow card listeners and the change triggers). `lib/light-position.js` is the brightness arithmetic, no Homey.
- `drivers/<id>/` has `driver.compose.json`, `driver.js`, `device.js`, `pair/` and images.
- `.homeycompose/` is the source for `app.json`, capabilities, flow cards and the signal definitions. Flow
  cards are app-level and narrowed to drivers by a `driver_id` filter; Homey makes none for custom capabilities. **`app.json` is
  generated; edit `.homeycompose/` and `locales/`.**
- `tools/` infers a protocol from raw recordings. `test/synth.js` builds synthetic recordings so the
  analyser is tested against a known answer.
- `RF_PROTOCOL*.md` and `APP_PLAN.md` hold the findings and the reasoning. Read them before changing
  protocol or light behaviour; the comments in `lib/` give the why of most oddities.

## Things that bite

- **Setting capability B inside capability A's listener is silently lost.** Defer it with `reflect()`.
  Pass an arrow to `.catch`, never `this.error`, or the original error never logs.
- **`signal.tx()` resolves when the burst is queued, not sent.** Transmit through the press queue, or two
  presses merge into one held button.
- **Bit 24 of a USB-C frame belongs to the handset.** It is learned at pairing, not computed, and the app
  refuses to transmit without it.
- **The light reports nothing.** Its on/off is a toggle and its brightness is relative, so Homey holds a
  belief. Keep `onoff` idempotent against that belief and keep the buttons that claim nothing.
- The receiver drops the first bit of a burst; see "Receiving" in `RF_PROTOCOL.md`.

## Conventions

- Say what is **verified on a fan** and what is only consistent with recordings. Do not upgrade a claim
  without a hardware result. The CR2032 light has not been transmitted to a real fan (the USB-C light has).
- Recordings in `captures/` are gitignored because they carry the code that operates a fan. Never commit one.
- Four languages (en, nl, de, fr) for everything a user reads: `locales/`, compose files, `README*.txt`.
- `README.txt` is the store listing: plain text, factual, no marketing language.
- Match the surrounding code's comment style. Comments here explain *why*, usually with the failure that
  taught it.

## Working in this checkout

The tree may hold uncommitted work that is not yours. Stage files by name (never `git add -A`), check
`git diff --cached --stat` before committing, and say which test failures were already there.

Repo: https://github.com/jbothe/homey-app-lucci-air
