'use strict';

// The owned test signals and the local pages of the audio capture trial
// (README.md in this folder). Nothing here is loaded from other websites.

const fs = require('fs');
const http = require('http');
const path = require('path');

// A stereo WAV with a different tone in each channel, so the recording can
// tell the channels apart. Each tone fits a whole number of cycles in the
// file, so the file loops without a jump.
const TONE = Object.freeze({
  sampleRate: 48_000,
  seconds: 6,
  amplitude: 0.25,
  leftHz: 440,
  rightHz: 660
});

function createStereoToneWav({ sampleRate, seconds, amplitude, leftHz, rightHz } = TONE) {
  const frames = sampleRate * seconds;
  const channels = 2;
  const dataLength = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataLength);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLength, 40);

  for (let frame = 0; frame < frames; frame++) {
    const time = frame / sampleRate;
    const left = Math.sin(2 * Math.PI * leftHz * time) * amplitude;
    const right = Math.sin(2 * Math.PI * rightHz * time) * amplitude;
    wav.writeInt16LE(Math.round(left * 32_767), 44 + frame * 4);
    wav.writeInt16LE(Math.round(right * 32_767), 46 + frame * 4);
  }

  return wav;
}

// A short 16-bit stereo WAV of recorded samples, kept as evidence.
function encodeWav(left, right, sampleRate) {
  const frames = left.length;
  const dataLength = frames * 4;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLength, 40);
  const clamp = (value) => Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  for (let frame = 0; frame < frames; frame++) {
    wav.writeInt16LE(Math.round(clamp(left[frame]) * 32_767), 44 + frame * 4);
    wav.writeInt16LE(Math.round(clamp(right[frame]) * 32_767), 46 + frame * 4);
  }
  return wav;
}

// The player is unmuted and starts only from a click on Start, the way a
// person starts a song. Activate is a click that plays nothing, for the
// checks that build their own graphs. The page records whether each click
// was trusted.
const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Audio capture trial</title></head>
  <body>
    <h1>Audio capture trial</h1>
    <button id="start" type="button">Start</button>
    <button id="activate" type="button">Activate</button>
    <audio id="player" preload="auto" loop src="/tone.wav"></audio>
    <script>
      window.startClicks = [];
      function recordClick(event, play) {
        const click = {
          button: event.target.id,
          isTrusted: event.isTrusted,
          hasBeenActive: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
          play: play ? 'pending' : 'none'
        };
        window.startClicks.push(click);
        return click;
      }
      document.getElementById('start').addEventListener('click', (event) => {
        const click = recordClick(event, true);
        document.getElementById('player').play().then(
          () => { click.play = 'playing'; },
          (error) => { click.play = 'rejected: ' + error.name + ': ' + error.message; }
        );
      });
      document.getElementById('activate').addEventListener('click', (event) => recordClick(event, false));
    </script>
  </body>
</html>`;

const WORKLET_PATH = '/audio-trial-recorder.js';

// Serves the trial page, the tone and the recorder worklet. The same server
// answers as 127.0.0.1 (the YouTube stand-in) and as localhost (the Spotify
// stand-in), so each engine is reached by its own host in the extension copy.
async function startTrialServer() {
  const tone = createStereoToneWav();
  const worklet = fs.readFileSync(path.join(__dirname, 'recorder-worklet.js'));
  const routes = new Map([
    ['/', ['text/html; charset=utf-8', Buffer.from(PAGE_HTML)]],
    ['/tone.wav', ['audio/wav', tone]],
    [WORKLET_PATH, ['text/javascript; charset=utf-8', worklet]]
  ]);

  const server = http.createServer((request, response) => {
    const route = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    const [type, body] = route;
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
      'Content-Type': type
    });
    response.end(body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    youtubeUrl: `http://127.0.0.1:${port}/`,
    spotifyUrl: `http://localhost:${port}/`,
    workletPath: WORKLET_PATH,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  };
}

module.exports = { TONE, createStereoToneWav, encodeWav, startTrialServer };
