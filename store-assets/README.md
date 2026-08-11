# Store assets

These images are prepared for the `1.0.0` Chrome Web Store and Firefox Add-ons
listings. They reflect the frozen extension interface and were assembled from clean
Chromium captures on August 11, 2026. Popup views are rendered from the production
HTML, CSS, and JavaScript at 3× device-pixel density before final composition.
The complete slides and promotional graphics are supersampled before their final
store-sized render.

## Upload files

- `screenshots/01-youtube.png`: YouTube™ basic controls, 1280 × 800
- `screenshots/02-youtube-music.png`: YouTube Music™ EQ, 1280 × 800
- `screenshots/03-spotify.png`: Spotify web player after opt-in site
  access, 1280 × 800
- `screenshots/04-controls.png`: built-in presets, advanced controls, and
  custom presets, 1280 × 800
- `screenshots/05-themes.png`: Terminal, Midnight, Paper, and Frost themes,
  1280 × 800
- `chrome/promotional-tile-440x280.png`: required Chrome promotional tile
- `chrome/marquee-1400x560.png`: optional Chrome marquee image

Firefox can reuse the five screenshots and `assets/icon128.png`; it does not need
the Chrome promotional images.

## Review notes

- The YouTube example uses *Big Buck Bunny* from the Blender Foundation under
  CC BY 3.0, with attribution included in the image.
- YouTube Music and Spotify use signed-out public search/player views. The source
  captures are not retouched; the final composition adds only the production popup,
  a legibility gradient, and listing captions. Third-party artwork remains incidental
  to the accurate product demonstration.
- Account details, private library content, and profile images are not readable in
  the final files.
- Google and Spotify logos are not used in the standalone promotional graphics.
- Compatibility wording does not imply affiliation or endorsement.
- The screenshots were checked at Chrome Web Store's 640 × 400 display size. Core
  headings, popup controls, and explanatory captions remain legible.

`qa/icon-light-dark.png` is an internal contrast check, not a store upload.

## Rebuilding

Place the three full-resolution, signed-out source captures at:

- `store-assets/source-captures/youtube.png`
- `store-assets/source-captures/youtube-music.png`
- `store-assets/source-captures/spotify.png`

That directory is ignored by Git. Run `npm run store:assets` to rebuild all five
screenshots and both Chrome promotional graphics. The renderer uses the production
popup implementation with a local browser-API mock; it does not edit the interface
or invent controls. Reproducing the approved typography exactly requires the Futura
and Menlo fonts used for the August 11, 2026 macOS render; the checked-in PNG files
are the canonical release assets.
