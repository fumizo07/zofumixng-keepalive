// ==UserScript==
// @name         Berry menu reset v2
// @version      4.0.0
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // jQueryが読み込まれたタイミングを監視
    let jqChecked = false;
    const observer = new MutationObserver(() => {
        if (!jqChecked && window.jQuery && window.jQuery.fn && window.jQuery.fn.css) {
            jqChecked = true;
            
            const originalCss = window.jQuery.fn.css;
            window.jQuery.fn.css = function(prop, value) {
                // htmlに height: 100vh が代入された瞬間を捕まえる
                if (
                    (this[0] && this[0].tagName === 'HTML' && prop === 'height' && value === '100vh') ||
                    (typeof prop === 'object' && prop.height === '100vh' && this[0] && this[0].tagName === 'HTML')
                ) {
                    console.warn("【調査用】メニュー展開処理が発火しました！スタックトレースを出力します。");
                    console.trace(); // 呼び出し元の履歴をコンソールに出力
                }
                return originalCss.apply(this, arguments);
            };
        }
    });

    observer.observe(document, { childList: true, subtree: true });
})();
