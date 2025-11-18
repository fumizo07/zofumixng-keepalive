// ==UserScript==
// @name        SearXNG Gemini Summary & Answer (dual cards)
// @description SearXNG の検索結果上位から概要を作りつつ、クエリに応じた詳しい回答も Gemini で生成して表示します。
// @match       *://zofumixng.onrender.com/*
// @run-at      document-idle
// @grant       none
// @version     0.1.0
// ==/UserScript==

(function () {
  'use strict';

  // ===== 設定 =====
  const API_KEY = 'AIzaSyC8ei_4XQrXMQQNp2MhPLha8nhl4qjA_6E'; // ←ここに Gemini API キー
  const MODEL = 'models/gemini-1.5-flash-latest';
  const MAX_RESULTS_FOR_SUMMARY = 5;

  const WRAPPER_ID = 'zfxng-gemini-wrapper-v2';

  // ===== 早期リターン =====
  if (window.top !== window.self) return; // iframe内では実行しない
  if (!API_KEY || API_KEY === 'YOUR_API_KEY_HERE') {
    // APIキーが未設定なら何もしない
    return;
  }

  // ===== ユーティリティ =====
  function $(sel, root = document) {
    return root.querySelector(sel);
  }
  function $all(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function getQueryFromPage() {
    const input = $('input[name="q"]');
    if (input && input.value.trim()) return input.value.trim();

    // URLパラメータからのフォールバック
    try {
      const url = new URL(location.href);
      const q = url.searchParams.get('q');
      if (q) return q.trim();
    } catch (e) {
      // 無視
    }
    return '';
  }

  function isSearxngLikePage() {
    // SearXNG っぽい特徴を軽くチェック
    if (!document.body) return false;
    if ($('#results')) return true;
    if ($('form[action="/search"]')) return true;
    if ($('.results') && $('.result')) return true;
    return false;
  }

  function collectResults(maxCount) {
    const resultsRoot =
      $('#results') ||
      $('.results') ||
      document;

    let nodes =
      $all('article.result', resultsRoot);
    if (!nodes.length) {
      nodes = $all('.result', resultsRoot);
    }
    if (!nodes.length) {
      nodes = $all('li.result', resultsRoot);
    }

    const sliced = nodes.slice(0, maxCount);
    return sliced.map((el, idx) => {
      const link =
        $('a', el) ||
        $('h3 a', el);
      const title = link ? link.textContent.trim() : '';
      const url = link ? link.href : '';
      const snippetEl =
        $('.content', el) ||
        $('.result-content', el) ||
        $('p', el);
      const snippet = snippetEl ? snippetEl.textContent.trim() : '';
      return {
        index: idx + 1,
        title,
        url,
        snippet,
      };
    }).filter(r => r.title || r.url || r.snippet);
  }

  async function callGemini(promptText) {
    const endpoint =
      'https://generativelanguage.googleapis.com/v1beta/' +
      MODEL +
      ':generateContent?key=' +
      encodeURIComponent(API_KEY);

    const body = {
      contents: [
        {
          parts: [{ text: promptText }],
        },
      ],
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error('Gemini API error: ' + res.status + ' ' + res.statusText);
    }

    const data = await res.json();
    const parts =
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts;

    if (!parts || !parts.length) {
      throw new Error('Gemini response has no content');
    }

    return parts.map(p => p.text || '').join('\n');
  }

  // ===== プロンプト組み立て =====

  function buildSummaryPrompt(query, results) {
    let text = '';
    text += `クエリ: 「${query}」\n\n`;
    text += `以下は、このクエリに対するウェブ検索結果の上位 ${results.length} 件です。\n`;
    for (const r of results) {
      text += `[${r.index}]\n`;
      text += `タイトル: ${r.title || '(タイトルなし)'}\n`;
      text += `URL: ${r.url || '(URLなし)'}\n`;
      text += `概要: ${r.snippet || '(概要テキストなし)'}\n\n`;
    }
    text +=
      `これら [1]〜[${results.length}] の情報だけを使って、共通する内容を日本語で3〜5文にまとめてください。\n` +
      `一般的な知識や想像は加えず、上に示した内容から読み取れる範囲だけを要約してください。\n` +
      `出力はテキスト本文のみとし、箇条書きやURLの出力は行わないでください。`;
    return text;
  }

  function classifyQuery(q) {
    const s = q.trim();

    if (/レシピ|作り方|作る方法|作成方法/.test(s)) {
      return 'recipe';
    }
    if (/旅行|観光|治安|ビザ|ビザ要件|入国/.test(s)) {
      return 'travel';
    }
    // 単語っぽい国名・地名も travel 系に寄せたい場合はここに拡張しても良い
    return 'general';
  }

  function buildAnswerPrompt(query, summaryText, mode) {
    let baseIntro =
      `ユーザーの関心は「${query}」です。\n` +
      `このクエリに対して、ウェブ検索結果の上位から次のような概要が得られています。\n` +
      `---- 概要ここから ----\n` +
      `${summaryText}\n` +
      `---- 概要ここまで ----\n\n`;

    if (mode === 'recipe') {
      return (
        baseIntro +
        'あなたは日本人家庭向けの料理研究家です。\n' +
        '「' + query + '」という料理について、以下の構成で日本語で詳しく説明してください。\n\n' +
        '1. 完成イメージ（どんな味・どんな見た目かを1〜2文で）\n' +
        '2. 材料（2人分。分量をg・ml・大さじ・小さじなどで具体的に）\n' +
        '3. 作り方（番号付きの手順。各ステップに「火加減」と「時間の目安」を含める）\n' +
        '4. アレンジ・応用（具材の代用、味変、ヘルシー化などのアイデア）\n' +
        '5. 失敗しやすいポイントと対策（味が薄い／濃い、ソースが分離する、パスタがのびる等）\n\n' +
        '家庭用キッチンで再現できるレシピとして、読めばそのまま作れるレベルの具体性で書いてください。'
      );
    }

    if (mode === 'travel') {
      return (
        baseIntro +
        'あなたは日本人旅行者向けのガイドです。\n' +
        '「' + query + '」という目的地や国・地域について、以下の構成で日本語で説明してください。\n\n' +
        '1. 基本情報（場所、首都または代表的な都市、人口やおおよその規模、気候）\n' +
        '2. 治安（比較的安全なエリアと、注意が必要な点。具体的なトラブル例があれば記載）\n' +
        '3. 物価感覚（日本と比べて高いか安いか、食費・交通費などのざっくり目安）\n' +
        '4. ビザや入国の一般的な目安（日本国籍の短期滞在にビザが必要かどうかの大まかな傾向）\n' +
        '5. 初めての旅行者におすすめのエリアや観光スポット\n' +
        '6. 旅行時の注意点（詐欺、スリ、服装、チップ文化、宗教・文化的なマナーなど）\n' +
        '7. 最後に、「実際に渡航する際は必ず最新の公式情報を確認する必要がある」旨を1文添えてください。\n'
      );
    }

    // general
    return (
      baseIntro +
      'あなたは日本語でわかりやすく解説する専門家です。\n' +
      '「' + query + '」というキーワードについて、以下の構成で説明してください。\n\n' +
      '1. 30〜60文字程度の「一言でいうと」\n' +
      '2. もう少し丁寧な解説（2〜3段落。用途や背景を含める）\n' +
      '3. 利点・メリット\n' +
      '4. 注意点・よくある誤解\n' +
      '5. さらに深く調べたい人のための関連キーワード（箇条書き3〜5個）\n'
    );
  }

  // ===== UI 生成 =====

  function injectBaseUI() {
    if (document.getElementById(WRAPPER_ID)) {
      return document.getElementById(WRAPPER_ID);
    }

    const resultsRoot =
      $('#results') ||
      $('.results') ||
      document.body;

    const wrapper = document.createElement('section');
    wrapper.id = WRAPPER_ID;
    wrapper.className = 'zfxng-gemini-wrapper';

    wrapper.innerHTML = `
      <style>
        .zfxng-gemini-wrapper {
          margin: 1.5em 0;
          padding: 0;
        }
        .zfxng-gemini-card {
          border-radius: 8px;
          border: 1px solid rgba(0,0,0,0.15);
          padding: 0.75em 1em;
          margin-bottom: 0.75em;
          font-size: 0.9rem;
          line-height: 1.5;
          background: rgba(250, 250, 255, 0.85);
        }
        .zfxng-gemini-card h2 {
          margin: 0 0 0.4em;
          font-size: 0.95rem;
        }
        .zfxng-gemini-card p {
          margin: 0.4em 0;
        }
        .zfxng-gemini-sources {
          margin: 0.5em 0 0;
          padding-left: 1.2em;
          font-size: 0.8rem;
        }
        .zfxng-gemini-badge {
          font-size: 0.75rem;
          opacity: 0.75;
          margin-left: 0.5em;
        }
        .zfxng-gemini-loading {
          font-style: italic;
          opacity: 0.7;
        }
        .zfxng-gemini-error {
          color: #b00020;
          font-size: 0.85rem;
        }
      </style>

      <div class="zfxng-gemini-card" id="zfxng-gemini-summary-card">
        <h2>Gemini 概要<span class="zfxng-gemini-badge">上位結果の要約</span></h2>
        <p class="zfxng-gemini-loading">SearXNG の検索結果から概要を生成中…</p>
      </div>

      <div class="zfxng-gemini-card" id="zfxng-gemini-answer-card">
        <h2>Gemini 回答<span class="zfxng-gemini-badge">クエリの詳しい説明</span></h2>
        <p class="zfxng-gemini-loading">クエリに基づいて詳しい解説を生成中…</p>
      </div>
    `;

    // 結果の直前あたりに差し込む
    if (resultsRoot.firstChild) {
      resultsRoot.insertBefore(wrapper, resultsRoot.firstChild);
    } else {
      resultsRoot.appendChild(wrapper);
    }

    return wrapper;
  }

  function renderSummary(summaryText, results) {
    const card = document.getElementById('zfxng-gemini-summary-card');
    if (!card) return;

    card.innerHTML = `
      <h2>Gemini 概要<span class="zfxng-gemini-badge">上位結果の要約</span></h2>
      <p>${escapeHtml(summaryText).replace(/\n/g, '<br>')}</p>
      <ul class="zfxng-gemini-sources">
        ${results
          .map(r => {
            const safeTitle = r.title || r.url || '(タイトルなし)';
            const safeUrl = r.url || '#';
            return `<li>[${r.index}] <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(safeTitle)}</a></li>`;
          })
          .join('')}
      </ul>
    `;
  }

  function renderSummaryError(err) {
    const card = document.getElementById('zfxng-gemini-summary-card');
    if (!card) return;
    card.innerHTML = `
      <h2>Gemini 概要<span class="zfxng-gemini-badge">上位結果の要約</span></h2>
      <p class="zfxng-gemini-error">概要の取得でエラーが発生しました: ${escapeHtml(err.message || String(err))}</p>
    `;
  }

  function renderAnswer(answerText) {
    const card = document.getElementById('zfxng-gemini-answer-card');
    if (!card) return;
    card.innerHTML = `
      <h2>Gemini 回答<span class="zfxng-gemini-badge">クエリの詳しい説明</span></h2>
      <p>${escapeHtml(answerText).replace(/\n/g, '<br>')}</p>
    `;
  }

  function renderAnswerError(err) {
    const card = document.getElementById('zfxng-gemini-answer-card');
    if (!card) return;
    card.innerHTML = `
      <h2>Gemini 回答<span class="zfxng-gemini-badge">クエリの詳しい説明</span></h2>
      <p class="zfxng-gemini-error">回答の取得でエラーが発生しました: ${escapeHtml(err.message || String(err))}</p>
    `;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ===== メイン処理 =====

  async function main() {
    if (!isSearxngLikePage()) return;

    const query = getQueryFromPage();
    if (!query) return;

    const results = collectResults(MAX_RESULTS_FOR_SUMMARY);
    if (!results.length) {
      // 結果ゼロなら概要は表示せず回答だけ出す、などもありだが
      // ここでは両方スキップしておく
      return;
    }

    injectBaseUI();

    try {
      // 1. 概要
      const summaryPrompt = buildSummaryPrompt(query, results);
      const summaryText = await callGemini(summaryPrompt);
      renderSummary(summaryText, results);

      // 2. 回答
      const mode = classifyQuery(query);
      const answerPrompt = buildAnswerPrompt(query, summaryText, mode);
      const answerText = await callGemini(answerPrompt);
      renderAnswer(answerText);
    } catch (err) {
      console.error('[SearXNG Gemini] error', err);
      // どちらで落ちたか分からないので、とりあえず両方エラー表示
      renderSummaryError(err);
      renderAnswerError(err);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(main, 0);
  } else {
    document.addEventListener('DOMContentLoaded', main);
  }
})();
