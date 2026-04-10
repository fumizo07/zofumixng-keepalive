// ==UserScript==
// @name         Berry menu reset v2
// @namespace    berry-workaround
// @version      2.0.0
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  let timerId = null;
  let observer = null;

  function setImportant(el, prop, value) {
    if (!el || !el.style) return;
    el.style.setProperty(prop, value, 'important');
  }

  function clearProp(el, prop) {
    if (!el || !el.style) return;
    el.style.removeProperty(prop);
  }

  function resetMenuState() {
    const html = document.documentElement;
    const body = document.body;
    const home = document.querySelector('ul#home');
    const spNavi = document.getElementById('spNavi');

    if (html) {
      html.classList.remove('open', 'menu-open', 'nav-open', 'drawer-open', 'is-open');
      setImportant(html, 'overflow', 'auto');
      clearProp(html, 'height');
      clearProp(html, 'top');
      clearProp(html, 'left');
      clearProp(html, 'right');
      clearProp(html, 'bottom');
    }

    if (body) {
      body.classList.remove('open', 'menu-open', 'nav-open', 'drawer-open', 'is-open');
      setImportant(body, 'overflow', 'auto');
      clearProp(body, 'height');
      clearProp(body, 'top');
      clearProp(body, 'left');
      clearProp(body, 'right');
      clearProp(body, 'bottom');
    }

    if (home) {
      // ここを弱くすると再発し、強くしすぎると他UIを壊すのでこの範囲に限定
      setImportant(home, 'position', 'static');
      setImportant(home, 'top', 'auto');
      setImportant(home, 'left', 'auto');
      setImportant(home, 'right', 'auto');
      setImportant(home, 'bottom', 'auto');
      setImportant(home, 'transform', 'none');
      setImportant(home, 'transition', 'none');
    }

    if (spNavi) {
      setImportant(spNavi, 'display', 'none');
      setImportant(spNavi, 'visibility', 'hidden');
      setImportant(spNavi, 'pointer-events', 'none');
      setImportant(spNavi, 'overflow', 'hidden');
    }
  }

  function injectStyle() {
    if (document.getElementById('berry-cityheaven-menu-reset-style')) return;

    const style = document.createElement('style');
    style.id = 'berry-cityheaven-menu-reset-style';
    style.textContent = `
      html {
        overflow: auto !important;
      }

      body {
        overflow: auto !important;
      }

      ul#home {
        position: static !important;
        top: auto !important;
        left: auto !important;
        right: auto !important;
        bottom: auto !important;
        transform: none !important;
        transition: none !important;
      }

      #spNavi {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
        overflow: hidden !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function boot() {
    injectStyle();
    resetMenuState();

    setTimeout(resetMenuState, 30);
    setTimeout(resetMenuState, 100);
    setTimeout(resetMenuState, 250);
    setTimeout(resetMenuState, 500);
    setTimeout(resetMenuState, 1000);

    if (!timerId) {
      timerId = window.setInterval(resetMenuState, 120);
    }

    if (!observer) {
      observer = new MutationObserver(() => {
        resetMenuState();
      });

      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true, capture: true });
  } else {
    boot();
  }

  window.addEventListener('pageshow', resetMenuState, true);
  window.addEventListener('focus', resetMenuState, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resetMenuState();
    }
  }, true);
})();
