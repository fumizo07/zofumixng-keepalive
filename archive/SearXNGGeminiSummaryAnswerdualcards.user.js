// ==UserScript==
// @name         SearXNG Gemini Answer + Summary (combined, zofumixng, sidebar always)
// @namespace    https://example.com/searxng-gemini-combined
// @version      0.9.1.2
// @description  0.9.1互換＋🔑キー再設定ボタン（最小変更）
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

  // ★ 追加：Gemini API URL を共通化（挙動は0.9.1と同じ）
  const geminiUrl = (apiKey) =>
    `https://generativelanguage.googleapis.com/v1/models/${CONFIG.MODEL_NAME}:generateContent?key=${apiKey}`;

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

  // ===== 長文折りたたみ（もっと見る / 閉じる） =====
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

    // ★ 追加：🔑キー再設定ボタン（UI以外の挙動は触らない）
    wrapper.innerHTML = `
      <div style="
        border-radius:12px;
        padding:0.75em 1em;
        margin-bottom:0.5em;
        border:1px solid ${isDark ? '#555' : '#ddd'};
        background:${isDark ? '#111' : '#f9fafb'};
        font-family:inherit;
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;
                    margin-bottom:0.4em;">
          <div style="font-weight:600;font-size:1em;display:flex;align-items:center;gap:0.6em;">
            <span>Gemini AI 回答</span>
            <button class="gemini-reset-key" type="button"
              style="border:none;background:none;cursor:pointer;font-size:0.85em;opacity:0.85;padding:0;">
              🔑キー再設定
            </button>
          </div>
          <span class="gemini-answer-status"
                style="font-size:0.8em;opacity:0.7;">問い合わせ中...</span>
        </div>
        <div class="gemini-answer-content"
             style="line-height:1.6;white-space:pre-wrap;"></div>
      </div>
    `;
    if (sidebar) {
      sidebar.insertBefore(wrapper, sidebar.firstChild);
    } else {
      mainResults.parentNode.insertBefore(wrapper, mainResults);
    }
    const contentEl = wrapper.querySelector('.gemini-answer-content');
    const statusEl = wrapper.querySelector('.gemini-answer-status');
    const resetBtn = wrapper.querySelector('.gemini-reset-key');
    return { contentEl, statusEl, wrapper, resetBtn };
  }

  // ===== 概要レンダリング =====
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

    if (!html) {
      contentEl.textContent = '概要を取得できませんでした。';
    } else {
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

  // ===== Gemini 呼び出し：概要 =====
  async function callGeminiSummary(apiKey, query, summarySnippets, summaryUrls, contentEl, timeEl, cacheKey) {
    const snippetCount = summarySnippets
      ? summarySnippets.split('\n\n').filter(Boolean).length
      : 0;

    const prompt = `
あなたは日本語で要約を行うアシスタントです。

【入力情報】
- 検索クエリ: ${query}
- 検索スニペット（1〜${snippetCount} が上位サイト）:
${summarySnippets}

【タスク】
1. スニペットのうち、1番〜${snippetCount}番を「上位サイト」とみなしてください（最大5件）。
2. それぞれのサイトについて、「そのページを見ると何が分かりそうか」を
   1〜3文程度で日本語で要約してください（サイトの主な主張・テーマなど）。
3. 最後に、「これら上位サイト全体から分かること」を、短い日本語の文章でまとめてください。
4. 出力は必ず次のJSON形式にしてください。

{
  "sites": [
    { "index": 1, "summary": "サイト1の要約（日本語）" }
  ],
  "overall": "上位サイト全体から分かることのまとめ（日本語）",
  "urls": ["URL1"]
}

【補足ルール】
- マークダウン記法（# や * など）は使わないでください。
    `.trim();

    try {
      const resp = await fetch(geminiUrl(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (!resp.ok) {
        contentEl.textContent = `APIエラー: ${resp.status}`;
        return;
      }
      const data = await resp.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

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
    } catch (e) {
      contentEl.textContent = '通信に失敗しました';
      log.error(e);
    }
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
- 内容はできるだけ簡潔に、しかし要点は落とさないようにします。
- マークダウン記法（# や * など）は使わないでください。
    `.trim();

    try {
      const resp = await fetch(geminiUrl(apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (!resp.ok) {
        statusEl.textContent = `APIエラー: ${resp.status}`;
        return;
      }
      const data = await resp.json();
      const raw =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        '回答を取得できませんでした。';
      const pretty = prettifyAnswer(raw);
      answerEl.textContent = pretty;
      setupCollapsible(answerEl, 260);
      statusEl.textContent = '完了';
    } catch (e) {
      statusEl.textContent = '通信エラー';
      log.error(e);
    }
  }

  // ===== メイン処理 =====
  const form = document.querySelector('#search_form, form[action="/search"]');
  const sidebar = document.querySelector('#sidebar');
  const mainResults =
    document.getElementById('main_results') ||
    document.querySelector('#results, .results');

  if (!form || !mainResults) {
    log.info('SearXNG検索結果ページではないか、DOM構造が非対応です');
    return;
  }

  const qInput = document.querySelector('input[name="q"]');
  const query = qInput?.value?.trim();
  if (!query) {
    log.info('検索クエリが空です');
    return;
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    log.warn('APIキー未設定のため処理を終了します');
    return;
  }

  const {
    contentEl: answerEl,
    statusEl: answerStatusEl,
    wrapper: answerWrapper,
    resetBtn
  } = createAnswerBox(mainResults, sidebar);

  // ★ 追加：キー再設定（キー削除→リロード）
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      try { localStorage.removeItem('GEMINI_API_KEY'); } catch {}
      setTimeout(() => location.reload(), 50);
    });
  }

  let summaryContentEl = null;
  let summaryTimeEl = null;
  if (sidebar) {
    const s = createSummaryBox(sidebar, answerWrapper);
    summaryContentEl = s.contentEl;
    summaryTimeEl = s.timeEl;
  }

  const cacheKey = normalizeQuery(query);
  const cache = getSummaryCache();
  if (summaryContentEl && cache.data[cacheKey]) {
    const cached = cache.data[cacheKey];
    summaryContentEl.innerHTML = cached.html;
    summaryTimeEl.textContent = cached.time;
    setupCollapsible(summaryContentEl, 260);
    log.info('概要: キャッシュを使用:', query);
  }

  const results = await fetchSearchResults(form, mainResults, CONFIG.MAX_RESULTS);
  const excludePatterns = [/google キャッシュ$/i];

  const snippetsArr = [];
  const urlList = [];
  let totalChars = 0;

  for (const r of results) {
    const snippetEl = r.querySelector('.result__snippet') || r;
    let text = snippetEl.innerText.trim();
    excludePatterns.forEach(p => {
      text = text.replace(p, '').trim();
    });
    if (!text) continue;
    if (totalChars + text.length > CONFIG.SNIPPET_CHAR_LIMIT) break;
    snippetsArr.push(text);
    totalChars += text.length;

    const link = r.querySelector('a');
    if (link && link.href) {
      urlList.push(link.href);
    }
  }

  const snippets = snippetsArr.map((t, i) => `${i + 1}. ${t}`).join('\n\n');

  const summarySnippetsArr = [];
  const summaryUrls = [];
  for (let i = 0; i < snippetsArr.length && summarySnippetsArr.length < 5; i++) {
    const url = urlList[i] || '';
    if (shouldExcludeFromSummary(url)) continue;
    summarySnippetsArr.push(snippetsArr[i]);
    summaryUrls.push(url);
  }
  const summarySnippets = summarySnippetsArr
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n\n');

  if (summaryContentEl && !cache.data[cacheKey]) {
    if (summarySnippetsArr.length > 0) {
      callGeminiSummary(
        apiKey,
        query,
        summarySnippets,
        summaryUrls,
        summaryContentEl,
        summaryTimeEl,
        cacheKey
      );
    } else {
      summaryContentEl.textContent = '概要生成に利用できるサイトが見つかりませんでした。';
    }
  }

  callGeminiAnswer(apiKey, query, snippets, answerEl, answerStatusEl);
})();
