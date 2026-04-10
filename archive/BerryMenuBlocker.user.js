// ==UserScript==
// @name         hide broken menu
// @namespace    berry-workaround
// @version      2.0.0
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  function applyKill() {
    const menu = document.getElementById('menu');
    const icon = document.getElementById('spNaviBtn');

    if (menu) {
      menu.removeAttribute('id');
      menu.removeAttribute('href');
      menu.setAttribute('href', 'javascript:void(0)');
      menu.style.pointerEvents = 'none';
      menu.style.touchAction = 'none';
      menu.onclick = null;
    }

    if (icon) {
      icon.removeAttribute('id');
      icon.style.pointerEvents = 'none';
      icon.onclick = null;
    }
  }

  function injectStyle() {
    if (document.getElementById('berryMenuKillStyle')) return;

    const style = document.createElement('style');
    style.id = 'berryMenuKillStyle';
    style.textContent = `
      /* 元のメニューボタン */
      .menu { pointer-events: none !important; }

      /* 開いたメニュー候補をまとめて潰す */
      #spNavi,
      #spNav,
      #globalNavi,
      #globalNav,
      .spNavi,
      .spNav,
      .globalNavi,
      .globalNav,
      .drawer,
      .drawerMenu,
      .menuWrap,
      .menu_open,
      .menu-open,
      .nav-open,
      .is-open {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        transform: none !important;
        pointer-events: none !important;
      }

      body.menu-open,
      body.nav-open,
      body.drawer-open,
      body.open,
      html.menu-open,
      html.nav-open,
      html.drawer-open,
      html.open {
        overflow: auto !important;
        position: static !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  const mo = new MutationObserver(() => {
    injectStyle();
    applyKill();
  });

  document.addEventListener('DOMContentLoaded', () => {
    injectStyle();
    applyKill();
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'class', 'style', 'href']
    });
  }, true);
})();
