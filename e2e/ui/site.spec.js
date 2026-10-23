'use strict';

// The website as it is in site/, served by scripts/serve-site.js the way
// Cloudflare serves it, in Chromium and in Firefox. The home and guide pages
// run the real popup (site/popup/, a copy of extension/popup.*) in a frame,
// and the demo plays the song in site/assets/audio/ through site/demo-audio.js.
//
// Every request the pages make, WebSockets included, is checked: one to
// anywhere but the local server fails the test, and is stopped before it
// leaves the browser. So do the page's errors, console errors and failed
// local requests. No store, YouTube or Spotify page is opened. The browsers
// are muted: playing is checked by the song's clock and the page, not by its
// sound, and it needs a sound device (on Linux, a PulseAudio sink; CI starts a
// null sink). Each playing test attaches what the demo's audio did, step by
// step (demo-playback.json), so a song that doesn't start shows where it stopped.

const http = require('node:http');
const { expect, test: base } = require('@playwright/test');

const { createSiteServer } = require('../../scripts/serve-site');

const PAGES = ['/', '/guide', '/faq', '/changelog', '/privacy'];
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  // Narrower than the popup plus the page's margins, so the home page scales it down.
  phone: { width: 360, height: 780 },
  // The narrowest phones in use; the support address is wider than this
  // column in most fonts, so it has to wrap.
  'small phone': { width: 320, height: 640 }
};

// The tests that need Firefox to play sound through a device. CI's Windows
// runners have none, so there they run in Chromium alone (see
// playwright.ui.config.js); everywhere else they run in both engines.
const PLAYBACK = '@playback';

const test = base.extend({
  siteUrl: [
    async ({}, use) => {
      const server = createSiteServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      await use(`http://127.0.0.1:${server.address().port}`);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
    { scope: 'worker' }
  ],

  // Blocks and records every request that isn't to the local server, and
  // records the pages' errors, console errors and failed local requests. Any
  // of them fails the test, unless the test takes them with `guard.take()`.
  // WebSockets need a route of their own: Chromium's don't pass through
  // context.route. Playwright routes those opened from pages and their frames,
  // not from workers; the site has neither.
  guard: [
    async ({ context, page, siteUrl }, use, testInfo) => {
      const { host, origin } = new URL(siteUrl);
      const requests = [];
      const outside = [];
      let problems = [];
      const where = (frame) => (frame ? frame.url() : 'a worker');

      await context.route('**/*', (route) => {
        const request = route.request();
        if (new URL(request.url()).origin === origin) return route.continue();
        outside.push(request.url());
        problems.push(`request to another site, stopped: ${request.method()} ${request.url()} (${request.resourceType()}, from ${where(request.frame())})`);
        return route.abort('blockedbyclient');
      });
      await context.routeWebSocket(() => true, (socket) => {
        if (new URL(socket.url()).host === host) {
          socket.connectToServer();
          return;
        }
        outside.push(socket.url());
        problems.push(`request to another site, stopped: WebSocket ${socket.url()}`);
        socket.close({ code: 1008, reason: 'Blocked by the test' });
      });
      page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
      });
      page.on('requestfailed', (request) => {
        if (outside.includes(request.url())) return;
        problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
      });
      page.on('response', (response) => {
        if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
      });

      await use({
        take() {
          const taken = problems;
          problems = [];
          return taken;
        }
      });

      await testInfo.attach('requests.txt', { body: requests.join('\n'), contentType: 'text/plain' });
      expect(problems, 'requests to other sites and browser errors').toEqual([]);
    },
    { auto: true }
  ]
});

// Records, without changing it, each step the demo takes to play (site/demo-audio.js):
// fetching the song, decoding it, resuming the audio context and starting the
// <audio> element, with when each started and how it ended, and the elements
// and contexts themselves, so a test can read the song's clock and speed and
// a failure can say which step never finished.
function recordPlayback() {
  const steps = [];
  const contexts = [];
  const played = [];
  window.__playback = { steps, contexts, played };
  const now = () => Math.round(performance.now());
  const describe = (reason) => (reason ? `${reason.name}: ${reason.message}` : String(reason));
  const track = (step, detail, promise) => {
    const entry = { step, detail, started: now(), ended: null, outcome: 'pending' };
    steps.push(entry);
    promise.then(
      (value) => Object.assign(entry, { ended: now(), outcome: 'resolved', value: typeof value === 'object' && value && 'status' in value ? `HTTP ${value.status}` : undefined }),
      (reason) => Object.assign(entry, { ended: now(), outcome: 'rejected', value: describe(reason) })
    );
    return promise;
  };
  const watch = (context) => {
    if (!contexts.includes(context)) contexts.push(context);
  };

  const fetch = window.fetch;
  window.fetch = function (input, ...rest) {
    const url = String(input instanceof Request ? input.url : input);
    const result = fetch.call(this, input, ...rest);
    return url.endsWith('.mp3') ? track('fetch the song', url, result) : result;
  };
  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (...args) {
    return track('decode the song', this.constructor.name, decode.apply(this, args));
  };
  const resume = AudioContext.prototype.resume;
  AudioContext.prototype.resume = function () {
    watch(this);
    return track('resume the audio context', `was ${this.state}`, resume.call(this));
  };
  const source = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (...args) {
    watch(this);
    return source.apply(this, args);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!played.includes(this)) played.push(this);
    return track('start the <audio> element', `readyState ${this.readyState}`, play.call(this));
  };
}

// What the demo's audio is doing: every step, the ones still waiting, the
// audio contexts' state and clocks, the <audio> elements and the demo's own state.
const playbackReport = (page) => page.evaluate(() => {
  const record = window.__playback;
  if (!record) return { recorded: false };
  const at = Math.round(performance.now());
  return {
    recorded: true,
    at,
    steps: record.steps.map((step) => ({ ...step, waited: step.ended === null ? at - step.started : undefined })),
    waitingFor: record.steps.filter((step) => step.outcome === 'pending').map((step) => step.step),
    contexts: record.contexts.map((context) => ({
      state: context.state,
      currentTime: context.currentTime,
      sampleRate: context.sampleRate,
      baseLatency: context.baseLatency,
      outputLatency: context.outputLatency
    })),
    media: record.played.map((element) => ({
      currentTime: element.currentTime,
      paused: element.paused,
      playbackRate: element.playbackRate,
      readyState: element.readyState,
      networkState: element.networkState,
      error: element.error && `${element.error.code} ${element.error.message}`
    })),
    demo: window.SRDemo ? { ...window.SRDemo.state, settings: undefined } : null
  };
});

// One line for an error message: where the demo's playing stopped.
function summarize(report) {
  if (!report.recorded) return 'nothing recorded';
  const parts = [];
  if (report.waitingFor.length) parts.push(`still waiting to ${report.waitingFor.join(', ')}`);
  for (const step of report.steps.filter((entry) => entry.outcome === 'rejected')) parts.push(`${step.step}: ${step.value}`);
  if (!report.steps.length) parts.push('no step started');
  for (const [i, context] of report.contexts.entries()) {
    parts.push(`context ${i + 1} ${context.state} at ${context.currentTime.toFixed(3)}s`);
  }
  for (const [i, element] of report.media.entries()) {
    parts.push(`<audio> ${i + 1} ${element.paused ? 'paused' : 'playing'} at ${element.currentTime.toFixed(3)}s, readyState ${element.readyState}${element.error ? `, error ${element.error}` : ''}`);
  }
  if (report.demo) parts.push(`demo ${JSON.stringify(report.demo)}`);
  return parts.join('; ');
}

const media = (page) => page.evaluate(() => {
  const [element] = window.__playback.played;
  return element
    ? { time: element.currentTime, rate: element.playbackRate, paused: element.paused }
    : null;
});

const popupFrame = (page) => page.frameLocator('#popup');

// A mouse click at the middle of a popup control, where the page draws it:
// the popup's frame may be scaled down to fit a narrow column.
async function clickInPopup(page, selector) {
  await page.locator('#popup').scrollIntoViewIfNeeded();
  const point = await page.evaluate((target) => {
    const frame = document.getElementById('popup');
    const outer = frame.getBoundingClientRect();
    const scale = outer.width / frame.offsetWidth;
    const inner = frame.contentDocument.querySelector(target).getBoundingClientRect();
    return {
      x: outer.left + (inner.left + inner.width / 2) * scale,
      y: outer.top + (inner.top + inner.height / 2) * scale
    };
  }, selector);
  await page.mouse.click(point.x, point.y);
}

async function openHome(page, siteUrl) {
  await page.addInitScript(recordPlayback);
  await page.goto(`${siteUrl}/`);
  // The popup has finished its first sync, and the page has heard from it.
  await expect(popupFrame(page).locator('body')).not.toHaveClass(/booting/);
  await expect(popupFrame(page).locator('#current-preset-label')).toHaveText('Current Preset: Slowed + Reverb');
  await expect(page.locator('#speed-out')).toHaveText('0.80×');
}

// Presses play and checks that the song's clock moves. Whatever happens, it
// attaches what the demo's audio did; on a failure, the error says where it stopped.
async function expectDemoPlays(page, { timeout = 10_000, name = 'demo-playback.json' } = {}) {
  const testInfo = test.info();
  let failure = null;
  try {
    await page.locator('#play').click();
    await expect(page.locator('#play'), 'the play button shows playing').toHaveAttribute('aria-pressed', 'true', { timeout });
    const start = (await media(page))?.time ?? 0;
    await expect
      .poll(async () => (await media(page))?.time ?? 0, { message: "the song's clock moves", timeout })
      .toBeGreaterThan(start + 0.25);
  } catch (error) {
    failure = error;
  }
  const report = await playbackReport(page);
  await testInfo.attach(name, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  if (failure) {
    failure.message = `${failure.message}\n\nThe demo's audio: ${summarize(report)}`;
    failure.playback = report;
    throw failure;
  }
  return report;
}

// Picks Nightcore in the popup and checks that the demo follows.
async function expectPopupDrivesDemo(page, { timeout = 5_000 } = {}) {
  await popupFrame(page).locator('[data-preset="nightcore"]').click();
  await expect(page.locator('#speed-out')).toHaveText('1.20×', { timeout });
  await expect(page.locator('#label-speed')).toHaveText('speed 1.20×', { timeout });
  await expect.poll(async () => (await media(page))?.rate, { timeout }).toBe(1.2);
}

test(`the demo plays and pauses, and follows the popup both ways ${PLAYBACK}`, async ({ page, siteUrl }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openHome(page, siteUrl);

  await expectDemoPlays(page);
  expect((await media(page)).rate).toBe(0.8);
  // The reels turn while it plays.
  const reel = () => page.locator('#reel-left').getAttribute('transform');
  const angle = await reel();
  await expect.poll(reel).not.toBe(angle);

  // The popup drives the demo...
  await expectPopupDrivesDemo(page);

  // ...and the page's fader drives the popup, which drives the demo.
  await page.locator('#speed').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(popupFrame(page).locator('#speed-slider')).toHaveValue('1.1');
  await expect(popupFrame(page).locator('#speed-value')).toHaveText('(1.10x)');
  await expect(page.locator('#speed-out')).toHaveText('1.10×');
  await expect.poll(async () => (await media(page)).rate).toBe(1.1);

  // Turning the effect off in the popup plays the song as it is.
  await popupFrame(page).locator('.header-power .switch-slider').click();
  await expect(popupFrame(page).locator('#power-status')).toHaveText('Off');
  await expect(page.locator('#speed-out')).toHaveText('1.00×');
  await expect.poll(async () => (await media(page)).rate).toBe(1);

  await page.locator('#play').click();
  await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await media(page)).paused).toBe(true);
  const stopped = (await media(page)).time;
  await page.waitForTimeout(300);
  expect((await media(page)).time).toBe(stopped);
  await expect(page.locator('#play-error')).toBeHidden();
});

test("the popup's theme colors the page and the next page", async ({ page, siteUrl }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await openHome(page, siteUrl);

  await popupFrame(page).locator('#theme-picker-btn').click();
  await popupFrame(page).locator('.theme-option[data-theme="midnight"]').click();
  await expect(popupFrame(page).locator('html')).toHaveAttribute('data-theme', 'midnight');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');

  await page.locator('.real a[href="/guide"]').click();
  await expect(page).toHaveURL(`${siteUrl}/guide`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
  await expect(popupFrame(page).locator('body')).not.toHaveClass(/booting/);
  await expect(popupFrame(page).locator('html')).toHaveAttribute('data-theme', 'midnight');

  // The guide's popup switches to the tab of the section being read.
  await page.locator('.guide-text section[data-tab="advanced"]').scrollIntoViewIfNeeded();
  await expect(popupFrame(page).locator('#effect-tab-advanced')).toHaveAttribute('aria-selected', 'true');
  await expect(popupFrame(page).locator('#effect-panel-advanced')).toBeVisible();
});

// Where the home page's popup frame and its box are, and how tall the popup
// inside is. `reserved` is the frame's height attribute: the room the page
// keeps for the popup before it reports its height.
const homeLayout = (page) => page.evaluate(() => {
  const frame = document.getElementById('popup');
  const box = frame.parentElement;
  const column = box.parentElement;
  const rect = (element) => {
    const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
    return { left, right, top, bottom, width, height };
  };
  return {
    reserved: Number(frame.getAttribute('height')),
    popupHeight: Math.ceil(frame.contentDocument.body.getBoundingClientRect().height),
    frameHeight: parseFloat(frame.style.height),
    frame: rect(frame),
    box: rect(box),
    column: rect(column),
    columnWidth: column.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    windowWidth: document.documentElement.clientWidth
  };
});

const scaleOf = ({ columnWidth }) => Math.min(1, columnWidth / 340);

// The frame is as tall as the popup, drawn at the column's scale. It eases
// to a new height (styles.css), so wait for it to land.
async function settledHome(page) {
  await expect.poll(async () => {
    const now = await homeLayout(page);
    return {
      heightSet: now.frameHeight - now.popupHeight,
      drawnAtScale: Math.abs(now.frame.height - now.popupHeight * scaleOf(now)) < 0.5
    };
  }, { message: "the frame takes the popup's height" }).toEqual({ heightSet: 0, drawnAtScale: true });
  return homeLayout(page);
}

// The box keeps the tallest height so far, starting from the room the page
// reserved, so the page around it doesn't move; and it holds the whole frame.
function expectBoxHolds(now, tallest, scale) {
  expect(now.box.width).toBeCloseTo(340 * scale, 1);
  expect(now.box.height, 'the box keeps the tallest height so far').toBe(Math.ceil(tallest * scale));
  expect(now.frame.left, 'the box holds the frame').toBeGreaterThanOrEqual(now.box.left - 0.5);
  expect(now.frame.top, 'the box holds the frame').toBeGreaterThanOrEqual(now.box.top - 0.5);
  expect(now.frame.right, 'the box holds the frame').toBeLessThanOrEqual(now.box.right + 0.5);
  expect(now.frame.bottom, 'the box holds the frame').toBeLessThanOrEqual(now.box.bottom + 0.5);
  expect(now.box.left).toBeGreaterThanOrEqual(now.column.left - 0.5);
  expect(now.box.right).toBeLessThanOrEqual(now.column.right + 0.5);
}

// The elements that reach past the window's right edge themselves, rather
// than through something inside them.
const widerThanWindow = (page) => page.evaluate(() => {
  const width = document.documentElement.clientWidth;
  const past = (element) => element.getBoundingClientRect().right > width + 0.5;
  const describe = (element) => {
    const { left, right } = element.getBoundingClientRect();
    const name = element.tagName.toLowerCase() + [...element.classList].map((value) => `.${value}`).join('');
    const text = element.textContent.trim().replace(/\s+/g, ' ').slice(0, 60);
    return `${name} "${text}" spans ${Math.round(left)}–${Math.round(right)}px`;
  };
  return {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: width,
    elements: [...document.body.querySelectorAll('*')]
      .filter((element) => past(element) && ![...element.children].some(past))
      .map(describe)
  };
});

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`the home page holds the whole popup, on a ${name}`, async ({ page, siteUrl }) => {
    await page.setViewportSize(viewport);
    await openHome(page, siteUrl);

    const first = await settledHome(page);
    const scale = scaleOf(first);
    if (name !== 'desktop') expect(scale, 'the phone is narrow enough to scale the popup').toBeLessThan(1);
    expect(first.frame.width).toBeCloseTo(340 * scale, 1);
    let tallest = Math.max(first.reserved, first.popupHeight);
    expectBoxHolds(first, tallest, scale);
    expect(first.pageWidth, 'nothing on the page is wider than the window').toBeLessThanOrEqual(first.windowWidth);

    // My Presets is taller: the frame and its box grow with it. Back on the
    // presets, the frame shrinks again but the box keeps the tallest height,
    // so the page around it doesn't move. The clicks land where the scaled
    // popup is drawn.
    await clickInPopup(page, '#tab-custom');
    await expect(popupFrame(page).locator('#panel-custom')).toBeVisible();
    const custom = await settledHome(page);
    expect(custom.frameHeight).toBeGreaterThan(first.frameHeight);
    tallest = Math.max(tallest, custom.popupHeight);
    expectBoxHolds(custom, tallest, scale);
    await clickInPopup(page, '#tab-presets');
    await expect(popupFrame(page).locator('#panel-presets')).toBeVisible();
    const back = await settledHome(page);
    expect(back.frameHeight).toBe(first.frameHeight);
    expectBoxHolds(back, tallest, scale);
    expect(back.box.height).toBe(custom.box.height);

    // The demo's controls are on screen and usable.
    for (const control of ['#play', '#speed']) {
      const locator = page.locator(control);
      await locator.scrollIntoViewIfNeeded();
      await expect(locator).toBeInViewport({ ratio: 1 });
    }
  });

  // On Ubuntu's fonts the popup is a few pixels shorter than the room the
  // page reserves for it; here it's made shorter on purpose, so every
  // machine checks that the box keeps that room and the frame still fits.
  test(`the home page keeps the room it reserved for a shorter popup, on a ${name}`, async ({ page, siteUrl }) => {
    await page.route('**/popup/popup.css', async (route) => {
      const response = await route.fetch();
      const css = `${await response.text()}\n.scroll-area { padding-top: 0; padding-bottom: 0; }\n`;
      await route.fulfill({ response, body: css });
    });
    await page.setViewportSize(viewport);
    await openHome(page, siteUrl);

    const now = await settledHome(page);
    expect(now.popupHeight, 'setup: the popup is shorter than the room reserved for it').toBeLessThan(now.reserved);
    const scale = scaleOf(now);
    expect(now.frame.height).toBeCloseTo(now.popupHeight * scale, 0);
    expectBoxHolds(now, now.reserved, scale);
  });

  test(`every page loads from this machine alone and fits, on a ${name}`, async ({ page, siteUrl }) => {
    await page.setViewportSize(viewport);
    // Measures every page before judging, so a failure names each page and
    // the elements that make it too wide.
    const tooWide = {};
    for (const pathname of PAGES) {
      const response = await page.goto(`${siteUrl}${pathname}`);
      expect(response.status(), pathname).toBe(200);
      await expect(page.locator('h1'), pathname).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const widths = await widerThanWindow(page);
      if (widths.scrollWidth > widths.clientWidth || widths.elements.length) tooWide[pathname] = widths;
    }
    expect(tooWide, 'pages wider than the window, and what reaches past it').toEqual({});
  });
}

test('serves clean addresses and a 404 page, as Cloudflare does', async ({ page, siteUrl, guard }) => {
  const redirected = await page.goto(`${siteUrl}/guide.html`);
  expect(redirected.url()).toBe(`${siteUrl}/guide`);
  expect(redirected.status()).toBe(200);

  const missing = await page.goto(`${siteUrl}/no-such-page`);
  expect(missing.status()).toBe(404);
  await expect(page.locator('h1')).toHaveText('Page not found');
  // The 404 itself (and the browser's console line for it) is the only problem.
  const problems = guard.take();
  expect(problems).toContain(`HTTP 404: ${siteUrl}/no-such-page`);
  for (const problem of problems) expect(problem).toMatch(/404/);
});

// The checks above have to fail when the site goes wrong in these ways.
test.describe('site controls', () => {
  test('stops and reports a request to another site', async ({ page, siteUrl, guard }) => {
    await page.goto(`${siteUrl}/`);
    const results = await page.evaluate(async () => {
      const fetched = await fetch('https://example.com/stage5-probe').then(() => 'loaded', () => 'blocked');
      const image = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve('loaded');
        img.onerror = () => resolve('blocked');
        img.src = 'https://images.example.org/stage5-probe.png';
      });
      return { fetched, image };
    });
    expect(results).toEqual({ fetched: 'blocked', image: 'blocked' });
    const problems = guard.take();
    expect(problems).toContainEqual(expect.stringContaining('request to another site, stopped: GET https://example.com/stage5-probe'));
    expect(problems).toContainEqual(expect.stringContaining('request to another site, stopped: GET https://images.example.org/stage5-probe.png'));
  });

  test('reports errors in the page and in the popup', async ({ page, siteUrl, guard }) => {
    await openHome(page, siteUrl);
    await page.evaluate(() => {
      console.error('stage5 console probe');
      setTimeout(() => { throw new Error('stage5 page probe'); }, 0);
    });
    await page.frame({ url: /\/popup\/popup$/ }).evaluate(() => {
      setTimeout(() => { throw new Error('stage5 popup probe'); }, 0);
    });
    const problems = [];
    await expect.poll(() => {
      problems.push(...guard.take());
      return ['stage5 console probe', 'stage5 page probe', 'stage5 popup probe']
        .filter((probe) => !problems.some((problem) => problem.includes(probe)));
    }, { message: 'every probe is reported' }).toEqual([]);
  });

  test(`notices when the popup's choices stop reaching the demo ${PLAYBACK}`, async ({ page, siteUrl }) => {
    // popup-host.js without the message that tells the page what the popup applied.
    await page.route('**/popup/popup-host.js', async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const broken = source.replace(
        "post({ type: 'settings', settings: tabState.settings, enabled: tabState.enabled });\n        }",
        '}'
      );
      expect(broken, 'control setup: popup-host.js no longer matches').not.toBe(source);
      await route.fulfill({ response, body: broken });
    });
    await openHome(page, siteUrl);
    await expectDemoPlays(page);
    await expect(expectPopupDrivesDemo(page, { timeout: 1_500 })).rejects.toThrow();
    await expect(page.locator('#speed-out')).toHaveText('0.80×');
  });

  test("notices when the demo song doesn't play", async ({ page, siteUrl, guard }) => {
    await page.route('**/assets/audio/start-again-loop.mp3', (route) => route.fulfill({ status: 404, body: '' }));
    await openHome(page, siteUrl);
    const failure = await expectDemoPlays(page, { timeout: 1_500 }).then(() => null, (error) => error);
    expect(failure, 'the demo must not play').not.toBeNull();
    await expect(page.locator('#play-error')).toHaveText("The demo song couldn't play in this browser.");
    expect(guard.take()).toContainEqual(expect.stringMatching(/^HTTP 404: .*start-again-loop\.mp3$/));
    // The record shows the song was fetched, refused, and nothing else was tried.
    expect(failure.playback.waitingFor).toEqual([]);
    expect(failure.playback.steps).toEqual([
      expect.objectContaining({ step: 'fetch the song', outcome: 'resolved', value: 'HTTP 404' })
    ]);
    expect(failure.playback.demo).toMatchObject({ loading: false, playing: false, error: 'failed' });
  });

  // A song that never arrives leaves the play button waiting, as a missing
  // sound device can. The error has to say which step is still waiting.
  test('says which step a demo that never starts is waiting for', async ({ page, siteUrl }) => {
    await page.route('**/assets/audio/start-again-loop.mp3', () => new Promise(() => {}));
    await openHome(page, siteUrl);
    const failure = await expectDemoPlays(page, { timeout: 1_500 }).then(() => null, (error) => error);
    expect(failure, 'the demo must not play').not.toBeNull();
    expect(failure.message).toContain('still waiting to fetch the song');
    expect(failure.playback.waitingFor).toEqual(['fetch the song']);
    expect(failure.playback.contexts).toEqual([]);
    expect(failure.playback.demo).toMatchObject({ loading: true, playing: false, error: null });
    await expect(page.locator('#play')).toBeDisabled();
  });

  test('stops and reports a WebSocket to another site', async ({ page, siteUrl, guard }) => {
    // The other site is a second server on this machine, which records
    // every connection it gets: nothing must reach it.
    const reached = [];
    const endpoint = http.createServer((request, response) => {
      reached.push(`${request.method} ${request.url}`);
      response.end();
    });
    endpoint.on('connection', () => reached.push('connection'));
    endpoint.on('upgrade', (request, socket) => {
      reached.push(`upgrade ${request.url}`);
      socket.destroy();
    });
    await new Promise((resolve, reject) => {
      endpoint.once('error', reject);
      endpoint.listen(0, '127.0.0.1', resolve);
    });
    try {
      await page.goto(`${siteUrl}/`);
      const url = `ws://127.0.0.1:${endpoint.address().port}/stage5-probe`;
      const events = await page.evaluate((target) => new Promise((resolve) => {
        const seen = [];
        const socket = new WebSocket(target);
        for (const type of ['open', 'error', 'close']) {
          socket.addEventListener(type, () => {
            seen.push(type);
            if (type === 'close') resolve(seen);
          });
        }
        setTimeout(() => resolve([...seen, 'still open after 5s']), 5_000);
      }), url);
      expect(events, 'the page sees its socket closed').toContain('close');
      expect(reached, 'the other site gets nothing').toEqual([]);
      // The WebSocket route stops it in both engines, so that's the one report.
      expect(guard.take()).toEqual([`request to another site, stopped: WebSocket ${url}`]);
    } finally {
      endpoint.closeAllConnections();
      await new Promise((resolve) => endpoint.close(resolve));
    }
  });
});
