// ==UserScript==
// @name         Berry slide reset
// @namespace    berry-workaround
// @version      3.0.0
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TIMER_MS = 150;
  let observer = null;
  let timerId = null;

  function setStyleSafe(el, prop, value, priority = 'important') {
    if (!el || !el.style) return;
    el.style.setProperty(prop, value, priority);
  }

  function removeClasses(el, classes) {
    if (!el || !el.classList) return;
    for (const cls of classes) {
      el.classList.remove(cls);
    }
  }

  function resetRootState() {
    const targets = [document.documentElement, document.body].filter(Boolean);

    for (const el of targets) {
      removeClasses(el, ['open', 'menu-open', 'nav-open', 'drawer-open', 'is-open']);

      setStyleSafe(el, 'overflow', 'auto');
      setStyleSafe(el, 'height', 'auto');
      setStyleSafe(el, 'min-height', '0');
      setStyleSafe(el, 'max-height', 'none');
      setStyleSafe(el, 'position', 'static');
      setStyleSafe(el, 'top', 'auto');
      setStyleSafe(el, 'left', 'auto');
      setStyleSafe(el, 'right', 'auto');
      setStyleSafe(el, 'bottom', 'auto');
      setStyleSafe(el, 'margin-left', '0px');
      setStyleSafe(el, 'margin-right', '0px');
      setStyleSafe(el, 'transform', 'none');
      setStyleSafe(el, 'translate', 'none');
      setStyleSafe(el, 'width', 'auto');
    }
  }

  function resetHomeState() {
    const home = document.querySelector('ul#home');
    if (!home) return;

    setStyleSafe(home, 'position', 'static');
    setStyleSafe(home, 'top', 'auto');
    setStyleSafe(home, 'left', 'auto');
    setStyleSafe(home, 'right', 'auto');
    setStyleSafe(home, 'bottom', 'auto');
    setStyleSafe(home, 'margin-left', '0px');
    setStyleSafe(home, 'margin-right', '0px');
    setStyleSafe(home, 'transform', 'none');
    setStyleSafe(home, 'translate', 'none');
    setStyleSafe(home, 'transition', 'none');
    setStyleSafe(home, 'width', 'auto');
    setStyleSafe(home, 'max-width', '100%');
  }

  function resetSpNaviState() {
    const spNavi = document.getElementById('spNavi');
    if (!spNavi) return;

    setStyleSafe(spNavi, 'overflow', 'auto');
    setStyleSafe(spNavi, '-webkit-overflow-scrolling', 'touch');
  }

  function hideBrokenPanelIfNeeded() {
    const spNavi = document.getElementById('spNavi');
    if (!spNavi) return;

    const rect = spNavi.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;

    const looksLikeFullPanel =
      rect.width >= vw * 0.5 &&
      rect.height >= vh * 0.5;

    if (looksLikeFullPanel) {
      setStyleSafe(spNavi, 'display', 'none');
      setStyleSafe(spNavi, 'visibility', 'hidden');
      setStyleSafe(spNavi, 'pointer-events', 'none');
    }
  }

  function restoreHiddenMainCandidates() {
    const selectors = [
      '#wrapper', '#wrap', '#container', '#contents', '#content', '#main',
      '.wrapper', '.wrap', '.container', '.contents', '.content', '.main',
      '#page', '.page', '#sitewrap', '.sitewrap', '#app', '.app'
    ];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        setStyleSafe(el, 'position', 'static');
        setStyleSafe(el, 'top', 'auto');
        setStyleSafe(el, 'left', 'auto');
        setStyleSafe(el, 'right', 'auto');
        setStyleSafe(el, 'margin-left', '0px');
        setStyleSafe(el, 'margin-right', '0px');
        setStyleSafe(el, 'transform', 'none');
        setStyleSafe(el, 'translate', 'none');
        setStyleSafe(el, 'transition', 'none');
      }
    }
  }

  function applyAllResets() {
    resetRootState();
    resetHomeState();
    resetSpNaviState();
    restoreHiddenMainCandidates();
    hideBrokenPanelIfNeeded();
  }

  function injectStyle() {
    if (document.getElementById('berry-cityheaven-reset-style')) return;

    const style = document.createElement('style');
    style.id = 'berry-cityheaven-reset-style';
    style.textContent = `
      html, body {
        overflow: auto !important;
        height: auto !important;
        min-height: 0 !important;
        max-height: none !important;
        position: static !important;
        top: auto !important;
        left: auto !important;
        right: auto !important;
        bottom: auto !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        transform: none !important;
        translate: none !important;
      }

      ul#home {
        position: static !important;
        top: auto !important;
        left: auto !important;
        right: auto !important;
        bottom: auto !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        transform: none !important;
        translate: none !important;
        transition: none !important;
        max-width: 100% !important;
      }

      #wrapper, #wrap, #container, #contents, #content, #main,
      .wrapper, .wrap, .container, .contents, .content, .main,
      #page, .page, #sitewrap, .sitewrap, #app, .app {
        position: static !important;
        top: auto !important;
        left: auto !important;
        right: auto !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        transform: none !important;
        translate: none !important;
        transition: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function startObserver() {
    if (observer) return;

    observer = new MutationObserver(() => {
      applyAllResets();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }

  function startTimer() {
    if (timerId) return;
    timerId = window.setInterval(applyAllResets, TIMER_MS);
  }

  function boot() {
    injectStyle();
    applyAllResets();
    startObserver();
    startTimer();

    setTimeout(applyAllResets, 50);
    setTimeout(applyAllResets, 200);
    setTimeout(applyAllResets, 500);
    setTimeout(applyAllResets, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true, capture: true });
  } else {
    boot();
  }

  window.addEventListener('pageshow', applyAllResets, true);
  window.addEventListener('focus', applyAllResets, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      applyAllResets();
    }
  }, true);
})();
