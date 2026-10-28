# Release checklist

The checks a person does for a store release, for what the automated tests
don't check today: the real sites, the browsers' own windows and prompts, and
real sound from speakers or headphones. `npm run release` runs the release's automated
checks; `npm run test:ui` and the audio suites run separately (`AGENTS.md`).
Record what you did in the draft's "checked by hand" line in
`RELEASE-<version>.txt`: the commit, each browser and its version, the
operating system, the sound output, and each item below as passed, failed or
not applicable. If an attempt failed, record it too, not only the attempt
that passed after it.

Use the packages in `dist/packages/<version>/`: load the Chromium one
unpacked from its extracted zip in a current Chromium browser, and the Firefox
one as a temporary add-on in current desktop Firefox. Use a profile without
an earlier copy of the extension, so the first-use steps are first uses.

## In each browser

### The entry points

These come first, each on a site the extension hasn't been used on yet in
this profile, so neither borrows access the other gave it.

- [ ] Assign a key to "Toggle Slowed + Reverb" (README, "Keyboard
      shortcuts"). On YouTube, without opening the popup, press it. You hear
      the song change.
- [ ] On YouTube Music, open the popup from the toolbar. In Chromium, the
      effect turns on. In Firefox, the popup asks first: choose **Allow on
      YouTube Music** and accept the browser's prompt, and the effect turns
      on. Either way, you hear the song slow down.

### Permission prompts

- [ ] On Spotify, choose **Allow on Spotify** and accept the browser's
      prompt. The page reloads once and the effect plays.
- [ ] In Firefox, open the popup on YouTube, choose **Allow on YouTube** and
      accept the browser's prompt. Reload YouTube and YouTube Music: on each,
      the effect comes back without asking again.

### The real sites

On speakers or headphones you can hear, with one song on each of YouTube,
YouTube Music and Spotify:

- [ ] The effect on and off, and one built-in preset.
- [ ] A seek, then a reload with the effect still on afterward.
- [ ] Moving to another video on YouTube and to another song on YouTube
      Music, without reloading. The effect carries over.
- [ ] On Spotify, a minute of play (Spotify resets the player's speed every
      few seconds) with no skips or gaps, then the next track.
- [ ] No clicks or dropouts at any point. In Firefox, note any click about 2
      to 4 seconds after turning the effect on while a song plays
      (`e2e/audio-capture/README.md`, "Limits").

### Last: revoking access

- [ ] Revoke a site's access in the browser's extension settings. The effect
      stops on that site and stays off after a reload. Allow it again if you
      go on testing there.

## When it applies

- [ ] **The popup's frame changed in CSS:** look at the real popup in
      Firefox, with its rounded panel corners.
- [ ] **The permission code changed** (the manifest's permissions, or how
      the extension asks for access or handles it): in each browser, also
      outside a release, the YouTube Music step under "The entry points"
      (Firefox's YouTube Music prompt), "Permission prompts", a reload of each
      site with the effect on, and revoking access.
- [ ] **A change can affect how the effect sounds** (the audio graph's
      wiring, an effect's code, gains, fades, presets or defaults, or a
      browser change to Web Audio): listen to reverb, echo, EQ, width and
      saturation with music. The audio suite keeps echo, saturation and EQ
      neutral, so it can't hear this.
- [ ] **New store art:** look at each image at the size the store shows it
      (`store-assets/README.md`).

## After publishing

Once both stores have published the release:

- [ ] Install it from the Chrome Web Store and from Firefox Add-ons. Check the
      version on the browser's extensions page, and play one song with the
      effect on. This is the package each store signed and delivers, which
      nothing else checks.
