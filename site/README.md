# Site

The public website for the extension, served at
[slowedreverbapp.com](https://slowedreverbapp.com). Plain HTML, CSS, and a few
small scripts, with no build step, no framework, and no third-party request at
runtime.

```text
site/
  index.html        home: what it does, the demo, getting started
  guide.html        how to use: every control, next to the live popup
  faq.html          help
  changelog.html    release notes
  privacy.html      privacy policy, with a technical section for store reviewers
  404.html          served for unknown addresses
  styles.css        everything visual; theme tokens at the top
  site.js           applies the popup's theme to the page and the favicon
  app.js            home page: cassette, speed fader, demo controls
  guide.js          guide page: switches the popup's tab as you scroll
  demo-audio.js     the demo's audio chain, mirroring extension/content.js
  popup-embed.js    talks to the popup iframe
  popup/            a copy of the shipping popup, plus popup-host.js
  assets/           icon, social image, font, brand logos, demo audio
  robots.txt, sitemap.xml
  _headers          caching rules Cloudflare applies
```

## Preview locally

```sh
npm run site:serve
```

Then open `http://localhost:8080/`. The script serves the folder the way
Cloudflare does: pages at clean addresses (`/guide` serves `guide.html`, and
`/guide.html` redirects there), `404.html` for unknown addresses, and nothing
listed in `.assetsignore`. A plain static server will not do, because links
point at the clean addresses.

## The popup on the page

The home and guide pages run the real extension popup in an iframe. `popup/`
holds copies of `extension/popup.html`, `popup.css`, and `popup.js`; the only
change is one extra script tag in `popup.html` that loads `popup-host.js`, which
stands in for the extension API and tells the page what the popup applied.
After any change to the popup, copy it again:

```sh
npm run site:popup
```

`tests/site.test.js` fails while the copy is out of date, and also checks that
every local link and anchor exists, that no page loads anything from another
website, and that the demo song is credited.

## Demo audio

`assets/audio/start-again-loop.mp3` is 24 seconds of "Start Again" by Alex
Beroza featuring Snowflake & Subliminal, licensed CC BY 3.0. The license needs
the credit and a note that the clip was changed, so both pages that play it
carry a credit line with links to the source and the license. The exact edit
is described in `assets/audio/CREDITS.txt`. `demo-audio.js` decodes the file and
loops it as WAV, because an `<audio>` element does not loop MP3 without a gap.

## Font

`assets/fonts/fraunces.woff2` is Fraunces, under the SIL Open Font License in
`assets/fonts/fraunces-OFL.txt`, cut down to what the site uses: weight 600, the
optical size axis, SOFT from 0 to 60, WONK fixed at 1, and Latin characters. It
was made with fontTools from the full variable font:

```sh
fonttools varLib.instancer Fraunces.ttf wght=600 WONK=1 SOFT=0:60 -o fraunces-instanced.ttf
pyftsubset fraunces-instanced.ttf --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+2122,U+2212" --layout-features='*' --flavor=woff2 --output-file=fraunces.woff2
```

Using another weight or axis value in `styles.css` means making the file again.

## Other assets

`assets/icon.svg` is a copy of the shipped extension icon. `assets/brand/` holds
the Chrome and Firefox logos used inside the store buttons, with their sources
in `NOTICE.txt`. `assets/og-card.png` is the 1200 × 630 social preview image,
drawn by `npm run store:assets` together with the store art.

## Deploying

Cloudflare serves this folder at `slowedreverbapp.com`, connected to this
repository. `wrangler.jsonc` in the repository root is the whole
configuration: no build step, no Worker script. Wrangler runs in Cloudflare's
build container, so it is not a dependency here.

- Cloudflare redeploys on every push to `main` and gives other branches a
  preview URL.
- Pages are served without `.html` (`/guide`, `/privacy`). The canonical and
  Open Graph URLs in each page's `<head>` and `sitemap.xml` use those addresses;
  they are the only places the domain is written out.
- Unknown addresses get `404.html` with a 404 status. That page can be served
  at any depth, so its links start with `/`.
- `.assetsignore` keeps this README off the website.
- Links use the clean addresses directly, so a click never waits on a redirect.
- `_headers` sets caching. The stylesheet and scripts are kept for a year,
  which is safe only because every page links to them with a version stamp
  (`styles.css?v=…`, a hash of the file): a changed file gets a new address.
  After editing any of them, run `npm run site:stamp`; `tests/site.test.js`
  fails while a stamp is out of date, and also fails if `_headers` gives the
  long cache to a file without a stamp. The font, audio and images are kept for
  a week. Pages and the popup copy keep Cloudflare's default and are checked on
  every visit, so content changes show up immediately.
- Each page has a speculation rule that fetches a page's HTML when the visitor
  hovers over a link to it, so clicks feel instant in Chromium browsers. It
  prefetches only; nothing on the next page runs until the visitor opens it.
  Other browsers ignore it.

Both store dashboards should list `https://slowedreverbapp.com` as the homepage
and `https://slowedreverbapp.com/privacy` as the privacy policy.

## Writing for the site

- Write for listeners, not developers. Plain words, "you", and contractions.
  Permission names and other codebase terms belong in the repository docs or
  in the technical section of the privacy page.
- American spelling.
- No slogans. A heading says what the section is about.
- The privacy page must keep every fact in `PRIVACY.md`.
- Show the real interface. The popup on the page is the shipping popup, not a
  picture of it.
- Nothing is loaded from another website.
