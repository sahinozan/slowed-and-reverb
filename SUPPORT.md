# Slowed & Reverb Support

Slowed & Reverb `1.0.0` supports desktop Chromium-based browsers and Firefox 142+
on:

- YouTube;
- YouTube Music; and
- the Spotify web player after optional Spotify access is granted.

Other websites, including Twitch and SoundCloud, are not supported in `1.0.0`.

## Before reporting a problem

1. Confirm that the toolbar waveform is pink while audio is playing. A gray icon
   means processing is off, unavailable, or still waiting for the supported player.
2. Reload the supported page once.
3. For Spotify, confirm that optional access to `open.spotify.com` is enabled in
   the browser's extension settings.
4. For Firefox on YouTube or YouTube Music, confirm that optional access to the
   current site is enabled.
5. Test with other audio extensions disabled so two extensions are not competing
   for the same media element.

## Request support

Search the [existing issues](https://github.com/sahinozan/slowed-and-reverb/issues)
and open a new issue if the problem has not been reported. Include:

- the browser name and full version;
- the operating system;
- whether the site was YouTube, YouTube Music, or Spotify;
- the shortest sequence that reproduces the problem; and
- any warning shown in the extension popup.

Do not post account credentials, authentication tokens, private library details,
or other sensitive information. Screenshots should have account names and private
content removed.

For a private support or privacy question, email
[slowedandreverbsupport@proton.me](mailto:slowedandreverbsupport@proton.me).
Do not send passwords or authentication tokens by email.

## Known limitations

- YouTube live streams support audio filters but not playback-speed changes.
- A newly opened tab starts with effects off because settings are tab-scoped.
- Embedded media inside inaccessible frames or shadow roots may not be processed.
- Firefox Android, Twitch, SoundCloud, and other music services are not supported
  in `1.0.0`.

For information about local processing and permissions, read the
[privacy policy](PRIVACY.md).
