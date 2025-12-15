// ==UserScript==
// @name         SearXNG Gemini Answer + Summary (DIAG, zofumixng)
// @namespace    https://example.com/searxng-gemini-combined
// @version      0.9.2D
// @description  診断版：必ず画面左上にバッジを出し、例外/拒否理由をページ上に表示します
// @author       you
// @match        *://zofumixng.onrender.com/*
// @grant        none
// @license      MIT
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ===== 診断バッジ（最優先で出す）=====
  function createDiagBadge() {
    var b = document.createElement('div');
    b.id = 'gemini-diag-badge';
    b.style.position = 'fixed';
    b.style.top = '8px';
    b.style.left = '8px';
    b.style.zIndex = '2147483647';
    b.style.maxWidth = '92vw';
    b.style.padding = '6px 8px';
    b.style.borderRadius = '10px';
    b.style.fontSize = '12px';
    b.style.lineHeight = '1.35';
    b.style.whiteSpace = 'pre-wrap';
    b.style.wordBreak = 'break-word';
    b.style.background = 'rgba(0,0,0,0.78)';
    b.style.color = '#fff';
    b.style.fontFamily = 'monospace';
    b.textContent = 'Gemini DIAG: start';
    document.documentElement.appendChild(b);
    return b;
  }

  var BADGE = createDiagBadge();
  function badge(msg) {
    try { BADGE.textContent = 'Gemini DIAG: ' + msg; } catch (_) {}
  }

  window.addEventListener('error', function (ev) {
    try {
      var m = (ev && ev.message) ? ev.message : 'unknown error';
      var f = (ev && ev.filename) ? ev.filename.split('/').slice(-1)[0] : '';
      var l = (ev && ev.lineno) ? ev.lineno : '';
      badge('ERROR: ' + m + (f ? (' @' + f + ':' + l) : ''));
    } catch (_) {}
  });

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev && ev.reason;
      var m = (r && (r.message || String(r))) ? (r.message || String(r)) : 'unhandled rejection';
      badge('REJECTION: ' + m);
    } catch (_) {}
  });

  // ===== ここから本体（try/catchで必ず理由を出す）=====
  try {
    badge('phase 1: init');

    var CONFIG = {
      MODEL_NAME: 'gemini-2.0-flash',
      MAX_RESULTS: 20,
      SNIPPET_CHAR_LIMIT: 5000,
      SUMMARY_CACHE_KEY: 'GEMINI_SUMMARY_CACHE',
      SUMMARY_CACHE_LIMIT: 30,
      SUMMARY_CACHE_EXPIRE: 7 * 24 * 60 * 60 * 1000,
      RETRY_MAX: 5,
      RETRY_BASE_DELAY_MS: 700,
      RETRY_MAX_DELAY_MS: 12000,
      RETRY_JITTER_MS: 250,
      RETRY_ON_STATUS: [429, 500, 502, 503, 504],
      SUMMARY_START_DELAY_MS: 400
    };

    var isDark = false;
    try {
      isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (_) {}

    var FIXED_KEY = '1234567890abcdef1234567890abcdef';

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function normalizeQuery(q) {
      return String(q || '').trim().toLowerCase().replace(/[　]/g, ' ').replace(/\s+/g, ' ');
    }

    function prettifyAnswer(text) {
      if (!text) return '';
      var t = String(text).trim();
      var newlineCount = (t.match(/\n/g) || []).length;
      if (newlineCount === 0) t = t.replace(/(。|！|？)/g, '$1\n');
      t = t.replace(/\n{3,}/g, '\n\n');
      return t.trim();
    }

    function setupCollapsible(el, maxHeightPx) {
      if (!el || !el.parentNode) return;
      maxHeightPx = maxHeightPx || 260;
      requestAnimationFrame(function () {
        var fullHeight = el.scrollHeight;
        if (!fullHeight || fullHeight <= maxHeightPx + 10) return;

        el.style.maxHeight = maxHeightPx + 'px';
        el.style.overflow = 'hidden';

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.textContent = 'もっと見る';
        toggle.style.border = 'none';
        toggle.style.background = 'none';
        toggle.style.padding = '0';
        toggle.style.marginTop = '0.25em';
        toggle.style.cursor = 'pointer';
        toggle.style.fontSize = '0.85em';
        toggle.style.opacity = '0.8';
        toggle.style.float = 'right';

        var expanded = false;
        toggle.addEventListener('click', function () {
          expanded = !expanded;
          if (expanded) {
            el.style.maxHeight = 'none';
            el.style.overflow = 'visible';
            toggle.textContent = '閉じる';
          } else {
            el.style.maxHeight = maxHeightPx + 'px';
            el.style.overflow = 'hidden';
            toggle.textContent = 'もっと見る';
          }
        });

        el.parentNode.appendChild(toggle);
      });
    }

    // ===== AES-GCM（ここで失敗すると “crypto” がないブラウザ）=====
    async function encrypt(text) {
      var enc = new TextEncoder();
      var key = await crypto.subtle.importKey('raw', enc.encode(FIXED_KEY), 'AES-GCM', false, ['encrypt']);
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text));
      return btoa(String.fromCharCode.apply(null, Array.from(iv))) +
        ':' +
        btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(ct))));
    }

    async function decrypt(cipher) {
      var parts = String(cipher || '').split(':');
      var ivB64 = parts[0];
      var ctB64 = parts[1];
      var iv = Uint8Array.from(atob(ivB64), function (c) { return c.charCodeAt(0); });
      var ct = Uint8Array.from(atob(ctB64), function (c) { return c.charCodeAt(0); });
      var enc = new TextEncoder();
      var key = await crypto.subtle.importKey('raw', enc.encode(FIXED_KEY), 'AES-GCM', false, ['decrypt']);
      var decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
      return new TextDecoder().decode(decrypted);
    }

    function createAnswerBox(mainResults, sidebar) {
      var wrapper = document.createElement('div');
      wrapper.style.margin = '0 0 1em 0';

      wrapper.innerHTML = ''
        + '<div style="border-radius:12px;padding:0.75em 1em;margin-bottom:0.5em;'
        + 'border:1px solid ' + (isDark ? '#555' : '#ddd') + ';'
        + 'background:' + (isDark ? '#111' : '#f9fafb') + ';font-family:inherit;">'
        + '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em;">'
        + '    <div style="font-weight:600;font-size:1em;display:flex;align-items:center;gap:0.6em;">'
        + '      <span>Gemini AI 回答</span>'
        + '      <button class="gemini-reset-key" type="button"'
        + '        style="border:none;background:none;cursor:pointer;font-size:0.85em;opacity:0.85;padding:0;">'
        + '        🔑キー再設定'
        + '      </button>'
        + '    </div>'
        + '    <span class="gemini-answer-status" style="font-size:0.8em;opacity:0.7;">待機中...</span>'
        + '  </div>'
        + '  <div class="gemini-answer-content" style="line-height:1.6;white-space:pre-wrap;"></div>'
        + '</div>';

      if (sidebar) sidebar.insertBefore(wrapper, sidebar.firstChild);
      else mainResults.parentNode.insertBefore(wrapper, mainResults);

      return {
        wrapper: wrapper,
        contentEl: wrapper.querySelector('.gemini-answer-content'),
        statusEl: wrapper.querySelector('.gemini-answer-status'),
        resetBtn: wrapper.querySelector('.gemini-reset-key')
      };
    }

    async function getApiKey(force) {
      if (force) {
        try { localStorage.removeItem('GEMINI_API_KEY'); } catch (_) {}
      }

      var encrypted = null;
      try { encrypted = localStorage.getItem('GEMINI_API_KEY'); } catch (_) {}

      if (encrypted) {
        try {
          var k = await decrypt(encrypted);
          if (k) return k;
        } catch (e) {
          badge('phase key: decrypt failed -> ' + (e && e.message ? e.message : String(e)));
        }
      }

      // モーダル表示
      var overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.background = 'rgba(0,0,0,0.5)';
      overlay.style.display = 'flex';
      overlay.style.justifyContent = 'center';
      overlay.style.alignItems = 'center';
      overlay.style.zIndex = '2147483647';

      var modal = document.createElement('div');
      modal.style.background = isDark ? '#1e1e1e' : '#fff';
      modal.style.color = isDark ? '#fff' : '#000';
      modal.style.padding = '1.5em 2em';
      modal.style.borderRadius = '12px';
      modal.style.textAlign = 'center';
      modal.style.maxWidth = '480px';
      modal.style.boxShadow = '0 0 10px rgba(0,0,0,0.3)';
      modal.style.fontFamily = 'sans-serif';
      modal.innerHTML = ''
        + '<h2 style="margin-bottom:0.5em;">Gemini APIキー設定</h2>'
        + '<p style="font-size:0.9em;margin-bottom:1em;">'
        + 'Google AI StudioでAPIキーを発行してください。<br>'
        + '<a href="https://aistudio.google.com/app/apikey?hl=ja" target="_blank" style="color:#0078d4;text-decoration:underline;">'
        + 'Google AI Studio でAPIキーを発行'
        + '</a></p>'
        + '<input type="text" id="gemini-api-input" placeholder="APIキーを入力"'
        + ' style="width:90%;padding:0.5em;margin-bottom:1em;border:1px solid ' + (isDark ? '#555' : '#ccc') + ';'
        + ' border-radius:6px;background:' + (isDark ? '#333' : '#fafafa') + ';color:inherit;" />'
        + '<div style="display:flex;justify-content:space-between;gap:1em;max-width:260px;margin:0 auto;">'
        + '  <button id="gemini-save-btn" style="flex:1;background:#0078d4;color:#fff;border:none;padding:0.5em 1.2em;border-radius:8px;cursor:pointer;font-weight:bold;">保存</button>'
        + '  <button id="gemini-cancel-btn" style="flex:1;background:' + (isDark ? '#555' : '#ccc') + ';color:' + (isDark ? '#fff' : '#000') + ';border:none;padding:0.5em 1.2em;border-radius:8px;cursor:pointer;">キャンセル</button>'
        + '</div>';

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      return await new Promise(function (resolve) {
        overlay.querySelector('#gemini-save-btn').onclick = async function () {
          var val = overlay.querySelector('#gemini-api-input').value.trim();
          if (!val) { alert('APIキーが入力されていません。'); return; }
          try {
            var btn = overlay.querySelector('#gemini-save-btn');
            btn.disabled = true;
            btn.textContent = '保存中…';
            var enc = await encrypt(val);
            localStorage.setItem('GEMINI_API_KEY', enc);
            overlay.remove();
            resolve(val);
            setTimeout(function () { location.reload(); }, 500);
          } catch (e) {
            alert('暗号化に失敗しました');
            badge('encrypt failed -> ' + (e && e.message ? e.message : String(e)));
            var btn2 = overlay.querySelector('#gemini-save-btn');
            btn2.disabled = false;
            btn2.textContent = '保存';
          }
        };
        overlay.querySelector('#gemini-cancel-btn').onclick = function () {
          overlay.remove();
          resolve(null);
        };
      });
    }

    // ===== DOM検出（0.9.1と同じ）=====
    badge('phase 2: dom query');
    var form = document.querySelector('#search_form, form[action="/search"]');
    var sidebar = document.querySelector('#sidebar');
    var mainResults = document.getElementById('main_results') || document.querySelector('#results, .results');

    if (!form || !mainResults) {
      badge('phase 2 FAIL: form/mainResults not found');
      return;
    }

    var qInput = document.querySelector('input[name="q"]');
    var query = qInput && qInput.value ? qInput.value.trim() : '';
    if (!query) {
      badge('phase 2 FAIL: query empty');
      return;
    }

    // ★ UIは必ず出す
    badge('phase 3: create UI');
    var ui = createAnswerBox(mainResults, sidebar);
    ui.statusEl.textContent = 'APIキー確認中...';

    ui.resetBtn.addEventListener('click', async function () {
      ui.statusEl.textContent = 'キー再設定...';
      await getApiKey(true);
    });

    // ここまで来てUIが出ないなら「CSSで見えない」ではなく「実行されてない」です
    badge('phase 4: getApiKey');
    var apiKey = await getApiKey(false);
    if (!apiKey) {
      ui.statusEl.textContent = 'APIキー未設定';
      ui.contentEl.textContent = '🔑「キー再設定」からAPIキーを入力してください。';
      badge('DONE: no apiKey');
      return;
    }

    ui.statusEl.textContent = 'ここまでOK（APIキー取得済み）。次はAPI呼び出し部分の診断が必要です。';
    badge('DONE: UI shown + apiKey ok');

  } catch (e) {
    badge('FATAL: ' + (e && e.message ? e.message : String(e)));
  }
})();
