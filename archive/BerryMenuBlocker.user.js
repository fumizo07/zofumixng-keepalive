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

  function resetSlideState() {
  const rootTargets = [document.documentElement, document.body].filter(Boolean);

  for (const el of rootTargets) {
    el.classList.remove('open', 'menu-open', 'nav-open', 'drawer-open', 'is-open');
    el.style.setProperty('overflow', 'auto', 'important');
    el.style.setProperty('position', 'static', 'important');
    el.style.setProperty('left', '0px', 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('margin-left', '0px', 'important');
    el.style.setProperty('transform', 'none', 'important');
  }

  const selectorCandidates = [
    '#wrapper', '#wrap', '#container', '#contents', '#content', '#main',
    '.wrapper', '.wrap', '.container', '.contents', '.content', '.main',
    '#page', '.page', '#sitewrap', '.sitewrap', '#app', '.app'
  ];

  const candidates = new Set();

  for (const sel of selectorCandidates) {
    for (const el of document.querySelectorAll(sel)) {
      candidates.add(el);
    }
  }

  for (const el of Array.from(document.body ? document.body.children : [])) {
    candidates.add(el);
  }

  const vw = window.innerWidth || document.documentElement.clientWidth || 0;

  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) continue;

    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    const transform = cs.transform;
    const left = parseFloat(cs.left) || 0;
    const marginLeft = parseFloat(cs.marginLeft) || 0;

    let tx = 0;
    if (transform && transform !== 'none') {
      const m2 = transform.match(/^matrix\((.+)\)$/);
      const m3 = transform.match(/^matrix3d\((.+)\)$/);

      if (m2) {
        const parts = m2[1].split(',').map(v => parseFloat(v.trim()));
        tx = parts[4] || 0;
      } else if (m3) {
        const parts = m3[1].split(',').map(v => parseFloat(v.trim()));
        tx = parts[12] || 0;
      }
    }

    const looksShifted =
      tx < -20 ||
      left < -20 ||
      marginLeft < -20 ||
      rect.left < -20;

    const looksMainContent =
      rect.width >= vw * 0.55 &&
      rect.height >= 120;

    if (looksShifted && looksMainContent) {
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('left', '0px', 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('margin-left', '0px', 'important');
      el.style.setProperty('translate', 'none', 'important');
      el.style.setProperty('transition', 'none', 'important');
      el.style.setProperty('width', 'auto', 'important');
      el.style.setProperty('max-width', '100%', 'important');
    }
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
      /* 左へ押し出された本文候補を戻す */
      #wrapper,
      #wrap,
      #container,
      #contents,
      #content,
      #main,
      .wrapper,
      .wrap,
      .container,
      .contents,
      .content,
      .main,
      #page,
      .page,
      #sitewrap,
      .sitewrap,
      #app,
      .app {
        transform: none !important;
        left: 0 !important;
        right: auto !important;
        margin-left: 0 !important;
        translate: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  const mo = new MutationObserver(() => {
    injectStyle();
    applyKill();
    resetSlideState();
  });

document.addEventListener('DOMContentLoaded', () => {
  injectStyle();
  applyKill();
  resetSlideState();

  setTimeout(resetSlideState, 100);
  setTimeout(resetSlideState, 400);
  setTimeout(resetSlideState, 1000);

  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['id', 'class', 'style', 'href']
  });
}, true);
})();
