// ==UserScript==
// @name         SearXNG Gemini Answer + Summary (combined, zofumixng, sidebar always)
// @namespace    https://example.com/searxng-gemini-combined
// @version      0.9.0
// @description  SearXNG検索結果ページに「Gemini AIの回答」と「Geminiによる概要（上位サイト要約＋全体まとめ）」を表示（サイドバーがあれば常にサイドバー上部に配置）
// @author       you
// @match        *://zofumixng.onrender.com/*
// @grant        none
// @license      MIT
// @run-at       document-end
// ==/UserScript==

(async () => {
  'use strict';

  // ===== 設定 =====
  const CONFIG = {
    MODEL_NAME: 'gemini-2.0-flash',        // いま安定している 2.0 を使用
    MAX_RESULTS: 20,
    SNIPPET_CHAR_LIMIT: 5000,
    SUMMARY_CACHE_KEY: 'GEMINI_SUMMARY_CACHE',
    SUMMARY_CACHE_LIMIT: 30,
    SUMMARY_CACHE_EXPIRE: 7 * 24 * 60 * 60 * 1000 // 7日
  };

  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // 32文字のランダム英数字推奨（共通鍵）
  const FIXED_KEY = '1234567890abcdef1234567890abcdef';

  const log = {
    debug: (...a) => console.debug('[Gemini][DEBUG]', ...a),
    info:  (...a) => console.info('[Gemini][INFO]',  ...a),
    warn:  (...a) => console.warn('[Gemini][WARN]',  ...a),
    error: (...a) => console.error('[Gemini][ERROR]', ...a)
  };

  function normalizeQuery(q) {
    return q
      .trim()
      .toLowerCase()
      .replace(/[　]/g, ' ')
      .replace(/\s+/g, ' ');
  }

  const formatResponse = text =>
    String(text || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // ===== 回答の軽い整形 =====
  function prettifyAnswer(text) {
    if (!text) return '';
    let t = String(text).trim();

    const newlineCount = (t.match(/\n/g) || []).length;
    if (newlineCount === 0) {
      t = t.replace(/(。|！|？)/g, '$1\n');
    }
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // ===== AES-GCM で API キー暗号化保存 =====
  async function encrypt(text) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(FIXED_KEY),
      'AES-GCM',
      false,
      ['encrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(text)
    );
    return (
      btoa(String.fromCharCode(...iv)) +
      ':' +
      btoa(String.fromCharCode(...new Uint8Array(ct)))
    );
  }

  async function decrypt(cipher) {
    const [ivB64, ctB64] = cipher.split(':');
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(FIXED_KEY),
      'AES-GCM',
      false,
      ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct
    );
    return new TextDecoder().decode(decrypted);
  }

  // ===== 概要キャッシュ =====
  function getSummaryCache() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CONFIG.SUMMARY_CACHE_KEY));
      return c && typeof c === 'object' ? c : { keys: [], data: {} };
    } catch {
      return { keys: [], data: {} };
    }
  }

  function setSummaryCache(cache) {
    const now = Date.now();
    cache.keys = cache.keys.filter(
      k => cache.data[k]?.ts && now - cache.data[k].ts <= CONFIG.SUMMARY_CACHE_EXPIRE
    );
    while (cache.keys.length > CONFIG.SUMMARY_CACHE_LIMIT) {
      delete cache.data[cache.keys.shift()];
    }
    sessionStorage.setItem(CONFIG.SUMMARY_CACHE_KEY, JSON.stringify(cache));
  }

  // ===== APIキー入力 UI =====
  async function getApiKey(force = false) {
    if (force) localStorage.removeItem('GEMINI_API_KEY');

    let encrypted = localStorage.getItem('GEMINI_API_KEY');
    let key = null;
    if (encrypted) {
      try {
        key = await decrypt(encrypted);
      } catch (e) {
        console.error('APIキー復号失敗', e);
      }
    }
    if (key) return key;

    // オーバーレイでキー入力
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'rgba(0,0,0,0.5)';
    overlay.style.display = 'flex';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    overlay.style.zIndex = '9999';

    const modal = document.createElement('div');
    modal.style.background = isDark ? '#1e1e1e' : '#fff';
    modal.style.color = isDark ? '#fff' : '#000';
    modal.style.padding = '1.5em 2em';
    modal.style.borderRadius = '12px';
    modal.style.textAlign = 'center';
    modal.style.maxWidth = '480px';
    modal.style.boxShadow = '0 0 10px rgba(0,0,0,0.3)';
    modal.style.fontFamily = 'sans-serif';
    modal.innerHTML = `
      <h2 style="margin-bottom:0.5em;">Gemini APIキー設定</h2>
      <p style="font-size:0.9em;margin-bottom:1em;">
        以下のリンクからGoogle AI StudioにアクセスしてAPIキーを発行してください。<br>
        <a href="https://aistudio.google.com/app/apikey?hl=ja" target="_blank"
           style="color:#0078d4;text-decoration:underline;">
          Google AI Studio でAPIキーを発行
        </a>
      </p>
      <input type="text" id="gemini-api-input" placeholder="APIキーを入力"
        style="width:90%;padding:0.5em;margin-bottom:1em;
               border:1px solid ${isDark ? '#555' : '#ccc'};
               border-radius:6px;
               background:${isDark ? '#333' : '#fafafa'};
               color:inherit;"/>
      <div style="display:flex;justify-content:space-between;gap:1em;max-width:260px;margin:0 auto;">
        <button id="gemini-save-btn"
          style="flex:1;background:#0078d4;color:#fff;border:none;
                 padding:0.5em 1.2em;border-radius:8px;cursor:pointer;font-weight:bold;">
          保存
        </button>
        <button id="gemini-cancel-btn"
          style="flex:1;background:${isDark ? '#555' : '#ccc'};
                 color:${isDark ? '#fff' : '#000'};
                 border:none;padding:0.5em 1.2em;border-radius:8px;cursor:pointer;">
          キャンセル
        </button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    return new Promise(resolve => {
      overlay.querySelector('#gemini-save-btn').onclick = async () => {
        const val = overlay.querySelector('#gemini-api-input').value.trim();
        if (!val) {
          alert('APIキーが入力されていません。');
          return;
        }
        try {
          const btn = overlay.querySelector('#gemini-save-btn');
          btn.disabled = true;
          btn.textContent = '保存中…';
          const enc = await encrypt(val);
          localStorage.setItem('GEMINI_API_KEY', enc);
          overlay.remove();
          resolve(val);
          setTimeout(() => location.reload(), 500);
        } catch (e) {
          alert('暗号化に失敗しました');
          console.error(e);
          const btn = overlay.querySelector('#gemini-save-btn');
          btn.disabled = false;
          btn.textContent = '保存';
        }
      };
      overlay.querySelector('#gemini-cancel-btn').onclick = () => {
        overlay.remove();
        resolve(null);
      };
    });
  }

  // ===== 検索結果取得（ページ跨ぎ対応） =====
  async function fetchSearchResults(form, mainResults, maxResults) {
    let results = Array.from(mainResults.querySelectorAll('.result'));
    let currentResults = results.length;
    let pageNo = parseInt(new FormData(form).get('pageno') || 1, 10);

    async function fetchNextPage() {
      if (currentResults >= maxResults) return [];
      pageNo++;
      const formData = new FormData(form);
      formData.set('pageno', pageNo);
      try {
        const resp = await fetch(form.action, { method: 'POST', body: formData });
        const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
        const newResults = Array.from(
          doc.querySelectorAll('#main_results .result')
        ).slice(0, maxResults - currentResults);
        currentResults += newResults.length;
        if (currentResults < maxResults && newResults.length > 0) {
          const nextResults = await fetchNextPage();
          return newResults.concat(nextResults);
        }
        return newResults;
      } catch (e) {
        log.error('検索結果取得エラー:', e);
        return [];
      }
    }

    const additionalResults = await fetchNextPage();
    results.push(...additionalResults);
    return results.slice(0, maxResults);
  }

  // ===== サマリ UI 作成 =====
  function createSummaryBox(sidebar, afterElement = null) {
    const aiBox = document.createElement('div');
    aiBox.innerHTML = `
      <div style="margin-top:1em;margin-bottom:0.5em;padding:0.5em;
                  background:transparent;color:inherit;font-family:inherit;">
        <div style="display:flex;justify-content:space-between;
                    align-items:center;margin-bottom:0.5em;">
          <div style="font-weight:600;font-size:1em;">Geminiによる概要</div>
          <span class="gemini-summary-time"
                style="font-size:0.8em;opacity:0.7;"></span>
        </div>
        <div class="gemini-summary-content"
             style="margin-top:1.0em;margin-bottom:1.0em;line-height:1.5;">
          取得中...
        </div>
      </div>
    `;
    if (afterElement && afterElement.parentNode === sidebar) {
      sidebar.insertBefore(aiBox, afterElement.nextSibling);
    } else {
      sidebar.insertBefore(aiBox, sidebar.firstChild);
    }
    const contentEl = aiBox.querySelector('.gemini-summary-content');
    const timeEl = aiBox.querySelector('.gemini-summary-time');
    return { contentEl, timeEl };
  }

  // ===== 回答 UI 作成 =====
  function createAnswerBox(mainResults, sidebar) {
    const wrapper = document.createElement('div');
    wrapper.style.margin = '0 0 1em 0';

    wrapper.innerHTML = `
      <div style="
