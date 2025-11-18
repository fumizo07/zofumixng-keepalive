// ==UserScript==
// @name        SearXNG Gemini Answer + Summary (combined, zofumixng, sidebar always)
// @namespace   https://example.com/searxng-gemini-combined
// @version     0.5.0
// @description SearXNG検索結果ページに「Gemini AIの回答」と「Geminiによる概要」を両方表示する統合スクリプト（サイドバーがあれば常にサイドバー上部に配置）
// @author      you
// @match       *://zofumixng.onrender.com/*
// @grant       none
// @license     MIT
// @run-at      document-end
// ==/UserScript==

(async () => {
  'use strict';

  // ===== 設定 =====
  const CONFIG = {
    MODEL_NAME: 'gemini-2.5-flash',        // ★最新の Flash 系モデル
    MAX_RESULTS: 20,                       // 最大取得件数（重い場合は 10 などに）
    SNIPPET_CHAR_LIMIT: 5000,              // スニペットの総文字数上限
    SUMMARY_CACHE_KEY: 'GEMINI_SUMMARY_CACHE',
    SUMMARY_CACHE_LIMIT: 30,               // キャッシュするクエリ数
    SUMMARY_CACHE_EXPIRE: 7 * 24 * 60 * 60 * 1000 // キャッシュ期限(ms) 7日
  };

  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // 32文字のランダム英数字に変えることを推奨（ここを共通鍵として暗号化に使用）
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
      .replace(/[ ]/g, ' ')
      .replace(/\s+/g, ' ');
  }

  const formatResponse = text => text.replace(/\*\*(.+?)\*\*/g, '$1');

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
    // 期限切れ掃除
    cache.keys = cache.keys.filter(
      k => cache.data[k]?.ts && now - cache.data[k].ts <= CONFIG.SUMMARY_CACHE_EXPIRE
    );
    // 上限超えたら古い順に削除
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
      <h2 style="margin-top:0;">Gemini APIキー設定</h2>
      <p style="font-size:0.9em; line-height:1.6;">
        以下のリンクからGoogle AI StudioにアクセスしてAPIキーを発行してください。<br>
        <a href="https://aistudio.google.com" target="_blank" rel="noopener" style="color:#4a8af4;">
          Google AI Studio でAPIキーを発行
        </a>
      </p>
      <input id="gemini-api-input" type="password"
        placeholder="AI Studio で取得した API キー"
        style="width:100%; padding:0.5em; margin:0.5em 0 1em; font-size:1em;"/>
      <div style="display:flex; gap:0.5em; justify-content:flex-end;">
        <button id="gemini-cancel-btn" style="padding:0.4em 0.9em;">キャンセル</button>
        <button id="gemini-save-btn" style="padding:0.4em 0.9em;">保存</button>
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
        const resp = await fetch(form.action, {
          method: 'POST',
          body: formData
        });
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
  // afterElement が指定されている場合は、その直後に挿入
  function createSummaryBox(sidebar, afterElement = null) {
    const aiBox = document.createElement('div');
    aiBox.innerHTML = `
      <div class="box">
        <h3>Geminiによる概要</h3>
        <div class="gemini-summary-content">取得中...</div>
        <div class="gemini-summary-time" style="font-size:0.8em;opacity:0.7;margin-top:0.3em;"></div>
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
  // サイドバーがあれば必ずサイドバー先頭、なければメインカラム上部
  function createAnswerBox(mainResults, sidebar) {
    const wrapper = document.createElement('div');
    wrapper.style.margin = '0 0 1em 0';
    wrapper.innerHTML = `
      <div class="box">
        <h3>Gemini AI 回答</h3>
        <div class="gemini-answer-content">問い合わせ中...</div>
        <div class="gemini-answer-status" style="font-size:0.8em;opacity:0.7;margin-top:0.3em;"></div>
      </div>
    `;

    if (sidebar) {
      sidebar.insertBefore(wrapper, sidebar.firstChild);
    } else {
      mainResults.parentNode.insertBefore(wrapper, mainResults);
    }

    const contentEl = wrapper.querySelector('.gemini-answer-content');
    const statusEl = wrapper.querySelector('.gemini-answer-status');
    return { contentEl, statusEl, wrapper };
  }

  // ===== 概要レンダリング =====
  function renderSummaryFromJson(jsonData, contentEl, timeEl, cacheKey) {
    if (!jsonData) {
      contentEl.textContent = '無効な応答';
      return;
    }

    let html = '';

    if (jsonData.intro) {
      html += `<p>${formatResponse(jsonData.intro)}</p>\n`;
    }

    if (Array.isArray(jsonData.sections)) {
      jsonData.sections.forEach(sec => {
        if (sec.title && Array.isArray(sec.content)) {
          html += `<h4>${sec.title}</h4>\n<ul>\n`;
          sec.content.forEach(item => {
            html += `  <li>${formatResponse(item)}</li>\n`;
          });
          html += `</ul>\n`;
        }
      });
    }

    if (Array.isArray(jsonData.urls) && jsonData.urls.length > 0) {
      html += `<h4>出典</h4>\n<ul>\n`;
      jsonData.urls.slice(0, 5).forEach(url => { // ★最大5件まで表示
        try {
          const u = new URL(url);
          const domain = u.hostname.replace(/^www\./, '');
          html += `  <li><a href="${url}" target="_blank" rel="noopener noreferrer">${domain}</a></li>\n`;
        } catch {
          html += `  <li>${url}</li>\n`;
        }
      });
      html += `</ul>\n`;
    }

    contentEl.innerHTML = html;

    const now = new Date();
    const timeText = now.toLocaleString('ja-JP', { hour12: false });
    timeEl.textContent = timeText;

    const cache = getSummaryCache();
    if (!cache.keys.includes(cacheKey)) cache.keys.push(cacheKey);
    cache.data[cacheKey] = { html, ts: Date.now(), time: timeText };
    setSummaryCache(cache);
  }

  // ===== クエリ分類 =====
  function classifyQuery(query) {
    const s = (query || '').trim();
    if (/レシピ|作り方|作る方法|作成方法/i.test(s)) return 'recipe';
    if (/旅行|観光|治安|ビザ|入国|渡航|ツアー/i.test(s)) return 'travel';
    return 'general';
  }

  // ===== Gemini 呼び出し：概要 =====
  async function callGeminiSummary(apiKey, query, snippets, urls, contentEl, timeEl, cacheKey) {
    const urlListText =
      Array.isArray(urls) && urls.length
        ? urls.map((u, i) => `[${i + 1}] ${u}`).join('\n')
        : '(URLなし)';

    const prompt = `
検索クエリ: ${query}

以下は、このクエリに対するウェブ検索結果の上位サイト（最大${Array.isArray(urls) ? urls.length : 0}件）のスニペットとURLです。

【スニペット一覧】
${snippets}

【URL一覧】
${urlListText}

指示:
1. 上記のスニペットを元に、これら上位サイト全体に共通する内容を日本語で3〜5文にまとめてください。
2. 情報が不足する場合は「情報が限られています」と明示し、推測する場合は推測であると分かるように書いてください。
3. 概要は600字以内としてください。
4. 出力は必ず次のJSON形式にしてください。

{
  "intro": "概要の導入文（1〜2文）",
  "sections": [
    { "title": "セクションタイトル", "content": ["内容1", "内容2"] }
  ],
  "urls": ["URL1", "URL2", "URL3"]
}

制約:
- urls には、【URL一覧】に含まれるURLだけをそのまま入れてください。新しいURLを作成しないでください。
- urls の件数は1〜5件程度としてください。
`.trim();

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${CONFIG.MODEL_NAME}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );
      if (!resp.ok) {
        contentEl.textContent = `APIエラー: ${resp.status}`;
        return;
      }

      const data = await resp.json();
      let parsed = {};
      try {
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const match = raw.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : {};
      } catch (e) {
        contentEl.textContent = 'JSON解析失敗';
        return;
      }

      // URLが空なら検索結果URLから補完（最大5件）
      if (!Array.isArray(parsed.urls) || parsed.urls.length === 0) {
        parsed.urls = Array.isArray(urls) ? urls.slice(0, 5) : [];
      }

      renderSummaryFromJson(parsed, contentEl, timeEl, cacheKey);
    } catch (e) {
      contentEl.textContent = '通信に失敗しました';
      log.error(e);
    }
  }

  // ===== Gemini 呼び出し：回答 =====
  async function callGeminiAnswer(apiKey, query, snippets, answerEl, statusEl) {
    const mode = classifyQuery(query);

    let prompt;

    if (mode === 'recipe') {
      // レシピ系
      prompt = `
あなたは日本人家庭向けの料理研究家です。
ユーザーのクエリ: ${query}

以下は検索結果から抜き出したスニペットです（必要に応じて参照してください）:
${snippets}

指示:
1. 「${query}」という料理について、家庭で再現できるレシピを日本語で詳しく説明してください。
2. 出力には、次の内容をこの順番で必ず含めてください。
   完成イメージ（どんな味・見た目かを1〜2文）
   材料（2人分を想定し、分量をg・ml・大さじ・小さじなどで具体的に）
   作り方（番号付きの手順。各ステップに火加減と時間の目安を含める）
   アレンジ・応用（具材の代用や味変のアイデア）
   失敗しやすいポイントと対策
3. マークダウンの見出しや箇条書き記号（#, -, *）は使わず、通常のテキストだけで書いてください。
4. 長くなっても構いませんが、読みやすいように段落を分けてください。
`.trim();
    } else if (mode === 'travel') {
      // 旅行／国情報系
      prompt = `
あなたは日本人旅行者向けのガイドです。
ユーザーのクエリ: ${query}

以下は検索結果から抜き出したスニペットです（必要に応じて参照してください）:
${snippets}

指示:
1. 「${query}」で示される国・地域または都市について、日本語で詳しく説明してください。
2. 出力には、次の項目をこの順番で必ず含めてください。
   基本情報（場所、首都または代表的な都市、規模、気候）
   治安（比較的安全なエリアと注意が必要な点）
   物価感覚（日本と比べて高いか安いかの目安）
   ビザや入国の一般的な目安（日本国籍の短期滞在の場合の傾向）
   初めての旅行者におすすめのエリアや観光スポット
   旅行時の注意点（詐欺、スリ、服装、マナーなど）
   最後に「実際に渡航する際は最新の公式情報を必ず確認してください。」という内容の一文
3. マークダウンの見出しや箇条書き記号（#, -, *）は使わず、通常のテキストだけで書いてください。
4. 全体で800〜1200文字程度を目安にしてください。
`.trim();
    } else {
      // 一般用語・サービス名など
      prompt = `
あなたは日本語でわかりやすく解説する専門家です。
ユーザーのクエリ: ${query}

以下は検索結果から抜き出したスニペットです（必要に応じて参照してください）:
${snippets}

指示:
1. 「${query}」について、日本語で解説してください。
2. 出力には、次の内容を含めてください。
   一言でいうと（30〜60文字程度）
   詳しい解説（2〜3段落）
   利点・メリット
   注意点・よくある誤解
   さらに調べるときの関連キーワード（日本語で3〜5個）
3. マークダウンの見出しや箇条書き記号（#, -, *）は使わず、通常のテキストだけで書いてください。
4. 全体で500〜900文字程度を目安にしてください。
`.trim();
    }

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${CONFIG.MODEL_NAME}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );
      if (!resp.ok) {
        statusEl.textContent = `APIエラー: ${resp.status}`;
        return;
      }
      const data = await resp.json();
      const text =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        '回答を取得できませんでした。';
      answerEl.textContent = text.trim();
      statusEl.textContent = '完了';
    } catch (e) {
      statusEl.textContent = '通信エラー';
      log.error(e);
    }
  }

  // ===== メイン処理 =====

  // SearXNGページか判定
  const form = document.querySelector('#search_form, form[action="/search"]');
  const sidebar = document.querySelector('#sidebar');
  const mainResults = document.getElementById('main_results') ||
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

  // まず回答ボックスを作成（サイドバーがあれば必ずそこ）
  const { contentEl: answerEl, statusEl: answerStatusEl, wrapper: answerWrapper } =
    createAnswerBox(mainResults, sidebar);

  // サマリ UI 作成（サイドバーがあれば回答の直後に置く）
  let summaryContentEl = null;
  let summaryTimeEl = null;
  if (sidebar) {
    const s = createSummaryBox(sidebar, answerWrapper); // 回答の直後に概要
    summaryContentEl = s.contentEl;
    summaryTimeEl = s.timeEl;
  }

  // 概要キャッシュ確認
  const cacheKey = normalizeQuery(query);
  const cache = getSummaryCache();
  if (summaryContentEl && cache.data[cacheKey]) {
    const cached = cache.data[cacheKey];
    summaryContentEl.innerHTML = cached.html;
    summaryTimeEl.textContent = cached.time;
    log.info('概要: キャッシュを使用:', query);
  }

  // 検索結果からスニペット収集（概要・回答の共通ソース）
  const results = await fetchSearchResults(form, mainResults, CONFIG.MAX_RESULTS);
  const excludePatterns = [/google キャッシュ$/i];

  const answerSnippetsArr = [];
  const summarySnippetsArr = [];
  const urlList = [];
  let totalChars = 0;
  const SUMMARY_TOP_K = 5;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const snippetEl = r.querySelector('.result__snippet') || r;
    let text = snippetEl.innerText.trim();

    excludePatterns.forEach(p => {
      text = text.replace(p, '').trim();
    });
    if (!text) continue;

    // 回答用：総量制限
    if (totalChars + text.length > CONFIG.SNIPPET_CHAR_LIMIT) break;
    answerSnippetsArr.push(text);
    totalChars += text.length;

    // 概要用：上位 SUMMARY_TOP_K 件を優先
    if (i < SUMMARY_TOP_K) {
      summarySnippetsArr.push(text);
      const link = r.querySelector('a');
      if (link && link.href) {
        urlList.push(link.href);
      }
    }
  }

  const answerSnippets  = answerSnippetsArr.map((t, i) => `${i + 1}.\n${t}`).join('\n\n');
  const summarySnippets = summarySnippetsArr.map((t, i) => `${i + 1}.\n${t}`).join('\n\n');

  // 概要と回答を並列実行
  if (summaryContentEl && !cache.data[cacheKey]) {
    callGeminiSummary(
      apiKey,
      query,
      summarySnippets,
      urlList,
      summaryContentEl,
      summaryTimeEl,
      cacheKey
    );
  }
  callGeminiAnswer(apiKey, query, answerSnippets, answerEl, answerStatusEl);
})();
