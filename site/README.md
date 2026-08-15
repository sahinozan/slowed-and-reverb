# Site

The public page for the extension. Three files and a folder of assets, with no
build step, no framework, and no third-party request at runtime.

```text
site/
  index.html      the whole page
  styles.css      the visual system, tokens at the top
  app.js          only the hero speed readout; the page works without it
  assets/         popup renders, icon, motif, and the display font
```

## Preview locally

```sh
python3 -m http.server 8080 --directory site
```

Then open `http://localhost:8080/`. Serve it rather than opening `index.html`
over `file://`, because the font and the popup renders are loaded as normal
requests.

## Assets

`assets/popup-*.png` are captures of the shipping popup, produced by loading
the real `popup.html`, `popup.css`, and `popup.js` in a headless browser:

```sh
npm run site:assets
```

Panels people read render at 3x; the theme thumbnails render at 2x. The command
prints each file's pixel size, which is what the `width` and `height` attributes
in `index.html` must say. Update them when a panel changes size, otherwise the
page reserves the wrong space while images load. `scripts/popup-preview.js` holds
the extension-API stub the renders run against, shared with the store art so
there is only one copy to keep working.

The store screenshots under `store-assets/` are not used here. They exist
because Chrome and Firefox require them, and at page size the popup inside them
is unreadable.

`assets/icon.svg` is a copy of the shipped extension icon. `assets/rate-field.svg`
is the bar motif, its spacing produced by the same rate-ramp integration as
`rateBars()` in `scripts/render-store-assets.js`. `assets/og-card.png` is the
store marquee, reused as the social preview image.

`assets/jost-700-latin.woff2` is Jost 700, latin subset, under the SIL Open Font
License in `assets/jost-OFL.txt`. It is self-hosted because the store art is set
in Futura, which ships only on macOS: without it, half the audience would see
the headlines in a fallback face. Replacing it means replacing both files and
the `@font-face` block at the top of `styles.css`.

## Deploying

The site is served at `slowedreverbapp.com` by Cloudflare, connected to this
repository. `wrangler.jsonc` in the repository root points Cloudflare at this
folder and is the entire configuration: there is no build step, no Worker
script, and no build command. Wrangler runs in Cloudflare's build container, so
it is not a dependency here.

Cloudflare redeploys on every push to `main`, and gives each other branch a
preview URL. The domain is registered in the same Cloudflare account, so
attaching it to the project creates the DNS record automatically; no record
needs writing by hand and no `CNAME` file belongs in this folder.

The absolute URLs in the `<head>` of `index.html` (canonical and Open Graph)
point at that domain. They are the only place the domain is hard-coded.

The Chrome and Firefox buttons point at their published store listings. Both
store dashboards should list `https://slowedreverbapp.com` as the homepage.

## Editing rules

- Hot pink `#e8597f` is for rules, fills, and the motif only. It fails contrast
  as small text on both grounds; rose and bone carry words.
- Square corners everywhere, and depth is a hard offset block rather than a blur.
- Write for listeners, not developers. Permission names, file names, `iframe`,
  `storage.local`, and anything else from the codebase belong in the repository
  docs instead. If a limitation cannot be explained in plain words, leave it out.
- No horizontal scrolling. Everything reads in the normal page scroll.
- Show the real interface. Every frame on the page is a render of the popup, not
  a mockup or a marketing composite.
