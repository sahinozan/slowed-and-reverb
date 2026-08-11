# Browser Store Release Plan

This checklist prepares version `1.0.0` of **Slowed & Reverb** for the Chrome Web
Store and Firefox Add-ons. Complete the stages in order and keep the store claims,
privacy declarations, screenshots, and tested packages consistent.

## Current status

Stages 1 and 2 are complete. Version `1.0.0` is frozen at source commit `bc5b97d`
after the full automated checks and final desktop testing passed on Chromium and
Firefox on August 11, 2026. Make only release-blocking implementation changes; any
such change requires repeating the relevant automated and manual checks. Continue
with Stage 3, privacy and support information.

## Version 1.0 decisions

- **Resolved:** Official support is limited to YouTube, YouTube Music, and Spotify.
- **Resolved:** Twitch, SoundCloud, Apple Music, Tidal, and every other site are
  unsupported in `1.0.0`. The extension does not inject into or alter them.
- **Resolved:** Spotify support is a normal supported feature, not experimental. It
  uses optional access to `https://open.spotify.com/*` and remains off until the user
  grants that access.
- **Resolved:** Firefox requests exact optional access to YouTube or YouTube Music on
  first use because Firefox revokes temporary tab access during reload. Chromium does
  not request these additional origins.
- **Accepted:** YouTube live streams support the audio filters but not playback-speed
  changes.
- **Resolved:** Supported pages distinguish active processing, a player that is still
  loading, unexpected DRM, and an unavailable audio pipeline.
- **Deferred:** Firefox Android. The initial Firefox release targets desktop 142+.
- **Resolved:** Processing, presets, and settings stay local. The extension has no
  telemetry, analytics, remote code, or extension-originated network requests.

## Stage 1 - Finish the pre-freeze audit

- Synchronize the README, manifests, package metadata, tests, and store plan.
- Run `npm run check`.
- Run `npm run test:e2e`.
- Confirm the worktree contains only intended release changes.
- Review every requested permission and every generated package file.
- Resolve or explicitly defer every remaining audit finding.

Completion means the implementation and documentation describe the same product and
all automated checks pass.

## Stage 2 - Test and freeze the release candidate

- Build Chromium with `npm run build:chromium`.
- Build Firefox with `npm run build:firefox`.
- In clean desktop profiles, test:
  - YouTube video playback, presets, sliders, EQ, reload restoration, and navigation;
  - YouTube Music playback, track changes, presets, and reload restoration;
  - Spotify permission grant, denial, revocation, reload, track changes, and every
    audio control;
  - YouTube live playback, confirming speed is unavailable while filters still work;
  - Twitch and an ordinary unsupported site, confirming no injection and a clear
    unsupported message;
  - popup themes, custom presets, keyboard shortcuts, and toolbar-icon state.
- Record any accepted limitation needed in public wording or reviewer notes.
- Choose the tested commit as the frozen `1.0.0` release candidate.

After the freeze, make only release-blocking corrections. Any code change requires
repeating the relevant checks and manual tests.

## Stage 3 - Publish privacy and support information

- Publish a public privacy policy at a stable URL covering:
  - local settings and preset storage;
  - the purpose of `activeTab`, `scripting`, and `storage`;
  - Spotify's optional host access;
  - Firefox-only optional YouTube and YouTube Music access for reload restoration;
  - no collection, sale, sharing, telemetry, analytics, or remote processing;
  - no remote code or extension-originated network requests;
  - how to request support or ask a privacy question.
- Choose a public support URL, provisionally the repository's Issues page.
- Confirm the public publisher name and monitored contact email.

## Stage 4 - Prepare shared store text

- Finalize the name, short summary, detailed description, and single-purpose statement.
- Prepare permission justifications for:
  - `activeTab`;
  - `scripting`;
  - `storage`;
  - optional access to `https://open.spotify.com/*`.
- Prepare Firefox-specific justification for optional access to
  `https://www.youtube.com/*` and `https://music.youtube.com/*`.
- Prepare no-data-collection and no-remote-code declarations.
- Provide homepage, support, and privacy-policy URLs.
- Describe only YouTube, YouTube Music, and Spotify as supported.
- Explain Spotify opt-in access and the YouTube live-speed limitation.
- Do not imply affiliation with YouTube, Google, or Spotify.
- Select the closest entertainment or music category available in each dashboard.

## Stage 5 - Create shared screenshots and store graphics

- Confirm the final 128 x 128 PNG icon on light and dark backgrounds.
- Create three to five actual-product screenshots at 1280 x 800:
  1. YouTube with Slowed + Reverb active;
  2. YouTube Music with the Basic controls and EQ;
  3. Spotify working after optional permission has been granted;
  4. Advanced controls;
  5. custom presets or alternate themes.
- Remove account names, private library data, and unnecessary copyrighted artwork.
- Keep screenshots full-bleed, crisp, and faithful to the frozen interface.
- For Chrome, create the required 440 x 280 promotional tile.
- For Chrome, optionally create a 1400 x 560 marquee image.
- Reuse suitable screenshots and the square icon for Firefox. Firefox does not need
  Chrome's promotional tiles.

## Stage 6 - Produce and inspect the exact upload packages

- Run `npm run package`.
- Inspect every entry in:
  - `dist/packages/slowed-reverb-chromium.zip`;
  - `dist/packages/slowed-reverb-firefox.zip`.
- Confirm neither archive contains tests, development files, secrets, local notes, or
  files intended only for the other browser.
- Extract both ZIPs into temporary directories and test those exact extracted builds.
- Record each archive's version, file size, and SHA-256 checksum.
- Do not rebuild after final verification unless this stage is repeated.

## Stage 7 - Set up and secure publisher accounts

This stage requires the account owner.

- Choose durable Google and Mozilla accounts.
- Enable two-factor authentication where available.
- Register for the Chrome Web Store developer account and pay its registration fee.
- Complete required publisher identity and contact verification.
- Register or confirm the Firefox Add-ons developer account.
- Accept the current distribution agreements and enable review-email notifications.

## Stage 8 - Complete the Chrome Web Store submission

- Create the dashboard item and upload the verified Chromium ZIP.
- Complete the Store Listing and Privacy practices sections.
- Upload the icon, screenshots, 440 x 280 tile, and optional marquee.
- Configure visibility, countries, and distribution settings.
- Add concise reviewer instructions for YouTube and optional Spotify support.
- Verify every URL and dashboard preview.
- Select deferred publishing so approval does not immediately make the item public.
- Audit the uploaded checksum, claims, permissions, and declarations before submission.
- Submit and respond narrowly to any reviewer feedback.

## Stage 9 - Complete the Firefox Add-ons submission

- Create the listed add-on and upload the verified Firefox ZIP.
- Complete the listing, privacy, support, license, category, and compatibility fields.
- Upload the shared icon and suitable screenshots.
- Clearly state desktop Firefox 142+ compatibility and do not select Android.
- Explain Spotify's optional permission, Firefox's optional YouTube reload access,
  and include reviewer testing steps for both flows.
- Provide readable source and reproducible build instructions if Mozilla requests a
  source submission.
- Audit the uploaded package and listing, then submit and respond to reviewer feedback.

## Stage 10 - Publish and verify

- After approval, perform one final dashboard and package comparison.
- Publish manually.
- Install each extension from its public store in a clean desktop profile.
- Repeat a short YouTube, YouTube Music, Spotify, and unsupported-site smoke test.
- Confirm public descriptions, screenshots, privacy links, and support links.
- Add the public store URLs and identifiers to the README.
- Tag the verified source commit as `v1.0.0` and create the repository release.
- Monitor reviews, support reports, store-policy email, and crash or playback reports.

## Official references

- [Chrome Web Store documentation](https://developer.chrome.com/docs/webstore)
- [Chrome Web Store listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing/)
- [Chrome Web Store images](https://developer.chrome.com/docs/webstore/images)
- [Chrome Web Store privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)
- [Firefox extension publication](https://extensionworkshop.com/documentation/publish/)
- [Firefox add-on submission](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
- [Firefox add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
