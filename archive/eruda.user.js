// ==UserScript==
// @name         eruda
// @version      0.10
// @description  Console for mobile browsers
// @author       kairusds
// @include      http://*
// @include      https://*
// @require      https://cdnjs.cloudflare.com/ajax/libs/eruda/3.2.2/eruda.min.js
// @icon         https://www.google.com/s2/favicons?domain=greasyfork.org
// @downloadURL  https://gist.githubusercontent.com/kairusds/d98aaf7af7cfeed5ae4d91493c0c89b0/raw/eruda.js
// @supportURL   https://github.com/fumizo07/zofumixng-keepalive/edit/main/archive/eruda.user.js
// @homepageURL  https://github.com/fumizo07/zofumixng-keepalive/edit/main/archive/eruda.user.js
// @run-at       document-body
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  // 保険
  if (window.top !== window.self) {
    return;
  }

  // すでに eruda のルートDOMがあるなら何もしない
  if (document.getElementById('eruda')) {
    return;
  }

  if (window.__ERUDA_INIT_CALLED__) {
    return;
  }
  
  try {
    eruda.init();
    window.__ERUDA_INIT_CALLED__ = true;
  } catch (e) {
    console.error('eruda.init() failed:', e);
  }

  // 初期化後、入口ボタンが取れるなら必要に応じて隠す（不要ならこのブロックは消してよい）
  const btn =
    window.eruda &&
    window.eruda._shadowRoot &&
    window.eruda._shadowRoot.querySelector('.eruda-entry-btn');

  if (btn) {
    // btn.style.display = 'none';
  }
})();

