# Store Listing Copy for Version 1.0.0

This is the ready-to-paste source of truth for the Chrome Web Store and Firefox
Add-ons. The public copy is intentionally concise. Dashboard answers and reviewer
notes are included below so they remain consistent with the extension and its
privacy policy.

## Identity

- **Name:** Slowed & Reverb
- **Publisher:** Ozan Sahin
- **Language:** English
- **Chrome category:** Entertainment
- **Firefox category:** Photos, Music & Videos
- **Mature content:** No
- **Homepage:** `https://slowedreverbapp.com`
- **Support:** `https://github.com/sahinozan/slowed-and-reverb/issues`
- **Support email:** `slowedandreverbsupport@proton.me`
- **Privacy policy:**
  `https://github.com/sahinozan/slowed-and-reverb/blob/main/PRIVACY.md`
- **License:** MIT

Do not add site names or effect keywords to the extension title.

## Public summary

This is 123 characters and matches the manifest description.

```text
Real-time speed, reverb, EQ, and stereo effects for YouTube™, YouTube Music™, and Spotify. Processing stays on your device.
```

## Public detailed description

Use this on both stores:

```text
Change how supported music and video sounds in real time. Open the toolbar popup and adjust the audio while it plays. The extension does not download media or send audio to the developer.

Features

- Speed from 0.5x to 1.5x, with tape-style pitch shifting or optional original-pitch preservation
- Reverb, three-band EQ, echo, pan, stereo width, and saturation
- Slowed + Reverb and Nightcore presets
- Custom presets, optional keyboard shortcuts, and four popup themes
- Per-tab settings that restore after navigation or reload

Supported sites

- YouTube™
- YouTube Music™
- Spotify web player

Spotify support is optional. Access to open.spotify.com is requested only when you choose to enable it and can be revoked in browser extension settings. Other sites are left unchanged.

Audio processing happens locally in the browser. Slowed & Reverb has no analytics, telemetry, advertising, remote code, or extension-originated network requests.

Notes

- A newly opened tab starts with effects off.
- YouTube live streams support audio filters but not speed changes.
- Firefox Android is not supported in version 1.0.0.

Slowed & Reverb is independently developed and is not affiliated with, endorsed by, or sponsored by Google or Spotify.

YouTube and YouTube Music are trademarks of Google LLC. Spotify is a trademark of Spotify AB.
```

For the Chrome listing only, remove the Firefox Android bullet because it is not
relevant to Chrome users.

For the Firefox listing, add this paragraph after the Spotify permission
paragraph:

```text
On Firefox, restoring effects after a reload requires optional access to the exact YouTube or YouTube Music site being used. That access is requested on first use, not during installation, and can be revoked at any time.
```

## Chrome dashboard answers

### Single purpose

```text
Provide user-controlled, real-time audio effects for media playing in supported YouTube, YouTube Music, and Spotify web-player tabs.
```

### `activeTab`

```text
Used only after the user opens the popup or invokes an assigned shortcut. It provides temporary access to the active YouTube or YouTube Music tab so the extension can identify the supported player and start or control local audio processing. It is not used for passive browsing access.
```

### `scripting`

```text
Used to load packaged audio-processing scripts into supported tabs. YouTube and YouTube Music scripts are injected after the user invokes the extension. Spotify document-start hooks are registered only after the user grants optional access to open.spotify.com. No remote code is loaded or executed.
```

### `storage`

```text
Used to save effect values, the selected theme, and custom presets in browser-managed local storage. Session storage temporarily keeps a supported site's origin and per-tab effect state so a previously enabled tab can recover after navigation or reload. The full page URL is not retained, and no stored data is transmitted by the extension.
```

### Optional Spotify host access

```text
Optional access to https://open.spotify.com/* allows the packaged audio hook to start before Spotify creates its web player, which is necessary for the supported real-time effects. Access is requested only when the user chooses Allow on Spotify while visiting open.spotify.com. It is not requested at installation and can be revoked at any time.
```

### Remote code

Select **No, I am not using remote code**.

```text
All executable code is packaged with the extension. The extension does not download or execute JavaScript, WebAssembly, or other logic from remote sources.
```

### Data-use disclosure

Select only:

- **Website content:** the supported page's audio media and minimum player state
  are handled locally to apply the effects selected by the user.
- **Web history:** the supported site's origin is temporarily stored with per-tab
  effect state for reload restoration. The full URL and a browsing history are
  not retained.

Chrome requires local handling to be disclosed even when data never leaves the
device. Certify that the data is not sold, used or transferred outside the
single purpose, used for advertising, made available for human review, or used
for credit or lending decisions. Do not select another data category.

### Reviewer notes

```text
Slowed & Reverb supports YouTube, YouTube Music, and the Spotify web player. YouTube provides the core effect functionality without requiring a separate extension account.

YouTube test:
1. Open a normal video on https://www.youtube.com/.
2. Open the extension popup. Slowed + Reverb starts on this previously untouched tab.
3. Adjust speed, reverb, EQ, or pan and confirm the audio changes.
4. Navigate to another video in the same tab or reload to confirm restoration.

Spotify optional-permission test:
1. Open https://open.spotify.com/.
2. Open the popup and choose Allow on Spotify.
3. Approve the optional host-permission prompt. Spotify reloads so the packaged document-start audio hook can attach.
4. Start playback in the Spotify web player and adjust the controls.
5. Revoke open.spotify.com access in extension settings to confirm that processing is neutralized without changing normal Spotify playback.

The extension does not receive account credentials. It does not download media, bypass access controls, transmit data, or load remote code. YouTube live streams support filters but intentionally do not support speed changes. Unsupported sites show a clear message and are not modified.
```

## Firefox dashboard answers

### Optional YouTube host access

```text
Optional access to https://www.youtube.com/* and https://music.youtube.com/* is requested separately on first use. Firefox ends temporary active-tab access during a reload, so exact optional access is needed to restore effects on a previously enabled tab. Either permission can be denied or revoked without affecting normal site playback.
```

Use the Chrome Spotify explanation for optional access to
`https://open.spotify.com/*`.

### Data collection

The generated Firefox manifest declares
`browser_specific_settings.gecko.data_collection_permissions.required` as
`["none"]`. The add-on transmits no personal, technical, interaction, browsing,
audio, or website-content data outside the add-on or local browser.

### Reviewer notes

```text
This is a desktop-only Firefox 142+ release. Firefox Android is not declared or supported. YouTube provides the core effect functionality without requiring a separate extension account.

YouTube and YouTube Music test:
1. Open a normal video or song on https://www.youtube.com/ or https://music.youtube.com/.
2. Open the popup and choose the exact optional site-access button.
3. Approve Firefox's permission prompt.
4. Adjust the controls, navigate within the same site, and reload to confirm restoration.
5. Revoke that site's access to confirm that processing is neutralized and native playback still works.

Spotify optional-permission test:
1. Open https://open.spotify.com/.
2. Open the popup, choose Allow on Spotify, and approve the optional permission.
3. After Spotify reloads, start playback and adjust the controls.
4. Revoke Spotify access to confirm that processing is neutralized and native playback still works.

The add-on does not receive account credentials, download media, bypass access controls, transmit data, or load remote code. YouTube live streams support filters but intentionally do not support speed changes. Other sites are unsupported and left unchanged.
```

### Version notes

```text
Initial desktop release with real-time speed, reverb, three-band EQ, echo, pan, stereo width, saturation, built-in and custom presets, keyboard commands, and four themes for YouTube, YouTube Music, and Spotify. Audio processing stays local with no telemetry or remote code.
```

### Tags

- audio
- equalizer
- music
- reverb
- spotify
- youtube

## Brand and claims guardrails

- Do not use Google or Spotify names in the extension title or icon.
- Do not use Google or Spotify logos, Spotify Green, album artwork, or artist
  imagery as promotional design elements.
- Use YouTube™ and YouTube Music™ in compatibility copy and keep the trademark
  attribution in the detailed description.
- Describe Spotify compatibility as support for the Spotify web player. Do not
  imply a partnership or official integration.
- Do not claim universal site support, DRM bypass, media downloading, Firefox
  Android support, or speed control on YouTube live streams.
- Do not describe Twitch, SoundCloud, Apple Music, or Tidal as supported.
- Do not use superlatives, competitor comparisons, keyword stuffing, or claims
  such as "official," "best," or "works everywhere."

## Badge readiness

Chrome's Featured badge has no guaranteed checklist. After the extension is
public and stable, it can be nominated through Chrome's One Stop Support trial.
The current release is positioned well because it uses Manifest V3 and current
APIs, has a clear single purpose, works on YouTube without extra credentials or
payment, requests narrow permissions in context, and has privacy, support,
automated tests, and manual cross-browser testing. Final screenshots and
promotional images must be equally accurate and polished.

The Established Publisher badge is separate and normally requires identity
verification plus a positive policy record over at least a few months.

Firefox's comparable Recommended Extensions program is more selective and
expects exemplary function, security, user experience, responsive maintenance,
and ongoing review. Consider nomination only after the public release has a
stable track record.

## Official references

- [Chrome Web Store best practices](https://developer.chrome.com/docs/webstore/best-practices)
- [Chrome quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)
- [Chrome listing guidance](https://developer.chrome.com/docs/webstore/best-listing)
- [Chrome discovery and badges](https://developer.chrome.com/docs/webstore/discovery)
- [Chrome branding guidelines](https://developer.chrome.com/docs/webstore/branding)
- [Chrome user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Chrome Limited Use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Firefox add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
- [Firefox listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/)
- [Firefox permission guidance](https://extensionworkshop.com/documentation/develop/request-the-right-permissions/)
- [Firefox data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Firefox Recommended Extensions](https://extensionworkshop.com/documentation/publish/recommended-extensions/)
- [Spotify design and branding guidelines](https://developer.spotify.com/documentation/design)
