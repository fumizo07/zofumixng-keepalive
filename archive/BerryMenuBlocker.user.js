// ==UserScript==
// @name         side-effect reset
// @namespace    berry-workaround
// @version      1.0.0
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  let timerId = null;
  let observer = null;

  function setStyle(el, prop, value) {
    if (!el || !el.style) return;
    el.style.setProperty(prop, value, 'important');
  }

  function clearStyle(el, prop) {
    if (!el || !el.style) return;
    el.style.removeProperty(prop);
  }

  function resetMenuSideEffects() {
    const html = document.documentElement;
    const body = document.body;
    const home = document.querySelector('ul#home');
    const spNavi = document.getElementById('spNavi');

    if (html) {
      html.classList.remove('open', 'menu-open', 'nav-open', 'drawer-open', 'is-open');
      setStyle(html, 'overflow', 'auto');
      clearStyle(html, 'height');
      clearStyle(html, 'top');
      clearStyle(html, 'left');
      clearStyle(html, 'right');
      clearStyle(html, 'bottom');
    }

    if (body) {
      body.classList.remove('open', 'menu-open', 'nav-open', 'drawer-open', 'is-open');
      setStyle(body, 'overflow', 'auto');
      clearStyle(body, 'height');
      clearStyle(body, 'top');
      clearStyle(body, 'left');
      clearStyle(body, 'right');
      clearStyle(body, 'bottom');
    }

    if (home) {
      // ここが今回の本丸
      clearStyle(home, 'position');
      clearStyle(home, 'top');
      clearStyle(home, 'left');
      clearStyle(home, 'right');
      clearStyle(home, 'bottom');
      clearStyle(home, 'transform');
      clearStyle(home, 'transition');
    }

    if (spNavi) {
      // 表示は消すが、他要素の margin 等には触らない
      setStyle(spNavi, 'display', 'none');
      setStyle(spNavi, 'visibility', 'hidden');
      setStyle(spNavi, 'pointer-events', 'none');
      clearStyle(spNavi, 'overflow');
      clearStyle(spNavi, '-webkit-overflow-scrolling');
    }
  }

  function injectStyle() {
    if (document.getElementById('berry-cityheaven-fix-style')) return;

    const style = document.createElement('style');
    style.id = 'berry-cityheaven-fix-style';
    style.textContent = `
      html, body {
        overflow: auto !important;
      }

      #spNavi {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      ul#home {
        position: static !important;
        top: auto !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function boot() {
    injectStyle();
    resetMenuSideEffects();

    setTimeout(resetMenuSideEffects, 50);
    setTimeout(resetMenuSideEffects, 150);
    setTimeout(resetMenuSideEffects, 400);
    setTimeout(resetMenuSideEffects, 900);

    if (!timerId) {
      timerId = window.setInterval(resetMenuSideEffects, 250);
    }

    if (!observer) {
      observer = new MutationObserver(() => {
        resetMenuSideEffects();
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

  window.addEventListener('pageshow', resetMenuSideEffects, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resetMenuSideEffects();
    }
  }, true);
})();
