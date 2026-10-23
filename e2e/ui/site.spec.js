'use strict';

// The website as it is in site/, served by scripts/serve-site.js the way
// Cloudflare serves it, in Chromium and in Firefox. The home and guide pages
// run the real popup (site/popup/, a copy of extension/popup.*) in a frame,
// and the demo plays the song in site/assets/audio/ through site/demo-audio.js.
//
// Every request is checked: one to anywhere but the local server fails the
// test, and is stopped before it leaves the browser. So do the page's errors,
// console errors and failed local requests. No store, YouTube or Spotify page
// is opened. The browsers are muted: playing is checked by the song's clock
// and the page, not by its sound.

const { expect, test: base } = require('@playwright/test');

const { createSiteServer } = require('../../scripts/serve-site');

const PAGES = ['/', '/guide', '/faq', '/changelog', '/privacy'];
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  // Narrower than the popup plus the page's margins, so the home page scales it down.
  phone: { width: 360, height: 780 }
};

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
  guard: [
    async ({ context, page, siteUrl }, use, testInfo) => {
      const origin = new URL(siteUrl).origin;
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

// Records each media element the page plays, so the test can read the song's
// clock and speed. demo-audio.js keeps its <audio> to itself.
function recordMedia() {
  const play = HTMLMediaElement.prototype.play;
  window.__playedMedia = [];
  HTMLMediaElement.prototype.play = function () {
    if (!window.__playedMedia.includes(this)) window.__playedMedia.push(this);
    return play.call(this);
  };
}

const media = (page) => page.evaluate(() => {
  const [element] = window.__playedMedia;
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
  await page.addInitScript(recordMedia);
  await page.goto(`${siteUrl}/`);
  // The popup has finished its first sync, and the page has heard from it.
  await expect(popupFrame(page).locator('body')).not.toHaveClass(/booting/);
  await expect(popupFrame(page).locator('#current-preset-label')).toHaveText('Current Preset: Slowed + Reverb');
  await expect(page.locator('#speed-out')).toHaveText('0.80×');
}

// Presses play and checks that the song's clock moves.
async function expectDemoPlays(page, { timeout = 10_000 } = {}) {
  await page.locator('#play').click();
  await expect(page.locator('#play'), 'the play button shows playing').toHaveAttribute('aria-pressed', 'true', { timeout });
  const start = (await media(page))?.time ?? 0;
  await expect
    .poll(async () => (await media(page))?.time ?? 0, { message: "the song's clock moves", timeout })
    .toBeGreaterThan(start + 0.25);
}

// Picks Nightcore in the popup and checks that the demo follows.
async function expectPopupDrivesDemo(page, { timeout = 5_000 } = {}) {
  await popupFrame(page).locator('[data-preset="nightcore"]').click();
  await expect(page.locator('#speed-out')).toHaveText('1.20×', { timeout });
  await expect(page.locator('#label-speed')).toHaveText('speed 1.20×', { timeout });
  await expect.poll(async () => (await media(page))?.rate, { timeout }).toBe(1.2);
}

test('the demo plays and pauses, and follows the popup both ways', async ({ page, siteUrl }) => {
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

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`the home page holds the whole popup, on a ${name}`, async ({ page, siteUrl }) => {
    await page.setViewportSize(viewport);
    await openHome(page, siteUrl);

    const layout = () => page.evaluate(() => {
      const frame = document.getElementById('popup');
      const box = frame.parentElement;
      const column = box.parentElement;
      const rect = (element) => {
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      return {
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
    // The frame is as tall as the popup, drawn at the column's scale. It
    // eases to a new height (styles.css), so wait for it to land.
    const settled = async () => {
      await expect.poll(async () => {
        const now = await layout();
        return {
          heightSet: now.frameHeight - now.popupHeight,
          drawnAtScale: Math.abs(now.frame.height - now.popupHeight * scaleOf(now)) < 0.5
        };
      }, { message: "the frame takes the popup's height" }).toEqual({ heightSet: 0, drawnAtScale: true });
      return layout();
    };

    const first = await settled();
    const scale = scaleOf(first);
    if (name === 'phone') expect(scale, 'the phone is narrow enough to scale the popup').toBeLessThan(1);
    expect(first.frame.width).toBeCloseTo(340 * scale, 1);
    expect(first.box.width).toBeCloseTo(340 * scale, 1);
    expect(first.box.height).toBe(Math.ceil(first.popupHeight * scale));
    expect(first.box.left).toBeGreaterThanOrEqual(first.column.left - 0.5);
    expect(first.box.right).toBeLessThanOrEqual(first.column.right + 0.5);
    expect(first.pageWidth, 'nothing on the page is wider than the window').toBeLessThanOrEqual(first.windowWidth);

    // My Presets is taller: the frame and its box grow with it. Back on the
    // presets, the frame shrinks again but the box keeps the tallest height,
    // so the page around it doesn't move. The clicks land where the scaled
    // popup is drawn.
    await clickInPopup(page, '#tab-custom');
    await expect(popupFrame(page).locator('#panel-custom')).toBeVisible();
    const custom = await settled();
    expect(custom.frameHeight).toBeGreaterThan(first.frameHeight);
    expect(custom.box.height).toBe(Math.ceil(custom.popupHeight * scale));
    await clickInPopup(page, '#tab-presets');
    await expect(popupFrame(page).locator('#panel-presets')).toBeVisible();
    const back = await settled();
    expect(back.frameHeight).toBe(first.frameHeight);
    expect(back.box.height).toBe(custom.box.height);

    // The demo's controls are on screen and usable.
    for (const control of ['#play', '#speed']) {
      const locator = page.locator(control);
      await locator.scrollIntoViewIfNeeded();
      await expect(locator).toBeInViewport({ ratio: 1 });
    }
  });

  test(`every page loads from this machine alone and fits, on a ${name}`, async ({ page, siteUrl }) => {
    await page.setViewportSize(viewport);
    for (const pathname of PAGES) {
      const response = await page.goto(`${siteUrl}${pathname}`);
      expect(response.status(), pathname).toBe(200);
      await expect(page.locator('h1'), pathname).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(widths[0], `${pathname} is no wider than the window`).toBeLessThanOrEqual(widths[1]);
    }
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

  test("notices when the popup's choices stop reaching the demo", async ({ page, siteUrl }) => {
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
    await expect(expectDemoPlays(page, { timeout: 1_500 })).rejects.toThrow();
    await expect(page.locator('#play-error')).toHaveText("The demo song couldn't play in this browser.");
    expect(guard.take()).toContainEqual(expect.stringMatching(/^HTTP 404: .*start-again-loop\.mp3$/));
  });
});
