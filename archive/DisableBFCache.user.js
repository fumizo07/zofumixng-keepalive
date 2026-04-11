// ==UserScript==
// @name         Disable BFCache
// @version      1.0.0
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 手法1: 空のunloadイベントを登録する（多くのChromium系ブラウザでBFCacheが無効化される仕様を利用）
    window.addEventListener('unload', function() {});

    // 手法2: BFCacheから復元された場合（persisted === true）は、強制的にリロードして状態をリセットする
    window.addEventListener('pageshow', function(event) {
        if (event.persisted) {
            window.location.reload();
        }
    });

})();
