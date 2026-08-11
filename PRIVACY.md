# Privacy Policy for Slowed & Reverb

Effective date: August 11, 2026

This policy applies to version `1.0.0` of the Slowed & Reverb browser extension
for Chromium-based browsers and Firefox.

## Summary

Slowed & Reverb processes audio locally in the browser. The extension does not
transmit personal information, browsing activity, account information, audio,
page content, usage statistics, diagnostics, or telemetry. It does not create or
retain a browsing history. It has no developer-operated service and makes no
extension-originated network requests.

## Local access and processing

When the user activates Slowed & Reverb on a supported site, the extension uses
access to the active tab to locate that site's media player, read the minimum
player state needed to operate, and apply audio effects through browser media and
Web Audio APIs. Audio remains inside the browser and is never sent to the
developer or another service by the extension.

Slowed & Reverb does not read or store account credentials, authentication
cookies, private library contents, messages, or payment information. YouTube,
YouTube Music, and Spotify continue to make their own network requests under
their respective terms and privacy policies. Slowed & Reverb does not control
those requests.

## Data stored on the device

The browser's local extension storage holds only:

- effect settings, such as speed, reverb, equalizer, and pan values;
- the selected popup theme; and
- user-created preset names and their effect settings.

For reload restoration, browser session storage temporarily holds a tab
identifier, the supported site's origin, the enabled state, and effect settings.
It does not store the full page URL. This session data is removed when the tab is
closed or no longer eligible for restoration, and the browser clears remaining
session data when the browser session ends.

Optional site permissions are recorded and managed by the browser. The extension
can check whether permission is present, but it does not transmit that status.

## Permissions

- `activeTab` gives temporary access to the current tab after the user invokes the
  extension. It is used only to start or control audio processing on a supported
  page.
- `scripting` loads the packaged audio-processing code into the supported tab.
- `storage` saves local settings and presets and keeps eligible per-tab state for
  reload restoration during the browser session.
- Optional access to `https://open.spotify.com/*` lets the packaged Spotify audio
  hook start early enough to process Spotify's web player. It is requested only
  when the user chooses to enable Spotify support and can be revoked at any time.
- On Firefox, optional access to `https://www.youtube.com/*` and
  `https://music.youtube.com/*` lets the extension restore effects after a reload.
  Each site is requested separately on first use and can be revoked at any time.

## Collection, transmission, and sharing

The extension does not:

- send data to the developer or any third party;
- use analytics, telemetry, crash reporting, tracking, or advertising services;
- sell, rent, share, or transfer user data;
- use data for credit decisions, advertising, or profiling; or
- download or execute remote code.

Because no user data is transmitted to or retained by the developer, there is no
server-side user record to access, export, or delete.

Information accessed through browser permissions is used only to provide the
extension's disclosed audio-effects purpose. It is not transferred, used for
advertising or credit decisions, or made available for human review. Slowed &
Reverb's use of information complies with the Chrome Web Store User Data Policy,
including its Limited Use requirements.

## Retention and deletion

Users can delete individual custom presets from the popup and can reset effect
settings to their defaults. The browser clears session-only restoration data at
the end of the browser session. Uninstalling the extension removes its remaining
browser-managed local storage. Slowed & Reverb keeps no server copy.

## Changes to this policy

If a future release changes how the extension handles data, this policy and the
relevant store disclosures will be updated before that release. Material changes
will be disclosed as required by the browser stores.

## Contact and support

Questions, support requests, and privacy questions can be submitted through the
[public issue tracker](https://github.com/sahinozan/slowed-and-reverb/issues).
Please do not include passwords, authentication tokens, private account details,
or other sensitive information in a public issue.

For a private privacy or support question, email
[slowedandreverbsupport@proton.me](mailto:slowedandreverbsupport@proton.me).
Do not send passwords or authentication tokens by email.
