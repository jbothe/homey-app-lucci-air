Controls Lucci Air ceiling fans and their lights from Homey by sending the same 433 MHz codes as the handset.

When you add a fan, you press a button on your handset and Homey learns its address, so it only talks to your fan. Homey keeps listening afterwards, so changes made with the handset show up in Homey.

Two handsets are supported:
- USB-C rechargeable: fan on/off, six speeds, direction and timer; light on/off and brightness.
- CR2032: off, six speeds, reverse and a light toggle.

Add the fan, the light, or both on one tile.

Limitations:
- The fan and light send nothing back. Homey shows what it last sent or heard.
- The light's on/off is a toggle. Homey asks whether the light is on when you add it, and a button corrects it if it gets out of step.
- The light has not been tested on a real fan.
- This app emulates the handset over 433 MHz. It does not work with Lucci Connect, the separate Wi-Fi add-on.

Not made, endorsed or supported by Beacon Lighting or Lucci.
