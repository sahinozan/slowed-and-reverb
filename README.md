# Slowed & Reverb

A browser extension that changes how songs sound as they play, with speed,
reverb, EQ, and stereo effects, for YouTube™, YouTube Music™, and Spotify. The
sound is processed on your device. The extension collects nothing and makes no
network requests.

## Get the extension

Install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/slowed-reverb/nhndfhonlljbmkpnblndjfdefjoecpoa)
for Chrome, Edge, Brave, and other Chromium browsers, or from
[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/slowed-reverb/)
for desktop Firefox 142 and later.

The website, [slowedreverbapp.com](https://slowedreverbapp.com), has a demo to
try and a guide to every control.

## Use

Open YouTube, YouTube Music, or Spotify and click the toolbar icon. On a supported
tab the extension has never touched, opening the popup applies **Slowed + Reverb**
straight away. Everything else is one click from there.

Spotify first asks for optional access to `open.spotify.com`. After permission is
granted, the page reloads once so the audio hook can start before Spotify's hidden
player. The permission is not requested during installation and can be revoked at
any time in the browser's extension settings.

Firefox also asks for optional access to the current YouTube or YouTube Music site
on first use. Firefox requires that access to restore processing after a page reload;
Chromium keeps using temporary tab access and does not show this additional prompt.

### Controls

**Basic**

| Control | Range | Notes |
| --- | --- | --- |
| Speed | 0.5x – 1.5x | Pitch shifts with speed by default (the actual tape effect) |
| Reverb | 0 – 100% | Generated impulse response, no external files |
| Bass, Mid, Treble | ±12 dB each | Draggable EQ curve; also keyboard-accessible (arrows, Home, End) |

**Advanced**

| Control | Range | Notes |
| --- | --- | --- |
| Keep Original Pitch | on/off | Time-stretches instead of pitch-shifting; can sound robotic below 1.0x |
| Echo | 0 – 100% | Discrete repeats, distinct from reverb's tail |
| Pan | 100% L – 100% R | Applied after widening |
| Width | 0 – 200% | Mid/side; 0 is mono, 100 untouched |
| Saturation | 0 – 100% | Tape/vinyl-style soft clip |

A limiter is always on and has no control. It only engages at extreme settings
that would otherwise clip.

### Presets

Two built-ins (Slowed + Reverb, Nightcore). **My Presets** saves the current
settings under a name; the pencil enters edit mode, where ✓ commits both the
rename and any slider changes and ↺ discards them. Custom presets live only in
`storage.local` and never leave the machine.

### Keyboard shortcuts

Three commands are declared with **no default keys**. Assign them in
`chrome://extensions/shortcuts` on Chromium browsers or through **Manage Extension
Shortcuts** in Firefox's Add-ons Manager:

- **Toggle last preset:** turns the effect off, or back on with this tab's last
  settings (falling back to Slowed + Reverb).
- **Toggle Slowed + Reverb**
- **Toggle Nightcore**

Each toggles off if that exact preset is already what's playing.

### Themes

Five themes (Glow, the default, plus Terminal, Midnight, Paper and Frost)
behind the palette icon. Purely cosmetic and stored globally, not per tab.

### Rating

**Rate** next to Reset Defaults opens the review page of the store the build
came from (Chrome Web Store, or Firefox Add-ons in the Firefox build). After the
popup has been opened with the effect on during 5 different days, it asks once,
above the footer, whether you'd leave a rating. "Rate it", "No thanks" or the
Rate link ends it for good. The day count stays in local storage, and private
windows never add to it. The question steps aside while a notice or permission
panel shows, and on My Presets.

## Behavior worth knowing

- **The support list is intentionally small.** YouTube, YouTube Music, and
  Spotify are supported. Other sites, including Twitch and SoundCloud, are left
  untouched and show a clear unsupported-site message.
- **State is per tab and origin.** Two tabs can run different settings. Enabling
  the effect and reloading restores it, as does navigating within the same
  origin.
- **Supported players report their status.** The popup distinguishes active
  processing from a player that is still loading or has not appeared yet. If a
  supported player rejects Web Audio or exposes DRM unexpectedly, processing is
  stopped and explained instead of being presented as active.
- **YouTube live streams ignore Speed.** The player's own latency correction
  fights it every tick. Reverb, EQ, and the rest still work.
- **Spotify's own speed resets are absorbed.** Spotify sets its player back to
  normal speed every few seconds, and to 0 while it seeks. While the effect is
  on, the Spotify engine keeps the effect's speed through those writes and lets
  a 0 through, so the player never changes speed and needs no silent gap to
  hide Firefox's click. With the effect off, Spotify's speeds pass through.
- **An update needs a page reload.** The audio engines run in the page and stay
  there when the extension is updated. On YouTube, the new version's scripts
  join the old engine as soon as the popup opens, in both browsers; on Spotify,
  Firefox puts them next to it when the extension is turned off and on again
  without a reload. Each engine reports its version, so content.js and the
  Spotify bridge keep an engine from another version off and the popup asks for
  a reload.
- **Embedded players may be unreachable.** Media inside iframes or shadow roots
  is not currently processed. Frame support can require broader permissions,
  and both cases need more complex lifecycle and state handling.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the commands and how pull
requests work. [docs/testing.md](docs/testing.md) says what each test command
covers.

## Privacy

No data collection, no analytics, no external network requests. Core permissions
are `activeTab`, `scripting`, and `storage`. Initial YouTube and YouTube Music access
begins only after the user opens the popup or uses a shortcut on that tab. The
Firefox package declares optional access to `www.youtube.com` and
`music.youtube.com` so it can restore only previously enabled tabs after reload;
each origin is requested separately on first use and neither is granted at
installation. Spotify declares optional access to `open.spotify.com` in both
packages and requests it only when the user chooses **Allow on Spotify** while
visiting the web player. Revoking optional site access neutralizes processing and
prevents later restoration on that site.

Read the full [privacy policy](PRIVACY.md). For questions and bug reports, follow
the [support guide](SUPPORT.md). Report suspected vulnerabilities privately as
described in the [security policy](SECURITY.md).

## License

Released under the [MIT License](LICENSE). Use of the extension remains subject
to the terms of service of the websites on which it is used.

Slowed & Reverb is independently developed and is not affiliated with, endorsed
by, or sponsored by Google or Spotify. YouTube and YouTube Music are trademarks
of Google LLC. Spotify is a trademark of Spotify AB.
