# LG webOS Control distribution description

LG webOS Control is a local-network Stream Deck plugin for controlling LG webOS TVs from your desk. It is built for the everyday case where audio or media is already playing on the TV, for example Spotify Connect running in the TV's native Spotify app, and you want reliable volume and playback controls without opening LG ThinQ, using Google Home, or reaching for the TV remote.

The plugin talks directly to the TV over LG webOS's local websocket and SSAP API. No cloud relay is required for normal control. The TV and computer running Stream Deck just need to be on the same LAN or VLAN, and LG Connect Apps must be enabled on the TV.

## Key features

- Volume up and volume down controls
- Mute, unmute, and mute toggle actions
- Set-volume action for configured volume targets
- Media play, pause, stop, rewind, and fast forward
- Combined play/pause toggle for TVs and apps where LG's native playPause state is unreliable
- Launch TV apps from Stream Deck
- Switch inputs from Stream Deck
- TV status action
- Stream Deck + dial support
- Touch strip feedback for dial actions
- Clean icon-first UI using LG red controls and open-source Lucide glyphs
- Local pairing flow from the Property Inspector
- Pairing keys are stored locally by the plugin and are not exported in Stream Deck action settings or profiles

## Stream Deck + dial behavior

On Stream Deck +, the same LG webOS Control action supports encoder and dial use:

- Rotate clockwise: TV volume up
- Rotate counter-clockwise: TV volume down
- Press dial: mute toggle
- Tap touch strip: play/pause toggle

## Device detection and pairing

The Property Inspector supports scanning for LG webOS TVs on the local network and also allows manual entry of a TV IP address. Discovery uses local network discovery where available, then the plugin connects to the TV over the webOS websocket interface, commonly on ports 3001 or 3000.

On first pairing, the TV displays an approval prompt. Once approved, the plugin saves a local client key for future commands. If discovery is blocked by router, VLAN, multicast, or firewall behavior, manual IP entry still works as long as the computer can reach the TV over the LAN.

## Tested TV

Tested with an LG OLED55CXPUA webOS TV. Core tested flows include volume up/down, mute toggle, independent media play/pause, the optimistic play/pause toggle, Stream Deck key actions, and Stream Deck + dial support.

The plugin is intended for LG webOS TVs that expose the local LG Connect Apps / SSAP websocket control interface. Exact support can vary by model, firmware, network layout, and audio setup.

## Compatibility

- Stream Deck app: 6.9 or later
- Stream Deck manifest SDK: version 3
- macOS: 10.15 or later
- Windows: 10 or later
- Controllers: Keypad and Encoder / Stream Deck + dials
- DRM: enable in Elgato Maker Console for Marketplace distribution

## Privacy and network behavior

LG webOS Control is designed as a local-first plugin. It controls the TV over the local network rather than routing commands through Google Home, LG ThinQ cloud automations, or a third-party service. Pairing credentials remain local to the user's machine.

## Notes

The combined play/pause action intentionally uses a practical local toggle because some LG webOS app and player combinations report playback state inconsistently. If playback is changed outside Stream Deck, for example from a phone, the TV remote, or Spotify itself, the toggle may need one extra press to resync. The dedicated play and pause buttons remain available for explicit control.
