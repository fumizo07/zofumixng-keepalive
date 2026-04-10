// ==UserScript==
// @name         Berry menu reset v2
// @namespace    berry-workaround
// @version      3.0.0
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  let patched = false;

  function isElementNode(el) {
    return !!el && el.nodeType === 1;
  }

  function matchesSelectorSafe(el, selector) {
    try {
      return isElementNode(el) && el.matches(selector);
    } catch (_) {
      return false;
    }
  }

  function isHtml(el) {
    return el === document.documentElement || matchesSelectorSafe(el, 'html');
  }

  function isBody(el) {
    return el === document.body || matchesSelectorSafe(el, 'body');
  }

  function isHome(el) {
    return matchesSelectorSafe(el, 'ul#home');
  }

  function isSpNavi(el) {
    return matchesSelectorSafe(el, '#spNavi');
  }

  function shouldBlockCssWrite(el, prop, value) {
    const p = String(prop || '').trim().toLowerCase();
    const v = String(value == null ? '' : value).trim().toLowerCase();

    if (isHtml(el)) {
      if (p === 'overflow' && v === 'hidden') return true;
      if (p === 'height' && v === '100vh') return true;
    }

    if (isBody(el)) {
      if (p === 'overflow' && v === 'hidden') return true;
    }

    if (isHome(el)) {
      if (p === 'position' && v === 'fixed') return true;
      if (p === 'top') return true;
    }

    if (isSpNavi(el)) {
      // ここは表示系だけ抑える。通常の内容描画は壊したくないので絞る
      if (p === 'display' && v !== 'none') return false;
    }

    return false;
  }

  function filterCssObject(el, obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;

    const filtered = {};
    for (const key of Object.keys(obj)) {
      if (!shouldBlockCssWrite(el, key, obj[key])) {
        filtered[key] = obj[key];
      }
    }
    return filtered;
  }

  function installJqueryPatch($) {
    if (!$ || !$.fn || !$.fn.css || $.fn.css.__berryPatched) return;

    const originalCss = $.fn.css;

    $.fn.css = function (name, value) {
      try {
        const firstEl = this && this[0];

        // setter: .css("prop", value)
        if (arguments.length === 2) {
          if (shouldBlockCssWrite(firstEl, name, value)) {
            return this;
          }
        }

        // setter: .css({ ... })
        if (arguments.length === 1 && name && typeof name === 'object' && !Array.isArray(name)) {
          const filtered = filterCssObject(firstEl, name);
          return originalCss.call(this, filtered);
        }
      } catch (_) {
        // 失敗時は元処理にフォールバック
      }

      return originalCss.apply(this, arguments);
    };

    $.fn.css.__berryPatched = true;
  }

  function forceSafeState() {
    const html = document.documentElement;
    const body = document.body;
    const home = document.querySelector('ul#home');
    const spNavi = document.getElementById('spNavi');

    if (html) {
      html.style.setProperty('overflow', 'auto', 'important');
      html.style.removeProperty('height');
    }

    if (body) {
      body.style.setProperty('overflow', 'auto', 'important');
    }

    if (home) {
      home.style.removeProperty('position');
      home.style.removeProperty('top');
      home.style.removeProperty('left');
      home.style.removeProperty('right');
      home.style.removeProperty('bottom');
      home.style.removeProperty('transform');
    }

    if (spNavi) {
      spNavi.style.setProperty('display', 'none', 'important');
      spNavi.style.setProperty('visibility', 'hidden', 'important');
      spNavi.style.setProperty('pointer-events', 'none', 'important');
    }
  }

  function injectStyle() {
    if (document.getElementById('berry-cityheaven-jq-block-style')) return;

    const style = document.createElement('style');
    style.id = 'berry-cityheaven-jq-block-style';
    style.textContent = `
      html { overflow: auto !important; }
      body { overflow: auto !important; }
      #spNavi {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function tryPatch() {
    if (patched) return true;

    const $ = window.jQuery || window.$;
    if (!$ || !$.fn || !$.fn.css) return false;

    installJqueryPatch($);
    patched = true;
    return true;
  }

  function boot() {
    injectStyle();
    tryPatch();
    forceSafeState();

    // jQuery の読込が遅い場合に備える
    const retryId = window.setInterval(() => {
      tryPatch();
      forceSafeState();

      if (patched) {
        window.clearInterval(retryId);
      }
    }, 50);

    // 念のため後追い補正も少しだけ残す
    window.setInterval(forceSafeState, 300);

    const mo = new MutationObserver(() => {
      tryPatch();
      forceSafeState();
    });

    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true, capture: true });
  } else {
    boot();
  }

  window.addEventListener('pageshow', () => {
    tryPatch();
    forceSafeState();
  }, true);
})();
