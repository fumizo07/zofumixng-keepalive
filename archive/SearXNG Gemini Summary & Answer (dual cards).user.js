// ==UserScript==
// @name         SearXNG Gemini Answer + Summary (combined, zofumixng, sidebar always)
// @namespace    https://example.com/searxng-gemini-combined
// @version      0.9.5
// @description  SearXNG検索結果ページに「Gemini AIの回答」と「Geminiによる概要（上位サイト要約＋全体まとめ）」を表示（長文は折りたたみ対応、サイドバーがあれば常にサイドバー上部に配置）
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
    MODEL_NAME: 'gemini-2.0-flash',
    MAX_RESULTS: 20,
    SNIPPET_CHAR_LIMIT: 5000,

    SUMMARY_CACHE_KEY: 'GEMINI_SUMMARY_CACHE',
    SUMMARY_CACHE_LIMIT: 30,
    SUMMARY_CACHE_EXPIRE: 7 * 24 * 60 * 60 * 1000, // 7日

    // 429/503などの一時エラー対策（指数バックオフ＋再試行）
    RETRY_MAX: 5,
    RETRY_BASE_DELAY_MS: 700,
    RETRY_MAX_DELAY_MS: 12000,
    RETRY_JITTER_MS: 250,
    RETRY_ON_STATUS: [429, 500, 502, 503, 504],

    // 概要と回答を同時に叩くと429になりやすいので、概要だけ少し遅らせる
    SUMMARY_START_DELAY_MS: 400,

    // DOM待ち
    DOM_WAIT_MS: 5000
  };

  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // 32文字のランダム英数字推奨（共通鍵）※「秘匿」ではなく“難読化”程度です
  const FIXED_KEY = '1234567890abcdef1234567890abcdef';

  const log = {
    debug: (...a) => console.debug('[Gemini][DEBUG]', ...a),
    info:  (...a) => console.info('[Gemini][INFO]',  ...a),
    warn:  (...a) => console.warn('[Gemini][WARN]',  ...a),
    error: (...a) => console.error('[Gemini][ERROR]', ...a)
  };

  // ===== ユーティリティ =====
  function normalizeQuery(q) {
    return String(q || '')
      .trim()
      .toLowerCase()
      .replace(/[　]/g, ' ')
      .replace(/\s+/g, ' ');
  }

  const formatResponse = text =>
    String(text || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function calcBackoffDelay(attempt) {
    const base = CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(CONFIG.RETRY_MAX_DELAY_MS, base);
    const jitter = Math.floor(Math.random() * CONFIG.RETRY_JITTER_MS);
    return capped + jitter;
  }

  async function safeReadErrorText(resp) {
    try {
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json')) {
        const j = await resp.json();
        const msg = j?.error?.message || j?.message || JSON.stringify(j);
        return String(msg).slice(0, 240);
      }
      const t = await resp.text();
      return String(t).slice(0, 240);
    } catch {
      return '';
    }
  }

  async function fetchWithRetry(url, options, onStatusText = null) {
    let attempt = 0;
    while (true) {
      attempt++;
      let resp = null;

      try {
        resp = await fetch(url, options);
      } catch (e) {
        if (attempt <= CONFIG.RETRY_MAX) {
          const delay = calcBackoffDelay(attempt);
          if (typeof onStatusText === 'function') {
            onStatusText(`通信エラー…再試行(${attempt}/${CONFIG.RETRY_MAX})`);
          }
          await sleep(delay);
          continue;
        }
        throw e;
      }

      if (resp.ok) return resp;

      const status = resp.status;
      const retryable = CONFIG.RETRY_ON_STATUS.includes(status);

      if (retryable && attempt <= CONFIG.RETRY_MAX) {
        let delay = calcBackoffDelay(attempt);

        const ra = resp.headers.get('Retry-After');
        if (ra) {
          const raNum = Number(ra);
          if (!Number.isNaN(raNum) && raNum > 0) {
            delay = Math.min(CONFIG.RETRY_MAX_DELAY_MS, raNum * 1000);
          }
        }

        if (typeof onStatusText === 'function') {
          onStatusText(`APIエラー:${status} 再試行(${attempt}/${CONFIG.RETRY_MAX})`);
        }
        await sleep(delay);
        continue;
      }

      return resp;
    }
  }

  async function waitFor(selector, timeoutMs) {
    const first = document.querySelector(selector);
    if (first) return first;

    return await new Promise(resolve => {
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });

      setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

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

  function setupCollapsible(el, maxHeightPx = 260) {
    if (!el || !el.parentNode) return;
    requestAnimationFrame(() => {
      const fullHeight = el.scrollHeight;
      if (!fullHeight || fullHeight <= maxHeightPx + 10) return;

      el.style.maxHeight = maxHeightPx + 'px';
      el.style.overflow = 'hidden';
      el.style.position = el.style.position || 'relative';

      const toggle = document.createElement('button');
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

      let expanded = false;
      toggle.addEventListener('click', () => {
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
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return (
      btoa(String.fromCharCode(...iv)) +
      ':' +
      btoa(String.fromCharCode(...new Uint8Array(ct)))
    );
  }

  async function decrypt(cipher) {
    const [ivB64, ctB64] = String(cipher || '').split(':');
    if (!ivB64 || !ctB64) throw new Error('Cipher format invalid');
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
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
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
  async function showApiKeyModal() {
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
    overlay.style.zIndex = '2147483647';

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
        Google AI StudioでAPIキーを発行してください。<br>
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

    return await new Promise(resolve => {
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

  async function getApiKey(force = false) {
    if (force) {
      try { localStorage.removeItem('GEMINI_API_KEY'); } catch {}
    }

    let encrypted = null;
    try { encrypted = localStorage.getItem('GEMINI_API_KEY'); } catch {}

    if (encrypted) {
      try {
        const key = await decrypt(encrypted);
        if (key) return key;
      } catch (e) {
        log.warn('APIキー復号失敗:', e);
      }
    }

    const k = await showApiKeyModal();
    if (!k) return null;

    // 保存直後は軽くリロード（SearXNG側の状態も安定させる）
    setTimeout(() => location.reload(), 300);
    return k;
  }

  // ===== 共通化：Gemini API 呼び出し =====
  function geminiEndpoint(apiKey) {
    return `https://generativelanguage.googleapis.com/v1/models/${CONFIG.MODEL_NAME}:generateContent?key=${apiKey}`;
  }

  function buildGeminiRequestOptions(prompt) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    };
  }

  function extractGeminiText(data) {
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async function callGeminiText(apiKey, prompt, onStatusText = null) {
    const url = geminiEndpoint(apiKey);
    const resp = await fetchWithRetry(url, buildGeminiRequestOptions(prompt), onStatusText);

    if (!resp.ok) {
      const msg = await safeReadErrorText(resp);
      return { ok: false, status: resp.status, message: msg };
    }

    const data = await resp.json();
    const raw = extractGeminiText(data);
    return { ok: true, status: 200, raw };
  }

  // ===== UI =====
  function createAnswerBox(mainResults, sidebar) {
    const wrapper = document.createElement('div');
    wrapper.style.margin = '0 0 1em 0';

    wrapper.innerHTML = `
      <div style="
        border-radius:12px;
        padding:0.75em 1em;
        margin-bottom:0.5em;
        border:1px solid ${isDark ? '#555' : '#ddd'};
        background:${isDark ? '#111' : '#f9fafb'};
        font-family:inherit;
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4em;">
          <div style="font-weight:600;font-size:1em;display:flex;align-items:center;gap:0.5em;">
            <span>Gemini AI 回答</span>
            <button class="gemini-reset-key" type="button"
              style="border:none;background:none;cursor:pointer;font-size:0.85em;opacity:0.85;padding:0;">
              🔑キー再設定
            </button>
          </div>
          <span class="gemini-answer-status" style="font-size:0.8em;opacity:0.7;">準備中...</span>
        </div>
        <div class="gemini-answer-content" style="line-height:1.6;white-space:pre-wrap;"></div>
      </div>
    `;

    if (sidebar) sidebar.insertBefore(wrapper, sidebar.firstChild);
    else mainResults.parentNode.insertBefore(wrapper, mainResults);

    const contentEl = wrapper.querySelector('.gemini-answer-content');
    const statusEl = wrapper.querySelector('.gemini-answer-status');
    const resetBtn = wrapper.querySelector('.gemini-reset-key');

    resetBtn.addEventListener('click', async () => {
      statusEl.textContent = 'キー再設定...';
      await getApiKey(true);
      // getApiKey内でリロードされる想定
    });

    return { contentEl, statusEl, wrapper };
  }

  function createSummaryBox(sidebar, afterElement = null) {
    const aiBox = document.createElement('div');
    aiBox.innerHTML = `
      <div style="margin-top:1em;margin-bottom:0.5em;padding:0.5em;background:transparent;color:inherit;font-family:inherit;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5em;">
          <div style="font-weight:600;font-size:1em;">Geminiによる概要</div>
          <span class="gemini-summary-time" style="font-size:0.8em;opacity:0.7;"></span>
        </div>
        <div class="gemini-summary-content" style="margin-top:1.0em;margin-bottom:1.0em;line-height:1.5;">
          準備中...
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

  function renderSummaryFromJson(jsonData, contentEl, timeEl, cacheKey, summaryUrls) {
    if (!jsonData || typeof jsonData !== 'object') {
      contentEl.textContent = '概要を取得できませんでした。';
      return;
    }

    let html = '';

    if (Array.isArray(jsonData.sites) && jsonData.sites.length > 0) {
      html += '<section><h4>上位サイトの要約</h4><ol>';
      jsonData.sites.slice(0, 5).forEach((site, idx) => {
        const index = typeof site.index === 'number' ? site.index : idx + 1;
        let url = site.url || null;
        if (!url && Array.isArray(summaryUrls) && summaryUrls[index - 1]) {
          url = summaryUrls[index - 1];
        }

        let linkHtml = '';
        if (url) {
          try {
            const u = new URL(url);
            const domain = u.hostname.replace(/^www\./, '');
            linkHtml = ` <a href="${url}" target="_blank">${domain}</a>`;
          } catch {
            linkHtml = ` <a href="${url}" target="_blank">${url}</a>`;
          }
        }

        const summary = formatResponse(site.summary || '');
        html += `<li>${summary}${linkHtml}</li>`;
      });
      html += '</ol></section>';
    }

    if (jsonData.overall) {
      html += `<section><h4>全体のまとめ</h4><p>${formatResponse(jsonData.overall)}</p></section>`;
    }

    if (Array.isArray(jsonData.urls) && jsonData.urls.length > 0) {
      html += '<section><h4>参考リンク</h4><ul>';
      jsonData.urls.slice(0, 5).forEach(url => {
        try {
          const u = new URL(url);
          const domain = u.hostname.replace(/^www\./, '');
          html += `<li><a href="${url}" target="_blank">${domain}</a></li>`;
        } catch {
          html += `<li><a href="${url}" target="_blank">${url}</a></li>`;
        }
      });
      html += '</ul></section>';
    }

    if (!html) contentEl.textContent = '概要を取得できませんでした。';
    else {
      contentEl.innerHTML = html;
      setupCollapsible(contentEl, 260);
    }

    const now = new Date();
    const timeText = now.toLocaleString('ja-JP', { hour12: false });
    timeEl.textContent = timeText;

    const cache = getSummaryCache();
    if (!cache.keys.includes(cacheKey)) cache.keys.push(cacheKey);
    cache.data[cacheKey] = { html: contentEl.innerHTML, ts: Date.now(), time: timeText };
    setSummaryCache(cache);
  }

  function shouldExcludeFromSummary(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      if (host === 'weblio.jp' || host.endsWith('.weblio.jp')) return true;
      if (host === 'wikipedia.org' || host.endsWith('.wikipedia.org')) return true;
    } catch {}
    return false;
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
        const newResults = Array.from(doc.querySelectorAll('#main_results .result'))
          .slice(0, maxResults - currentResults);

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

  // ===== Gemini 呼び出し：概要 =====
  async function callGeminiSummary(apiKey, query, summarySnippets, summaryUrls, contentEl, timeEl, cacheKey) {
    const snippetCount = summarySnippets ? summarySnippets.split('\n\n').filter(Boolean).length : 0;

    const prompt = `
あなたは日本語で要約を行うアシスタントです。

【入力情報】
- 検索クエリ: ${query}
- 検索スニペット（1〜${snippetCount} が上位サイト）:
${summarySnippets}

【タスク】
1. スニペットのうち、1番〜${snippetCount}番を「上位サイト」とみなしてください（最大5件）。
2. それぞれのサイトについて、「そのページを見ると何が分かりそうか」を1〜3文程度で日本語で要約してください。
3. 最後に、「これら上位サイト全体から分かること」を短い日本語でまとめてください。
4. 出力は必ず次のJSON形式にしてください。

{
  "sites": [
    { "index": 1, "summary": "サイト1の要約（日本語）" }
  ],
  "overall": "上位サイト全体から分かることのまとめ（日本語）",
  "urls": ["URL1"]
}

【補足ルール】
- "sites" は1〜5件で構いません。
- "index" は必ず元の番号（1〜${snippetCount} のいずれか）を入れてください。
- マークダウン記法（# や * など）は使わないでください。
    `.trim();

    const r = await callGeminiText(apiKey, prompt, (t) => { contentEl.textContent = t; });
    if (!r.ok) {
      contentEl.textContent = `APIエラー: ${r.status}${r.message ? ` (${r.message})` : ''}`;
      return;
    }

    const raw = r.raw || '';
    let parsed = null;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    } catch {
      parsed = null;
    }

    if (parsed && (!Array.isArray(parsed.urls) || parsed.urls.length === 0)) {
      parsed.urls = summaryUrls.slice(0, 5);
    }

    if (!parsed || (!Array.isArray(parsed.sites) && !parsed.overall && !parsed.intro)) {
      contentEl.textContent = raw || '概要を取得できませんでした。';
      return;
    }

    renderSummaryFromJson(parsed, contentEl, timeEl, cacheKey, summaryUrls);
  }

  // ===== Gemini 呼び出し：回答 =====
  async function callGeminiAnswer(apiKey, query, snippets, answerEl, statusEl) {
    const prompt = `
あなたは日本語で回答するアシスタントです。
ユーザーのクエリ: ${query}

以下は検索スニペットです（必要な場合だけ参考にしてください。不要なら無視して構いません）:
${snippets}

【出力の方針】
- 前置きは書かず、いきなり本題から説明してください。
- できるだけ簡潔に、しかし要点は落とさないようにしてください。
- マークダウン記法（# や * など）は使わないでください。
    `.trim();

    const r = await callGeminiText(apiKey, prompt, (t) => { statusEl.textContent = t; });
    if (!r.ok) {
      statusEl.textContent = `APIエラー: ${r.status}`;
      answerEl.textContent = r.message ? r.message : '回答を取得できませんでした。';
      return;
    }

    const raw = r.raw || '回答を取得できませんでした。';
    answerEl.textContent = prettifyAnswer(raw);
    setupCollapsible(answerEl, 260);
    statusEl.textContent = '完了';
  }

  // ===== 例外表示（スマホで“無言死”を避ける） =====
  function showFatal(message, mainResults) {
    try {
      const box = document.createElement('div');
      box.style.border = `1px solid ${isDark ? '#884' : '#caa'}`;
      box.style.background = isDark ? '#221' : '#fff5f5';
      box.style.borderRadius = '12px';
      box.style.padding = '0.75em 1em';
      box.style.margin = '0 0 1em 0';
      box.style.whiteSpace = 'pre-wrap';
      box.textContent = `Gemini userscript error:\n${message}`;
      if (mainResults && mainResults.parentNode) {
        mainResults.parentNode.insertBefore(box, mainResults);
      } else {
        document.body.appendChild(box);
      }
    } catch {}
  }

  // ===== メイン =====
  try {
    const form = await waitFor('#search_form, form[action="/search"]', CONFIG.DOM_WAIT_MS);
    const sidebar = document.querySelector('#sidebar');
    const mainResults =
      (await waitFor('#main_results', CONFIG.DOM_WAIT_MS)) ||
      (await waitFor('#results, .results', CONFIG.DOM_WAIT_MS));

    if (!form || !mainResults) {
      log.info('SearXNG検索結果ページではないか、DOM構造が非対応/未生成です');
      return;
    }

    const qInput = document.querySelector('input[name="q"]');
    const query = qInput?.value?.trim() || new URL(location.href).searchParams.get('q') || '';
    if (!query) {
      log.info('検索クエリが空です');
      return;
    }

    // ★ UIは先に出す（キー問題でも欄は必ず表示）
    const { contentEl: answerEl, statusEl: answerStatusEl, wrapper: answerWrapper } =
      createAnswerBox(mainResults, sidebar);

    let summaryContentEl = null;
    let summaryTimeEl = null;
    if (sidebar) {
      const s = createSummaryBox(sidebar, answerWrapper);
      summaryContentEl = s.contentEl;
      summaryTimeEl = s.timeEl;
    }

    // キャッシュ表示（概要）
    const cacheKey = normalizeQuery(query);
    const cache = getSummaryCache();
    if (summaryContentEl && cache.data[cacheKey]) {
      const cached = cache.data[cacheKey];
      summaryContentEl.innerHTML = cached.html;
      summaryTimeEl.textContent = cached.time;
      setupCollapsible(summaryContentEl, 260);
      log.info('概要: キャッシュを使用:', query);
    }

    // APIキー取得（ここで失敗してもUIは残る）
    answerStatusEl.textContent = 'APIキー確認中...';
    const apiKey = await getApiKey(false);
    if (!apiKey) {
      answerStatusEl.textContent = 'APIキー未設定';
      answerEl.textContent = '🔑「キー再設定」からAPIキーを入力してください。';
      if (summaryContentEl) summaryContentEl.textContent = 'APIキー未設定';
      return;
    }

    // 検索結果収集
    answerStatusEl.textContent = '検索結果整理中...';
    const results = await fetchSearchResults(form, mainResults, CONFIG.MAX_RESULTS);
    const excludePatterns = [/google キャッシュ$/i];

    const snippetsArr = [];
    const urlList = [];
    let totalChars = 0;

    for (const r of results) {
      const snippetEl = r.querySelector('.result__snippet') || r;
      let text = snippetEl.innerText.trim();
      excludePatterns.forEach(p => { text = text.replace(p, '').trim(); });
      if (!text) continue;
      if (totalChars + text.length > CONFIG.SNIPPET_CHAR_LIMIT) break;

      snippetsArr.push(text);
      totalChars += text.length;

      const link = r.querySelector('a');
      if (link && link.href) urlList.push(link.href);
    }

    const snippets = snippetsArr.map((t, i) => `${i + 1}. ${t}`).join('\n\n');

    // 概要用（除外あり上位5）
    const summarySnippetsArr = [];
    const summaryUrls = [];
    for (let i = 0; i < snippetsArr.length && summarySnippetsArr.length < 5; i++) {
      const url = urlList[i] || '';
      if (shouldExcludeFromSummary(url)) continue;
      summarySnippetsArr.push(snippetsArr[i]);
      summaryUrls.push(url);
    }
    const summarySnippets = summarySnippetsArr.map((t, i) => `${i + 1}. ${t}`).join('\n\n');

    // 先に回答、概要は少し遅らせる
    callGeminiAnswer(apiKey, query, snippets, answerEl, answerStatusEl);

    if (summaryContentEl && !cache.data[cacheKey]) {
      if (summarySnippetsArr.length > 0) {
        setTimeout(() => {
          callGeminiSummary(apiKey, query, summarySnippets, summaryUrls, summaryContentEl, summaryTimeEl, cacheKey);
        }, CONFIG.SUMMARY_START_DELAY_MS);
      } else {
        summaryContentEl.textContent = '概要生成に利用できるサイトが見つかりませんでした。';
      }
    }
  } catch (e) {
    console.error(e);
    showFatal(String(e?.stack || e?.message || e), document.getElementById('main_results') || document.querySelector('#results, .results'));
  }
})();
