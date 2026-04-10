// ==UserScript==
// @name         menu simple blocker
// @namespace    berry-workaround
// @version      1.0.3
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  let lastTouch = 0;

  document.addEventListener('touchstart', function () {
    lastTouch = Date.now();
  }, true);

  document.addEventListener('pointerdown', function () {
    lastTouch = Date.now();
  }, true);

  document.addEventListener('click', function (e) {
    const el = e.target instanceof Element ? e.target.closest('#menu, #spNaviBtn') : null;
    if (!el) return;

    if (Date.now() - lastTouch > 800) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);
})();
