// ==UserScript==
// @name         Berry menu blocker
// @namespace    berry-workaround
// @version      1.0.2
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const MENU_LINK_ID = 'menu';
  const MENU_ICON_ID = 'spNaviBtn';

  let lastTouchTime = 0;
  let lastTouchX = -9999;
  let lastTouchY = -9999;
  let allowRealTapUntil = 0;
  let pageShownAt = Date.now();

  const BLOCK_AFTER_SHOW_MS = 2500;   // 表示直後の誤クリックをブロック
  const REAL_TAP_GRACE_MS   = 900;    // 実タップ後だけ許可
  const HIT_SLOP_PX         = 80;     // ボタン近傍なら本人操作扱い

  function now() {
    return Date.now();
  }

  function getMenuLink() {
    return document.getElementById(MENU_LINK_ID);
  }

  function getMenuIcon() {
    return document.getElementById(MENU_ICON_ID);
  }

  function getMenuTargetFromEventTarget(target) {
    if (!target || !(target instanceof Element)) return null;
    if (target.id === MENU_LINK_ID || target.id === MENU_ICON_ID) return target;
    const hit = target.closest('#menu, #spNaviBtn');
    return hit || null;
  }

  function rememberTouchPointFromTouchEvent(e) {
    const t = e.touches && e.touches[0];
    if (!t) return;
    lastTouchTime = now();
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;
  }

  function rememberTouchPointFromPointerEvent(e) {
    lastTouchTime = now();
    lastTouchX = e.clientX;
    lastTouchY = e.clientY;
  }

  function isTouchNearMenu() {
    const menu = getMenuLink();
    if (!menu) return false;
    const r = menu.getBoundingClientRect();
    return (
      lastTouchX >= r.left - HIT_SLOP_PX &&
      lastTouchX <= r.right + HIT_SLOP_PX &&
      lastTouchY >= r.top - HIT_SLOP_PX &&
      lastTouchY <= r.bottom + HIT_SLOP_PX
    );
  }

  function wasRecentRealTouch() {
    return (now() - lastTouchTime) <= REAL_TAP_GRACE_MS && isTouchNearMenu();
  }

  function blockEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  document.addEventListener('touchstart', function (e) {
    rememberTouchPointFromTouchEvent(e);
  }, true);

  document.addEventListener('pointerdown', function (e) {
    rememberTouchPointFromPointerEvent(e);
  }, true);

  document.addEventListener('pointerdown', function (e) {
  const target = getMenuTargetFromEventTarget(e.target);
  if (!target) return;

  const recentRealTouch = wasRecentRealTouch();
  if (!recentRealTouch) {
    blockEvent(e);
  }
  }, true);

  document.addEventListener('touchstart', function (e) {
    const target = getMenuTargetFromEventTarget(e.target);
    if (!target) return;
  
    const t = e.touches && e.touches[0];
    if (!t) {
      blockEvent(e);
      return;
    }
  
    const menu = getMenuLink();
    if (!menu) {
      blockEvent(e);
      return;
    }
  
    const r = menu.getBoundingClientRect();
    const near =
      t.clientX >= r.left - HIT_SLOP_PX &&
      t.clientX <= r.right + HIT_SLOP_PX &&
      t.clientY >= r.top - HIT_SLOP_PX &&
      t.clientY <= r.bottom + HIT_SLOP_PX;
  
    if (!near) {
      blockEvent(e);
    }
  }, true);

  document.addEventListener('click', function (e) {
    const target = getMenuTargetFromEventTarget(e.target);
    if (!target) return;

    if (wasRecentRealTouch()) {
      allowRealTapUntil = now() + 700;
      return;
    }

    const sinceShown = now() - pageShownAt;
    const temporarilyAllowed = now() <= allowRealTapUntil;

    if (sinceShown <= BLOCK_AFTER_SHOW_MS || !temporarilyAllowed) {
      blockEvent(e);
    }
  }, true);

  document.addEventListener('mousedown', function (e) {
    const target = getMenuTargetFromEventTarget(e.target);
    if (!target) return;

    if (!wasRecentRealTouch()) {
      blockEvent(e);
    }
  }, true);

  document.addEventListener('mouseup', function (e) {
    const target = getMenuTargetFromEventTarget(e.target);
    if (!target) return;

    if (!wasRecentRealTouch()) {
      blockEvent(e);
    }
  }, true);

  document.addEventListener('touchend', function (e) {
    const target = getMenuTargetFromEventTarget(e.target);
    if (!target) return;

    if (!wasRecentRealTouch()) {
      blockEvent(e);
    }
  }, true);

  // pageshow / 復帰 / 履歴移動対策
  window.addEventListener('pageshow', function () {
    pageShownAt = now();
    allowRealTapUntil = 0;
  }, true);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      pageShownAt = now();
      allowRealTapUntil = 0;
    }
  }, true);

  // 勝手に開いたメニューを閉じる保険
  function forceCloseIfOpenedUnexpectedly() {
    const menu = getMenuLink();
    if (!menu) return;

    const body = document.body;
    const html = document.documentElement;

    const suspiciousOpen =
      body.classList.contains('open') ||
      body.classList.contains('menu-open') ||
      body.classList.contains('drawer-open') ||
      html.classList.contains('open') ||
      html.classList.contains('menu-open') ||
      html.classList.contains('drawer-open') ||
      menu.getAttribute('aria-expanded') === 'true';

    if (!suspiciousOpen) return;
    if (wasRecentRealTouch()) return;

    // サイト側のトグルを逆クリックで戻す
    menu.click();
  }

  const mo = new MutationObserver(function () {
    forceCloseIfOpenedUnexpectedly();
  });

  document.addEventListener('DOMContentLoaded', function () {
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'aria-expanded', 'style']
    });
    setTimeout(forceCloseIfOpenedUnexpectedly, 300);
    setTimeout(forceCloseIfOpenedUnexpectedly, 800);
    setTimeout(forceCloseIfOpenedUnexpectedly, 1500);
  }, true);
  const oldMenu = document.getElementById('menu');
  if (oldMenu && !oldMenu.dataset.berryPatched) {
    const newMenu = oldMenu.cloneNode(true);
    newMenu.dataset.berryPatched = '1';
  
    newMenu.addEventListener('click', function (e) {
      if (!wasRecentRealTouch()) {
        blockEvent(e);
      }
    }, true);
  
    oldMenu.parentNode.replaceChild(newMenu, oldMenu);
  }
})();
