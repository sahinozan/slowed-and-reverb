# Store assets

Images for the Chrome Web Store and Firefox Add-ons listings, in the same
visual language as the website: Fraunces headings, the pink accent, a deep cherry
ground, the cassette, and the production popup. `npm run store:assets` builds all
of them from `scripts/render-store-assets.js`. The listing text is in
`LISTING.md`.

## Upload files

- `screenshots/01-youtube.png`: the popup on YouTube™ and YouTube Music™,
  opened from the toolbar icon, 1280 × 800
- `screenshots/02-spotify.png`: the Spotify web player's one-time "Allow on
  Spotify" step, enlarged, 1280 × 800
- `screenshots/03-advanced.png`: the Advanced tab, "Every control is free to
  use", 1280 × 800
- `screenshots/04-presets.png`: My Presets and the other three themes,
  1280 × 800
- `screenshots/05-privacy.png`: "Everything happens in your browser",
  1280 × 800
- `chrome/promotional-tile-440x280.png`: required Chrome promotional tile
- `chrome/marquee-1400x560.png`: optional Chrome marquee image
- `chrome/store-icon-128.png`: the Chrome store icon. The extension's own icons
  fill their 128px square; Google asks for the store icon's artwork to fit
  96 × 96 with transparent space around it, so this copy is scaled to 3/4.
  `npm run icons` builds it with the other icons.

Firefox can reuse the five screenshots and `extension/assets/icon128.png`; it
does not need the Chrome promotional images. The same run also writes
`site/assets/og-card.png`, the website's 1200 × 630 social preview.

## Sizing for the store

The Chrome Web Store shows screenshots at 593 × 371, 46% of their size, two
side by side, and the promo tile at about 306 × 195 in search results. The
renderer is sized for that:

- headlines 60px and the line under them 26px (about 28px and 12px on the
  store);
- the popup 470px wide or more, so its labels and values stay readable;
- at least 48px clear on every edge.

Check new art at that size before uploading, not only at full size.

## Rules

- Captions are one plain heading and one plain line. No slogans, American
  spelling, and the same voice as the website.
- Slides 1-2 show a blurred page capture under a plain drawn toolbar. The
  extension's icon is ringed in the accent color and the popup opens below it,
  so new users see where to click. The toolbar is drawn rather than captured,
  so the capturing browser does not matter, and it is tinted to the cherry
  ground so the ringed icon is the one accent.
- Slides 3-5 are close-ups: no toolbar, the popup larger, and the page blurred
  further so it reads as color rather than as a page.
- The Spotify slide shows only the popup's header and opt-in box, enlarged, so
  its text reads at store size. Elsewhere the whole popup is shown, as large as
  fits.
- Pages are blurred because at store size their detail only competes with the
  popup.
- The popup is the production popup, rendered at 3× from `extension/` through
  `scripts/popup-preview.js`. Nothing in it is mocked up.
- The cassette is read from `site/index.html`, so the store art and the site
  share one drawing.
- Promo images use the website's glow: a near-black cherry ground with blurred
  pink and violet light behind the cassette, as on the home page. The promo
  tile shows the cassette with only its name on the label; Google asks for no
  text on promotional images, and the label is part of the drawing rather than
  a caption.
- The name in Fraunces uses its plain "&" (the `ss01` alternate) rather than
  the curly one it draws at display sizes.
- Google and Spotify logos are not used in the promotional images, and
  compatibility wording does not imply affiliation or endorsement.

## Captures

`CAPTURES` at the top of the renderer lists the page captures and how much to
trim from each: `cropTop` removes the macOS menu bar and the capturing
browser's own toolbar, `cropSide` the window border. Captures are full-screen
5120 × 2880 screenshots of a maximized browser window, signed out or with no
personal details visible, and with the extension popup closed.

The captures in use are archived, unmodified, in `originals/` with their
original filenames and SHA-256 checksums. Keep these tracked originals; new
captures go into a new dated folder there, and `CAPTURES` points at them.

## Fonts

Headings use `site/assets/fonts/fraunces.woff2`, the same file as the website.
Body text uses Avenir Next and the cassette label uses Menlo, both of which ship
with macOS, so the checked-in PNG files are the canonical release assets and
reproducing them exactly needs a Mac.

`qa/icon-light-dark.png` is an internal contrast check, not a store upload.
