---
name: store-assets
description: Steps for making the store's images again (the screenshots, the Chrome promo tile and marquee, the website's social card, the icons) and for changing the listing text in store-assets/LISTING.md. Use when the popup's look, the icon, a caption, a page capture or the store text changes, or when asked for new store art. Needs a Mac for the images.
---

# The store's images and text

`store-assets/README.md` says what each image is, the sizes the stores show
them at and the rules for captions and captures. The images are generated:
change what they are made from, then run the command. Uploading to a store
is the owner's; never do it.

## The images

1. **Change the source.** The slides, captions and promo images are drawn
   by `scripts/render-store-assets.js`, from the production popup, the page
   captures in `store-assets/originals/`, the cassette in `site/index.html`
   and `site/assets/fonts/fraunces.woff2`. The icons, the Chrome store icon
   and the mark in the popup's header are drawn by `scripts/render-icons.js`.
2. **Make them again**, on a Mac (the body text uses fonts that ship with
   macOS), in this order. The screenshots show the popup, and the popup
   shows the mark, so the icons come first:

   ```sh
   npm run icons          # when the drawing changed: the icons, the store icon, the popup's header mark
   npm run site:popup     # after npm run icons, which writes extension/popup.html
   npm run store:assets   # screenshots, Firefox's larger ones, promo tile, marquee, site/assets/og-card.png
   ```

   `npm run icons` and `npm run store:assets` start Playwright's Chromium.
3. **New page captures** are full-screen 5120 × 2880 screenshots of a
   maximized browser window, signed out or with no personal details
   showing, with the popup closed. Put them in a new dated folder in
   `store-assets/originals/` with their original names and SHA-256
   checksums, point `CAPTURES` at the top of
   `scripts/render-store-assets.js` at them, and delete the folder they
   replace.
4. **Look at each new image at the size the store shows it**, not only at
   full size: a screenshot at 593 × 371, the promo tile at about 306 × 195.
   This is the `store-art-look` check. Show the owner the images that
   changed.
5. **Commit the images with what they were made from**, and run
   `npm run checks:for` and `npm run check`.

## The listing text

`store-assets/LISTING.md` holds the approved text, with notes on how each
store reads it. Change it there, in a pull request, before it changes in a
store.

- Chrome's description is plain text. Firefox's description, release notes
  and privacy policy are Markdown that escapes HTML and drops headings, so
  section titles are bold lines.
- Chrome's summary is the `description` in `extension/manifest.json`, so it
  changes only with a release (the `release` skill).
- The rules for the words, trademarks included, are in `AGENTS.md`
  ("Rules").
