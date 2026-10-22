'use strict';

// The audible defects this project has fixed, put back into disposable
// copies of the build for the audio regression suite's controls (README.md
// in this folder). Each control runs the check that should catch its
// defect and must fail with the problems listed, and with no problem of
// the clock or the recorder, so the check is shown to hear the defect and
// not to fail for some other reason.
//
// The engines have changed since, and the old files don't run with today's
// content scripts (they report no version, so today's extension keeps them
// off), so most defects are put back narrowly in today's code:
//   exact: the old lines themselves, in place of the lines that fixed them;
//   narrow: today's code changed to behave as the old code did, in the
//     way that was heard;
//   surrogate: a change that causes the same symptom by a different route,
//     because the old route no longer exists.
// `browsers` lists where the defect was heard; a control runs only there.
// `expect` lists the problems it must cause ({ code, during }: the problem's
// message names the action or steady stretch where it was heard).

const both = ['chromium', 'firefox'];

// Today's engines, changed to set every value straight away and change the
// player at once, as before 02ef174.
function straightChanges(file, smoothTo, now) {
  return [
    {
      file,
      find: `function smoothTo(${smoothTo}) {`,
      replace: `function smoothTo(${smoothTo}) {\n    param.cancelScheduledValues(0);\n    param.setValueAtTime(value, ${now});\n    return;`,
      label: 'every setting jumps straight to its new value'
    },
    {
      file,
      find: 'function playbackClicks(media, speed, keepPitch) {',
      replace: 'function playbackClicks(media, speed, keepPitch) {\n    return false;',
      label: 'the player changes at once, without fading the output out'
    },
    {
      file,
      find: 'const CAPTURE_SILENCE_SECONDS = FIREFOX ? 0.25 : 0;',
      replace: 'const CAPTURE_SILENCE_SECONDS = 0;',
      label: 'no silence while a player is first routed in'
    }
  ];
}

function startFromNow(file) {
  return {
    file,
    find: 'const value = pathValue(path, start);\n    param.cancelScheduledValues(start);\n    param.linearRampToValueAtTime(value, start);',
    replace: 'const value = param.value;\n    param.cancelScheduledValues(start);\n    param.setValueAtTime(value, start);',
    label: "a change starts from the setting's value now, as before 3fbb1c3"
  };
}

const HISTORY = [
  {
    id: '02ef174',
    commit: '02ef174',
    defect: 'Clicks when the effect or its settings change: values set straight away, and the player changed while it could be heard',
    kind: 'narrow',
    browsers: both,
    check: 'transitions',
    mutations: [
      ...straightChanges('youtube-main.js', 'param, value', 'audioContext.currentTime'),
      ...straightChanges('spotify-main.js', 'context, param, value', 'context.currentTime')
    ],
    expect: [
      { code: 'click', during: 'during pan to the middle' },
      { code: 'click', during: 'during keep the pitch' }
    ]
  },
  {
    id: '3fbb1c3',
    commit: '3fbb1c3',
    defect: 'Jumps when changes overlap: a change started from where the setting was 20 ms before it began',
    kind: 'exact',
    note: 'The first of its two fixes; the silence deadline it also fixed is left as it is today.',
    browsers: both,
    check: 'overlapping changes',
    mutations: [startFromNow('youtube-main.js'), startFromNow('spotify-main.js')],
    expect: [{ code: 'click', during: 'during overlapping changes' }]
  },
  {
    id: '74032cc',
    commit: '74032cc',
    defect: "Spotify skipped every 12 to 13 s in Firefox: its own speed resets were undone by a change the engine hid with silence",
    kind: 'narrow',
    note: "Spotify's speed writes go to the player again; the engine then puts its speed back on every ratechange, as before.",
    browsers: ['firefox'],
    check: "Spotify's speed resets",
    mutations: [
      {
        file: 'spotify-main.js',
        find: 'function keepSpotifyRates(media) {',
        replace: 'function keepSpotifyRates(media) {\n    return;',
        label: "Spotify's speed writes reach the player"
      }
    ],
    expect: [{ code: 'gap', during: 'during Spotify resets the speed three times' }]
  },
  {
    id: '9cde26c',
    commit: '9cde26c',
    defect: 'The Spotify player stayed stopped when Spotify asked for normal speed while a change of the effect was waiting',
    kind: 'exact',
    browsers: both,
    check: 'a speed request during a waiting change',
    mutations: [
      {
        file: 'spotify-main.js',
        find: '        if (pipelines.get(this)?.pendingPlayback) {\n          applySettings(this);\n          return;\n        }',
        replace: '        if (rate !== 0 && pipelines.get(this)?.pendingPlayback) return;',
        label: 'a waiting change keeps the speed it planned, as before 9cde26c'
      }
    ],
    expect: [
      { code: 'gap', during: 'during turn off while Spotify holds the player' },
      { code: 'media-rate', during: 'off:' }
    ]
  },
  {
    id: '134e1c0',
    commit: '134e1c0',
    defect: "The effects kept playing after the extension was turned off in Chromium's extensions page",
    kind: 'surrogate',
    note: "Before 134e1c0 nothing noticed the extension was gone. Today the engines ask the isolated scripts, which Chromium leaves running; here those keep answering as if it were still on.",
    browsers: ['chromium'],
    check: 'turning the extension off',
    mutations: [
      {
        file: 'content.js',
        find: 'if (extensionRunning()) event.preventDefault();',
        replace: 'event.preventDefault();',
        label: 'answers for the extension after it is gone'
      },
      {
        file: 'spotify-bridge.js',
        find: 'if (api.runtime?.id) event.preventDefault();',
        replace: 'event.preventDefault();',
        label: 'answers for the extension after it is gone'
      }
    ],
    expect: [{ code: 'not-restored', during: 'turn the extension off' }]
  },
  {
    id: '1127987',
    commit: '1127987',
    defect: "Spotify's effects kept playing after Firefox turned the extension off, since Firefox removes the bridge that should have turned them off",
    kind: 'surrogate',
    note: "Before 1127987 the bridge turned the engine off itself, which Firefox's removal of the bridge prevented. Here the engine stops checking for its bridge, which has the same result.",
    browsers: ['firefox'],
    check: 'turning the extension off',
    mutations: [
      {
        file: 'spotify-main.js',
        find: 'function bridgeAnswers() {',
        replace: 'function bridgeAnswers() {\n    return true;',
        label: 'the engine never notices its bridge is gone'
      }
    ],
    expect: [{ code: 'not-restored', during: 'turn the extension off' }]
  },
  {
    id: '9a900c4-stranded',
    commit: '9a900c4',
    defect: 'After the extension was turned off, a captured YouTube player that the page took out and put back stayed silent',
    kind: 'narrow',
    browsers: both,
    check: 'turning the extension off',
    mutations: [
      {
        file: 'youtube-main.js',
        find: '    if (!bridgeConnected) {\n      if (pipeline && connectPipeline(media, pipeline)) {',
        replace: '    if (!bridgeConnected) {\n      if (pipeline?.connected) {',
        label: 'without the extension, a player taken out of the page is not connected again'
      }
    ],
    expect: [{ code: 'gap', during: 'during the page takes its player out' }]
  },
  {
    id: '9a900c4-speed',
    commit: '9a900c4',
    defect: "After the extension was turned off, the engine still reset YouTube's own speed to 1x whenever a player started",
    kind: 'narrow',
    browsers: both,
    check: 'turning the extension off',
    mutations: [
      {
        file: 'youtube-main.js',
        find: '    if (!bridgeConnected) {\n      if (pipeline && connectPipeline(media, pipeline)) {',
        replace:
          '    if (!bridgeConnected) {\n      setPlayback(media, NEUTRAL_SETTINGS.speed, NEUTRAL_SETTINGS.keepPitch);\n      if (pipeline && connectPipeline(media, pipeline)) {',
        label: 'without the extension, a starting player is set back to normal speed'
      }
    ],
    expect: [{ code: 'tone-missing', during: 'put back at 1.25x:' }]
  },
  {
    id: '0cad7f4',
    commit: '0cad7f4',
    defect: "After an update, the new YouTube scripts used the previous version's engine still in the page",
    kind: 'narrow',
    browsers: both,
    check: 'an update',
    mutations: [
      {
        file: 'content.js',
        find: 'if (event.data.version !== VERSION) engineOutdated = true;',
        replace: '',
        label: 'any engine is accepted, whatever its version'
      }
    ],
    expect: [
      { code: 'old-engine-ran', during: "the previous version's engine was used" },
      { code: 'tone-missing', during: 'kept off until a reload:' }
    ]
  },
  {
    id: '4565b80',
    commit: '4565b80',
    defect: "After an update and turning the extension off and on, Firefox's new Spotify bridge used the previous version's engine",
    kind: 'narrow',
    browsers: ['firefox'],
    check: 'an update',
    mutations: [
      {
        file: 'spotify-bridge.js',
        find: 'if (event.data.version !== VERSION) engineOutdated = true;',
        replace: '',
        label: 'any engine is accepted, whatever its version'
      }
    ],
    expect: [
      { code: 'old-engine-ran', during: "the previous version's engine was used" },
      { code: 'tone-missing', during: 'kept off until a reload:' }
    ]
  }
];

module.exports = { HISTORY };
