// ==UserScript==
// @name         Add One-Hand Gesture Button
// @version      2025.11.13
// @description  Tap to lower the screen & Flick left/right/bottom to go forward/back/Bottom of the page and Long press to hide
// @author       Zofumi
// @include      *://*/*
// @exclude      *://*.jpg
// @exclude      *://*.png
// @exclude      *://*.gif
// @exclude      *://*.gifv
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // --- iframe 内では動かさない（保険：@noframes も付けている） ---
  if (window !== window.parent) {
    return;
  }

  // --- すでにボタンがある場合は何もしない（匿名ビューなどの多重実行対策） ---
  if (document.getElementById('bottom-button')) {
    return;
  }

  // ===== ボタン生成 =====
  var button2 = document.createElement('button');
  button2.setAttribute('type', 'button');
  button2.setAttribute('id', 'bottom-button');
  button2.innerHTML = '&#8661;';

  document.body.appendChild(button2);

  // ===== ボタンのスタイル =====
  const button2Css = document.createElement('style');
  button2Css.textContent = `
#bottom-button {
  display: block !important;
  position: fixed !important;
  bottom: 10% !important;
  left: 50% !important;
  transform: translateX(-50%) !important;
  font-family: 'sans-serif' !important;
  font-size: 30px !important;
  font-weight: 500 !important;
  font-style: normal !important;
  color: #fff !important;
  background: rgba(0, 0, 0, 0.5) !important;
  box-sizing: border-box !important;
  border: 1px solid #ccc !important;
  border-radius: 50% !important;
  width: 40px !important;
  height: 40px !important;
  line-height: 40px !important;
  margin: 0 !important;
  padding: 0 !important;
  outline: 0 !important;
  vertical-align: baseline !important;
  quotes: none !important;
  text-decoration: none !important;
  letter-spacing: normal !important;
  user-select: none !important;
  z-index: 2147483647 !important;
}
#bottom-button::before, #bottom-button::after {
  content: none !important;
}
`;
  document.head.appendChild(button2Css);

  // ===== 画面下げ用のオーバーレイ CSS（衝突しにくいクラス名に変更） =====
  const htmlBottom = document.createElement('style');
  htmlBottom.textContent = `
/* 画面上部にかぶせるオーバーレイ（html.__onehand_reach__ が付いているときだけ有効） */
html.__onehand_reach__::before {
  background: #d7d7db;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 60vh;
  display: block;
  transition: height .5s;
  content: "";
  z-index: 2147483646 !important;
  pointer-events: none;
}

/* 「固定要素のうち、下げる対象」だけを動かす */
html.__onehand_reach__ .__onehand_fixed__ {
  top: 60vh !important;
}
`;
  document.head.appendChild(htmlBottom);

  // ===== クリックで「画面下げトグル」処理 =====
  button2.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const docEl = document.documentElement;
    docEl.classList.toggle('__onehand_reach__');

    // 名前空間オブジェクト（リセット用）
    window._ONEHAND_ = {
      reset: e => {
        if (!e || e.target.tagName !== 'HTML') return;
        docEl.classList.remove('__onehand_reach__');
        document
          .querySelectorAll('.__onehand_fixed__')
          .forEach(el => el.classList.remove('__onehand_fixed__'));
      },
    };

    // 画面上部の固定要素を一つ拾って下げる対象にする
    let f = document.elementFromPoint(0, 0);
    while (f) {
      if (f.tagName === 'BODY' || f.tagName === 'HTML') break;
      if (getComputedStyle(f).getPropertyValue('position') === 'fixed') {
        f.classList.add('__onehand_fixed__');
        break;
      }
      f = f.parentNode;
    }

    addEventListener('click', _ONEHAND_.reset);

    // 元コード互換：_ONEHAND_.apply が定義されていれば呼ぶ（定義されていない場合は何もしない）
    if (typeof _ONEHAND_.apply === 'function') {
      setTimeout(_ONEHAND_.apply, 10);
    }
  });

  // ===== フリック判定用の変数 =====
  var mouseDown = false;
  var thresholdX = 10;
  var thresholdY = 15;
  var position = null;
  var log = [];

  // ===== タッチ開始 =====
  button2.addEventListener('touchstart', function (e) {
    mouseDown = true;
    position = {
      x: e.touches[0].pageX - document.body.offsetLeft,
      y: e.touches[0].pageY - document.body.offsetTop,
    };
  });

  // ===== タッチ終了（フリック方向判定） =====
  button2.addEventListener('touchend', function () {
    mouseDown = false;

    if (log.length === 0) return;

    var prev = log[0];
    var moveX = 0;
    var moveY = 0;
    for (var i = 1; i < log.length; i++) {
      moveX += log[i].x - prev.x;
      moveY += log[i].y - prev.y;
    }

    // 左右フリック：戻る / 進む
    if (Math.abs(moveX) > thresholdX) {
      if (moveX > 0 && Math.abs(moveY) < thresholdY) {
        history.back();
      } else {
        history.forward();
      }
    }

    // 下方向フリック：ページ最下部へ
    if (Math.abs(moveY) > thresholdY) {
      if (moveY > 0 && Math.abs(moveX) < thresholdX) {
        var elm = document.documentElement;
        var bottom = elm.scrollHeight - elm.clientHeight;
        window.setTimeout(function () {
          window.scrollTo({ top: bottom, behavior: 'smooth' });
        }, 100);
      }
    }

    moveX = null;
    moveY = null;
    position = null;
    prev = null;
    log = [];
    log.length = 0;
  });

  // ===== タッチ移動中：座標ログを記録 =====
  button2.addEventListener('touchmove', function (e) {
    if (mouseDown !== true) return;
    let x = e.touches[0].pageX - document.body.offsetLeft;
    let y = e.touches[0].pageY - document.body.offsetTop;
    logPosition(x, y);
    e.preventDefault(); // 触ってる間スクロール禁止
  });

  function logPosition(x, y) {
    log.push({ x: x, y: y });
    if (log.length > 3) log.shift();
  }

  // ===== ロングタップでボタン非表示 =====
  var check_sec = 500; // ミリ秒

  long_press(button2, normal_func, long_func, check_sec);

  function normal_func() {
    return;
  }
  function long_func() {
    button2.remove();
  }

  function long_press(el, nf, lf, sec) {
    let longclick = false;
    let longtap = false;
    let touch = false;
    let timer;

    el.addEventListener('touchstart', () => {
      touch = true;
      longtap = false;
      timer = setTimeout(() => {
        longtap = true;
        lf();
      }, sec);
    });

    el.addEventListener('touchend', () => {
      if (!longtap) {
        clearTimeout(timer);
        nf();
      } else {
        touch = false;
      }
    });

    el.addEventListener('mousedown', () => {
      if (touch) return;
      longclick = false;
      timer = setTimeout(() => {
        longclick = true;
        lf();
      }, sec);
    });

    el.addEventListener('click', () => {
      if (touch) {
        touch = false;
        return;
      }
      if (!longclick) {
        clearTimeout(timer);
        nf();
      }
    });
  }
})();
