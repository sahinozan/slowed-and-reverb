---
name: popup-change
description: Steps for changing the extension's popup (extension/popup.html, extension/popup.css, extension/popup.js) or the settings it shows (extension/settings.js). Covers the website's copy, the layout tests and their states, rendering the popup to look at it, and the checks by hand a popup change can need. Use when adding or changing a control, a setting, a notice, a panel, a theme, the popup's text or its styles.
---

# Changing the popup

The popup's source is `extension/popup.html`, `extension/popup.css` and
`extension/popup.js`. The rules for its words, for settings and for privacy
are in `AGENTS.md` ("Rules"). These are the steps around a change.

1. **Change the source, never the copies.** `site/popup/` holds the
   website's copy of the popup and of `extension/settings.js`, and `dist/`
   the builds. The mark in the popup's header, between `<!-- icon:start -->`
   and `<!-- icon:end -->`, is made by `npm run icons` from
   `scripts/render-icons.js`.
2. **Copy the popup into the website:** `npm run site:popup`. Where the
   agents' hooks are loaded, one runs it after each edit to the popup's
   files or to `extension/settings.js` and says which files it changed;
   `AGENTS.md` ("Generated files") says where that is, which for Claude
   Code is only a session started at the checkout's root. Run it yourself
   when no hook said so, or after a change made any other way. Commit
   `site/popup/` with the source. The tests fail while the copy is out of
   date.
3. **A new setting** goes in `extension/settings.js`; in the copies of the
   defaults and ranges in `extension/youtube-main.js` and
   `extension/spotify-main.js`, and of the defaults in
   `extension/spotify-bridge.js` (a test keeps the copies equal); in the
   popup's controls; and in the audio graphs of both engines.
4. **A new state that changes the layout** (a notice, a panel, a tab, a long
   name) gets an entry in `STATES` in `e2e/ui/popup-layout.spec.js`. A
   layout defect you fix gets a control there, so the test fails when the
   defect is put back.
5. **Look at it.** `npm run test:ui` renders the popup in each state in
   Chromium and in the installed Firefox's engine and checks that it fits
   340px wide without scrolling, with every control on screen.
   `npm run test:e2e` checks the installed extension's popup in Chromium and
   saves a screenshot in its report. For a state the tests don't have yet,
   render the popup with the helpers in `scripts/popup-preview.js`, as the
   tests and the store-art script do.
6. **See what else the change needs:** `npm run checks:for`. For the popup
   it can list checks done by hand:
   - `firefox-frame-look`, when the popup's frame changed in CSS. The tests
     render a page, not the browser's popup window, so Firefox's rounded
     panel corners (the `@supports (-moz-appearance: none)` rule in
     `extension/popup.css`) aren't drawn.
   - `listen`, when what the popup sends to the tab, or how often, changed.
   - `permission-steps`, when how the popup asks for access changed.
   Say in the pull request which of them apply and who did them.
7. **If the popup looks different**, the store's screenshots show the old
   one. Tell the owner; making them again is the `store-assets` skill.
8. **Run `npm run check`** before handing the work back.
