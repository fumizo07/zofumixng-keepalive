// ==UserScript==
// @name         Berry menu reset v2
// @version      4.0.5
// @match        *://*.cityheaven.net/*
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 直近に発生したイベントを記録する配列
    let recentEvents = [];
    function logEvent(e) {
        recentEvents.push(e.type);
        if(recentEvents.length > 5) recentEvents.shift(); // 直近5件を保持
    }

    // ページロード時やBerry Browser特有のUI起因で発火しそうなイベントを監視
    ['resize', 'pageshow', 'popstate', 'load', 'DOMContentLoaded', 'visibilitychange'].forEach(evt => {
        window.addEventListener(evt, logEvent, true);
    });

    // 画面にログを強制描画する関数
    let hasLogged = false;
    function showOverlayLog(triggerType, stackTrace) {
        if (hasLogged) return; // 連続で画面が埋まるのを防ぐ
        
        let overlay = document.getElementById('debug-overlay-123');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'debug-overlay-123';
            // 画面上部に黒背景・白文字で強制表示
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:50vh;background:rgba(0,0,0,0.9);color:#fff;z-index:2147483647;overflow-y:auto;font-size:11px;padding:10px;pointer-events:none;font-family:monospace;word-break:break-all;';
            
            if (document.body) {
                document.body.appendChild(overlay);
            } else if (document.documentElement) {
                document.documentElement.appendChild(overlay);
            }
        }
        
        overlay.innerHTML += '<div style="margin-bottom:10px;"><b style="color:#ff5555;">[検出] ' + triggerType + '</b></div>';
        overlay.innerHTML += '<div style="margin-bottom:10px;color:#55ff55;">直近のイベント: ' + recentEvents.join(' ➔ ') + '</div>';
        overlay.innerHTML += '<div style="color:#aaaaaa;">スタックトレース:</div>';
        overlay.innerHTML += '<pre style="white-space:pre-wrap;margin:5px 0;">' + stackTrace + '</pre><hr>';
        
        hasLogged = true;
    }

    // 手法1: ネイティブの setProperty API を直接フック
    const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function(prop, val, prio) {
        if ((prop === 'overflow' && val === 'hidden') || (prop === 'height' && val === '100vh')) {
            let stack = '';
            try { throw new Error(); } catch(err) { stack = err.stack || 'No stack trace'; }
            showOverlayLog('setProperty API経由', stack);
        }
        return origSetProperty.call(this, prop, val, prio);
    };

    // 手法2: MutationObserver で html の style 属性変更を監視 (プロパティ直代入対策)
    const observer = new MutationObserver(mutations => {
        for (let m of mutations) {
            if (m.target.nodeName === 'HTML' && m.attributeName === 'style') {
                const styleStr = m.target.getAttribute('style') || '';
                if (styleStr.includes('hidden') || styleStr.includes('100vh')) {
                    let stack = '';
                    try { throw new Error(); } catch(err) { stack = err.stack || 'No stack trace'; }
                    showOverlayLog('MutationObserverによる検知', stack);
                }
            }
        }
    });

    // ドキュメントツリーが準備でき次第、監視を開始
    const startObserver = () => {
        if (document.documentElement) {
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
        } else {
            setTimeout(startObserver, 10);
        }
    };
    startObserver();

})();
