'use strict';

// Checks the popup's layout as the browser draws it. A popup window takes the
// size of its page, up to 800 × 600 in Chromium and Firefox, so the page has
// to fit that on its own: 340px wide, no taller than 600px, and with every
// control on screen, since a popup that scrolls hides the controls below the
// fold. popup.css caps .scroll-area at 592px (600 less the 4px frame) and lets
// it scroll beyond that, so "fits" means its content is no taller than the
// area shows, not merely that the window is under 600px, which the cap alone
// guarantees.
//
// Used by e2e/extension.spec.js on the installed extension's popup and by
// e2e/ui/popup-layout.spec.js on the popup page rendered with a stub API.

const POPUP_WIDTH = 340;
const POPUP_MAX_HEIGHT = 600;

// Runs in the popup. `controls` lists what must be on screen and not covered:
// { selector, scroll } where `scroll` first scrolls the control into view
// inside a list that scrolls on its own (the saved presets).
function inspectPopup({ controls, width, maxHeight }) {
  const problems = [];
  const px = (value) => Math.round(value * 100) / 100;
  const name = (element) => {
    if (element.id) return `#${element.id}`;
    const classes = [...element.classList].slice(0, 2).map((value) => `.${value}`).join('');
    return `${element.tagName.toLowerCase()}${classes}`;
  };
  const add = (kind, detail) => problems.push({ kind, detail });

  const scrollArea = document.querySelector('.scroll-area');
  const container = document.querySelector('.container');
  const pageWidth = document.documentElement.getBoundingClientRect().width;
  const body = document.body.getBoundingClientRect();
  if (Math.abs(pageWidth - width) > 0.5) add('width', `the page is ${px(pageWidth)}px wide, not ${width}px`);
  if (Math.abs(body.width - width) > 0.5) add('width', `the body is ${px(body.width)}px wide, not ${width}px`);
  if (body.height > maxHeight + 0.5) {
    add('height', `the popup is ${px(body.height)}px tall, more than the ${maxHeight}px a popup window gets`);
  }

  if (scrollArea.scrollHeight > scrollArea.clientHeight) {
    add('scrolls', `the content is ${scrollArea.scrollHeight}px tall but the popup shows ${scrollArea.clientHeight}px`);
  }
  if (scrollArea.scrollWidth > scrollArea.clientWidth) {
    add('overflow-x', `the content is ${scrollArea.scrollWidth}px wide in a ${scrollArea.clientWidth}px area`);
  }

  // .scroll-area clips sideways, so something too wide is cut off rather than
  // scrolled; look for any drawn element that crosses the panel's edges.
  const panel = container.getBoundingClientRect();
  for (const element of scrollArea.querySelectorAll('*')) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if (box.left < panel.left - 0.5 || box.right > panel.right + 0.5) {
      add('overflow-x', `${name(element)} spans ${px(box.left)}–${px(box.right)}px, outside the panel's ${px(panel.left)}–${px(panel.right)}px`);
    }
  }

  // The part of the window an element can be seen in: inside every ancestor
  // that clips its content.
  const visibleArea = (element) => {
    let area = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = parent.getBoundingClientRect();
      const left = box.left + parent.clientLeft;
      const top = box.top + parent.clientTop;
      area = {
        left: Math.max(area.left, left),
        top: Math.max(area.top, top),
        right: Math.min(area.right, left + parent.clientWidth),
        bottom: Math.min(area.bottom, top + parent.clientHeight)
      };
    }
    return area;
  };

  const scrolledBefore = scrollArea.scrollTop;
  for (const { selector, scroll } of controls) {
    const element = document.querySelector(selector);
    if (!element) {
      add('missing', `${selector} isn't in the popup`);
      continue;
    }
    if (scroll) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || style.visibility !== 'visible' || Number(style.opacity) === 0) {
      add('hidden', `${selector} isn't drawn (${px(box.width)} × ${px(box.height)}px, ${style.visibility}, opacity ${style.opacity})`);
      continue;
    }
    const area = visibleArea(element);
    if (box.left < area.left - 0.5 || box.top < area.top - 0.5 ||
        box.right > area.right + 0.5 || box.bottom > area.bottom + 0.5) {
      add('cut-off', `${selector} at ${px(box.left)},${px(box.top)}–${px(box.right)},${px(box.bottom)} is outside what shows of it, ${px(area.left)},${px(area.top)}–${px(area.right)},${px(area.bottom)}`);
      continue;
    }
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!hit || !(hit === element || element.contains(hit))) {
      add('covered', `${selector} is under ${hit ? name(hit) : 'nothing'} at its center`);
    }
  }
  if (scrollArea.scrollTop !== scrolledBefore) {
    add('scrolls', `showing a control scrolled the whole popup by ${scrollArea.scrollTop - scrolledBefore}px`);
  }

  return {
    problems,
    size: {
      width: px(body.width),
      height: px(body.height),
      content: scrollArea.scrollHeight,
      shown: scrollArea.clientHeight,
      limit: window.getComputedStyle(scrollArea).maxHeight
    }
  };
}

// Waits for the popup to finish its first sync and draw, then inspects it.
// `controls` are CSS selectors, or { selector, scroll } objects.
async function measurePopup(page, controls) {
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return page.evaluate(inspectPopup, {
    controls: controls.map((control) => (typeof control === 'string' ? { selector: control } : control)),
    width: POPUP_WIDTH,
    maxHeight: POPUP_MAX_HEIGHT
  });
}

// What every popup shows whatever its state: the header and the footer.
const FRAME_CONTROLS = Object.freeze([
  '.header-power .switch-slider',
  '#theme-picker-btn',
  '.github-link',
  '#reset-btn',
  '#rate-link'
]);

// The upper tabs with the built-in presets, and the Basic tab's controls.
const BASIC_CONTROLS = Object.freeze([
  '#tab-presets',
  '#tab-custom',
  '[data-preset="slowed"]',
  '[data-preset="nightcore"]',
  '#effect-tab-basic',
  '#effect-tab-advanced',
  '#speed-slider',
  '#reverb-slider',
  '#eq-handle-low',
  '#eq-handle-mid',
  '#eq-handle-high'
]);

module.exports = { BASIC_CONTROLS, FRAME_CONTROLS, POPUP_MAX_HEIGHT, POPUP_WIDTH, measurePopup };
