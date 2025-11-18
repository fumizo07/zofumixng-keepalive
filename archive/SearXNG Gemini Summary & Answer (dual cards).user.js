// ==UserScript==
// @name         SearXNG Gemini Answer + Summary (combined, zofumixng, sidebar always)
// @namespace    https://example.com/searxng-gemini-combined
// @version      0.5.0
// @description  SearXNG検索結果ページに「Gemini AIの回答」と「Geminiによる概要」を両方表示する統合スクリプト（サイドバーがあれば常にサイドバー上部に配置）
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
    // ★ 最新のFlash系モデル（2025-11時点）
    MODEL_NAME: 'gemini-2.5-flash',
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
      .replace(/[　]/g, ' ')
      .replace(/\s+/g, ' ');
  }

  const formatResponse = text =>
    text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // ===== クエリのざっくり分類 =====
  function classifyQuery(query) {
    const q = (query || '').trim();

    // レシピ系
    if (/(レシピ|作り方|作る方法|作成方法|レシピ教えて)/i.test(q)) {
      return 'recipe';
    }

    // 旅行・国/地域系（かなりラフな判定）
    const travelWords = /(旅行|観光|治安|ビザ|入国|渡航|物価|安全性|海外)/;
    const countryWords = /(インドネシア|タイ|アメリカ|米国|フランス|イギリス|英国|ドイツ|スペイン|イタリア|オーストラリア|カナダ|シンガポール|マレーシア|ベトナム|フィリピン|韓国|ソウル|バリ島|ハワイ|ヨーロッパ|EU|ニューヨーク|ロサンゼルス|サンフランシスコ|ロンドン|パリ)/i;

    if (travelWords.test(q) || countryWords.test(q)) {
      return 'travel';
    }

    return 'general';
  }

  // ★ Gemini回答を見やすく整形する軽い整形関数
  function prettifyAnswer(text) {
    if (!text) return '';
    let t = String(text).trim();

    // すでに改行がそれなりにあるならあまり触らない
    const newlineCount = (t.match(/\n/g) || []).length;
    if (newlineCount === 0) {
      // 改行が全くないときだけ、「。」「！」「？」の後ろで改行を入れる
      t = t.replace(/(。|！|？)/g, '$1\n');
    }

    // 3行以上の連続改行は2行に圧縮
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
      <div style="display:flex;justify-content:center;gap:1em;">
        <button id="gemini-save-btn"
          style="background:#0078d4;color:#fff;border:none;
                 padding:0.5em 1.2em;border-radius:8px;cursor:pointer;font-weight:bold;">
          保存
        </button>
        <button id="gemini-cancel-btn"
          style="background:${isDark ? '#555' : '#ccc'};
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
  // afterElement が指定されている場合は、その直後に挿入
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
  // サイドバーがあれば必ずサイドバー先頭、なければメインカラム上部
  function createAnswerBox(mainResults, sidebar) {
    const wrapper = document.createElement('div');
    wrapper.style.margin = '0 0 1em 0';

    // ★ 背景含め、このブロックは元コードのまま（変更なし）
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
          <div style="font-weight:600;font-size:1em;">Gemini AI 回答</div>
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
      html += `<section><p>${formatResponse(jsonData.intro)}</p></section>`;
    }

    if (Array.isArray(jsonData.sections)) {
      jsonData.sections.forEach(sec => {
        if (sec.title && Array.isArray(sec.content)) {
          html += `<section><h4>${sec.title}</h4><ul>`;
          sec.content.forEach(item => {
            html += `<li>${formatResponse(item)}</li>`;
          });
          html += '</ul></section>';
        }
      });
    }

    if (Array.isArray(jsonData.urls) && jsonData.urls.length > 0) {
      html += '<section><h4>出典</h4><ul>';
      jsonData.urls.slice(0, 3).forEach(url => {
        try {
          const u = new URL(url);
          const domain = u.hostname.replace(/^www\./, '');
          html += `<li><a href="${url}" target="_blank">${domain}</a></li>`;
        } catch {
          html += `<li>${url}</li>`;
        }
      });
      html += '</ul></section>';
    }

    contentEl.innerHTML = html;

    const now = new Date();
    const timeText = now.toLocaleString('ja-JP', { hour12: false });
    timeEl.textContent = timeText;

    const cache = getSummaryCache();
    if (!cache.keys.includes(cacheKey)) cache.keys.push(cacheKey);
    cache.data[cacheKey] = {
      html,
      ts: Date.now(),
      time: timeText
    };
    setSummaryCache(cache);
  }

  // ===== Gemini 呼び出し：概要 =====
  async function callGeminiSummary(apiKey, query, snippets, urls, contentEl, timeEl, cacheKey) {
    const prompt = `
検索クエリ: ${query}
検索スニペット:
${snippets}

指示:
1. 上記のスニペットを元に、このクエリに対する概要を作成してください。
2. 情報が不足する場合は「情報が限られています」と明示し、必要であれば推測も行ってください（推測と分かる書き方にする）。
3. 概要は600字以内。
4. 出力は必ず次のJSON形式にしてください。

{
  "intro": "概要の導入文",
  "sections": [
    {
      "title": "セクションタイトル",
      "content": ["内容1", "内容2"]
    }
  ],
  "urls": ["URL1", "URL2", "URL3"]
}

urlsには、参考になりそうなURLを3件まで入れてください。
    `.trim();

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${CONFIG.MODEL_NAME}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
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
      // URLが空なら検索結果から補完
      if (!Array.isArray(parsed.urls) || parsed.urls.length === 0) {
        parsed.urls = urls.slice(0, 3);
      }
      renderSummaryFromJson(parsed, contentEl, timeEl, cacheKey);
    } catch (e) {
      contentEl.textContent = '通信に失敗しました';
      log.error(e);
    }
  }

  // ===== Gemini 呼び出し：回答（クエリ種別ごとにフォーマット指定） =====
  async function callGeminiAnswer(apiKey, query, snippets, answerEl, statusEl) {
    const mode = classifyQuery(query);

    let prompt;

    if (mode === 'recipe') {
      // レシピ系
      prompt = `
あなたは日本人向けの家庭料理の専門家です。
ユーザーのクエリ: ${query}

以下は検索スニペットです（必要な場合だけ参考にしてください。不要なら無視して構いません）:
${snippets}

【出力フォーマット（日本語）】
できるだけ簡潔に、次の形式で出力してください。

【材料】
・2人分を想定し、必要なものだけ3〜10個に絞って箇条書き

【手順】
1. 下ごしらえ
2. 調理の手順
3. 仕上げ

のように、3〜7ステップ程度に番号付きで書いてください。

【その他の条件】
- 前置きや長い説明文は書かないでください（いきなり【材料】から始める）。
- 全体で日本語300〜600文字程度を目安にしてください。
- マークダウン記法（# や * など）は使わないでください。
      `.trim();
    } else if (mode === 'travel') {
      // 国・地域・旅行系
      prompt = `
あなたは日本人旅行者向けのガイドです。
ユーザーのクエリ: ${query}

以下は検索スニペットです（必要に応じて参考にしてください）:
${snippets}

【目的】
外国や外国の地域について、
- ビザが必要か
- 治安はどうか
- 通貨は何か
- 主に何語を話すか
を日本人目線で簡潔に伝えてください。

【出力フォーマット（日本語）】
必ず次の形式で出力してください。各項目の前後に余計な説明は書かないでください。

【概要】
その国・地域がどんな場所かを1〜2文でまとめる。

【ビザ】
日本のパスポートで短期観光する場合の一般的な傾向を1〜2文で。
（例：「日本からの短期観光では〇日以内の滞在ならビザ不要な場合が多い。ただし最新の公式情報を要確認。」）
不明な場合や条件が複雑な場合は、その旨を書きつつ「最終的には大使館などの最新の公式情報を確認してください」と必ず付ける。

【治安】
- 全体的な治安の印象を1〜2文。
- 注意が必要なポイントがあれば1〜3行で簡潔に。

【通貨】
- 通貨名（例：インドネシア・ルピア（IDR））を1行で。

【言語】
- 主に使われている公用語／日常でよく使われる言語を1〜2行で。

【その他の条件】
- 全体で日本語400〜700文字程度に収めてください。
- マークダウン記法（# や * など）は使わないでください。
- 「〜だと思われます」など曖昧すぎる表現は避け、一般的な傾向として表現してください（ただし最新情報の確認は促してください）。
      `.trim();
    } else {
      // その他一般のクエリ
      prompt = `
あなたは日本語で分かりやすく説明するアシスタントです。
ユーザーのクエリ: ${query}

以下は検索スニペットです（必要な場合にだけ参考にしてください）:
${snippets}

【出力の方針】
- 前置きは書かず、いきなり本題から説明してください。
- 内容はできるだけ簡潔に、しかし要点は落とさないようにします。
- 3〜5文程度、全体で日本語300〜500文字ぐらいを目安にしてください。
- マークダウン記法（# や * など）は使わないでください。
- 箇条書きにする場合も、「・」から始めるシンプルなスタイルだけにしてください。
      `.trim();
    }

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${CONFIG.MODEL_NAME}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        }
      );
      if (!resp.ok) {
        statusEl.textContent = `APIエラー: ${resp.status}`;
        return;
      }
      const data = await resp.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ||
                  '回答を取得できませんでした。';
      const pretty = prettifyAnswer(raw);
      answerEl.textContent = pretty;
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

  // まず回答ボックスを作成（サイドバーがあれば必ずそこ）
  const {
    contentEl: answerEl,
    statusEl: answerStatusEl,
    wrapper: answerWrapper
  } = createAnswerBox(mainResults, sidebar);

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

  // 概要と回答を並列実行
  if (summaryContentEl && (!cache.data[cacheKey])) {
    callGeminiSummary(apiKey, query, snippets, urlList, summaryContentEl, summaryTimeEl, cacheKey);
  }
  callGeminiAnswer(apiKey, query, snippets, answerEl, answerStatusEl);
})();
