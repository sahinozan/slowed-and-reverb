# Store listing text

The text for the Chrome Web Store and Firefox Add-ons listings, kept here so
changes are reviewed like any other change. Same voice as the website: plain
words, American spelling, no slogans.

Search notes, checked October 2026:

- Both stores search the name, summary and description. On Firefox a word in
  the name counts about 6 to 8 times, in the summary 3 and in the description 2.
  Chrome doesn't publish its weights and ranks mostly by users and ratings.
- Chrome treats a word used more than five times as keyword spam. Keep
  "YouTube" and "Spotify" to four each in the description, counting the
  trademark line.
- Pitch follows speed, so don't call it a pitch changer. Don't use "bass boost",
  "8D", "lofi" or "download": the extension doesn't do those.

## Name

Slowed & Reverb

## Summary

Chrome reads it from `description` in `extension/manifest.json` (132
characters at most), so it changes only with a release. Firefox's is edited in
the Developer Hub (250 at most).

Chrome:

```text
Slowed + Reverb and Nightcore for YouTube™, YouTube Music™ and Spotify. Change the speed, reverb, bass and more. Free and private.
```

Firefox:

```text
Slowed + Reverb, Nightcore and other audio effects for YouTube, YouTube Music and Spotify. Slow a song down or speed it up, pitch and all, and change the reverb, bass, treble, echo and stereo width while it plays. Free and private.
```

## Description

Chrome takes plain text. Paste as is.

```text
Slow down the song you're playing and add reverb with one click, or speed it up for Nightcore. It works on YouTube™, YouTube Music™ and the Spotify web player, and it changes the song while it plays, so there's nothing to download or convert.

It's free, with no paid version and no account to make. It doesn't collect anything about you or what you listen to, and it doesn't show ads. The code is public on GitHub.

Click the extension's icon while a song plays and Slowed + Reverb turns on right away. Nightcore is right next to it, and you can change everything yourself:

• Speed, from half speed to one and a half times. The pitch goes down and up with it, like a tape. If you only want the speed to change, turn on Keep Original Pitch.
• Reverb
• A three-band equalizer: Bass, Mid and Treble
• Echo, stereo width, pan and saturation on the Advanced tab
• My Presets, to save the settings you like and switch back with one click
• Keyboard shortcuts, once you choose the keys
• Four color themes for the panel

Each tab has its own setting. A new tab starts with the effect off, and a tab keeps its setting when you reload it.

The first time you use it on Spotify, the panel asks you to allow it. Click Allow, accept your browser's question, and the page reloads once. After that it works the same as everywhere else.

Why I made it
The slowed + reverb extensions I tried were closed source and kept their best features behind a subscription. I wanted one I could trust and just use.

Good to know
• It works on computers in Chrome, Edge, Brave and other Chrome-based browsers.
• It doesn't work in desktop or phone apps, or on other sites.
• It can't download or save the slowed version.
• On live streams the speed can't change, but the other effects still work.

Help: https://slowedreverbapp.com/faq
Privacy policy: https://slowedreverbapp.com/privacy

YouTube and YouTube Music are trademarks of Google LLC, and Spotify is a trademark of Spotify AB. This extension is made independently and isn't affiliated with, endorsed by or sponsored by either company.
```

Firefox accepts a few HTML tags (`<b>`, `<ul>`, `<li>`, `<a>`) and ignores
Markdown, so its copy uses them. It adds the sentence about Firefox's YouTube
permission and its own browser line.

```html
Slow down the song you're playing and add reverb with one click, or speed it up for Nightcore. It works on YouTube™, YouTube Music™ and the Spotify web player, and it changes the song while it plays, so there's nothing to download or convert.

It's free, with no paid version and no account to make. It doesn't collect anything about you or what you listen to, and it doesn't show ads. The code is public on GitHub.

Click the extension's icon while a song plays and Slowed + Reverb turns on right away. Nightcore is right next to it, and you can change everything yourself:
<ul><li>Speed, from half speed to one and a half times. The pitch goes down and up with it, like a tape. If you only want the speed to change, turn on Keep Original Pitch.</li><li>Reverb</li><li>A three-band equalizer: Bass, Mid and Treble</li><li>Echo, stereo width, pan and saturation on the Advanced tab</li><li>My Presets, to save the settings you like and switch back with one click</li><li>Keyboard shortcuts, once you choose the keys</li><li>Four color themes for the panel</li></ul>
Each tab has its own setting. A new tab starts with the effect off, and a tab keeps its setting when you reload it.

The first time you use it on Spotify, the panel asks you to allow it. Click Allow, accept your browser's question, and the page reloads once. After that it works the same as everywhere else. In Firefox, the other two sites ask the same way once, so the effect can come back after you reload the page.

<b>Why I made it</b>
The slowed + reverb extensions I tried were closed source and kept their best features behind a subscription. I wanted one I could trust and just use.

<b>Good to know</b>
<ul><li>It works in Firefox 142 or newer on a computer, not on Android yet.</li><li>It doesn't work in desktop or phone apps, or on other sites.</li><li>It can't download or save the slowed version.</li><li>On live streams the speed can't change, but the other effects still work.</li></ul>
Help: <a href="https://slowedreverbapp.com/faq">slowedreverbapp.com/faq</a>
Privacy policy: <a href="https://slowedreverbapp.com/privacy">slowedreverbapp.com/privacy</a>

YouTube and YouTube Music are trademarks of Google LLC, and Spotify is a trademark of Spotify AB. This extension is made independently and isn't affiliated with, endorsed by or sponsored by either company.
```

## Screenshot captions

Firefox only; Chrome doesn't show captions. In upload order:

1. The panel on YouTube, opened from the extension's icon.
2. On Spotify, click Allow once. The page reloads and it's ready.
3. Echo, stereo width, pan and saturation on the Advanced tab.
4. Save your favorite settings under My Presets, and pick one of four color themes.
5. Everything happens in your browser. Nothing about you is collected.
