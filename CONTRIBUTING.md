# Contributing

Bug reports and pull requests are welcome at
[github.com/jbothe/homey-app-lucci-air](https://github.com/jbothe/homey-app-lucci-air).

## A useful bug report

- Which handset: the USB-C remote or the legacy CR2032 one, and which device you added (fan, light, or both).
- What you pressed or sent, what the fan did, and what Homey showed.
- The app version, and the Homey firmware version.
- For a fan that ignores Homey, a recording of its handset (see [`CAPTURE_GUIDE.md`](CAPTURE_GUIDE.md) and
  [`CAPTURE_GUIDE_CR2032.md`](CAPTURE_GUIDE_CR2032.md)), attached to the issue. A recording carries the code
  that operates your fan, so it is public once posted; record a handset you are happy to share.

## A pull request

- Run `npm test` and `homey app validate --level publish`; both should pass.
- Keep it to one change. A protocol finding comes with the recordings or measurements behind it, and
  [`RF_PROTOCOL.md`](RF_PROTOCOL.md) or [`RF_PROTOCOL_CR2032.md`](RF_PROTOCOL_CR2032.md) says whether it was
  confirmed on a fan or only inferred.
- `app.json` is generated; edit `.homeycompose/` instead.

## Another handset

The most useful contribution is a recording of a Lucci or Beacon handset that is not here yet. Open an issue
and attach it there.
