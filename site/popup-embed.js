'use strict';

// Hosts the real popup in a frame and relays what it reports. Settings go to
// whoever asked, the theme is written onto the page, and the frame is sized to
// the panel. `setControl` pushes a value into one of the popup's own sliders so
// a control on the page can drive the popup rather than bypass it.
//
// When the frame sits in a `.popup-fit` box, the popup is scaled down to fit a
// column narrower than its fixed width instead of being cropped, and the box
// keeps the tallest height seen so far, so switching tabs does not move the
// page around it.
//
// The frame may finish loading before this runs, and what it reported then is
// gone. So once listening, this asks the frame to send its state again, now
// and whenever the frame (re)loads.

window.SRPopupEmbed = function mount(frame, { onSettings, onTheme } = {}) {
  const POPUP_WIDTH = 340;
  const box = frame.parentElement.classList.contains('popup-fit') ? frame.parentElement : null;
  let height = Number(frame.getAttribute('height')) || 0;
  let tallest = height;

  function layout() {
    frame.style.height = `${height}px`;
    if (!box) return;
    const scale = Math.min(1, box.parentElement.clientWidth / POPUP_WIDTH);
    frame.style.transform = scale < 1 ? `scale(${scale})` : '';
    box.style.width = `${POPUP_WIDTH * scale}px`;
    box.style.height = `${Math.ceil(tallest * scale)}px`;
  }

  if (box) {
    new ResizeObserver(layout).observe(box.parentElement);
    layout();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== 'sr-popup') return;
    if (message.type === 'height') {
      height = message.height;
      tallest = Math.max(tallest, height);
      layout();
    } else if (message.type === 'theme') {
      document.documentElement.dataset.theme = message.theme;
      if (onTheme) onTheme(message.theme);
    } else if (message.type === 'settings') {
      if (onSettings) onSettings(message.settings, message.enabled);
    }
  });

  const requestState = () => {
    if (frame.contentWindow) frame.contentWindow.postMessage({ source: 'sr-page', type: 'sync' }, location.origin);
  };
  frame.addEventListener('load', requestState);
  requestState();

  return {
    click(id) {
      const button = frame.contentDocument && frame.contentDocument.getElementById(id);
      if (!button) return false;
      button.click();
      return true;
    },
    setControl(id, value) {
      const input = frame.contentDocument && frame.contentDocument.getElementById(id);
      if (!input) return false;
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  };
};
