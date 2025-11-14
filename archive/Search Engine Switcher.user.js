// ==UserScript==
// @name        Search Engine Switcher (VIA風ボトムバー) — new tab default (search-sites only + SearxNG) - safe
// @description いま見てる検索結果のクエリを保ったまま、Startpage / DuckDuckGo / Brave / SearxNG / Google にワンタップ切替（標準で新規タブ）。ダブルタップで同一タブ。検索サイト上でのみ表示。
// @match       *://*/*
// @run-at      document-idle
// @grant       none
// @version     1.2.0
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // --- iframe 内では動作させない（@noframes の二重ガード） ---
  if (window !== window.parent) return;

  // ===== 設定 =====
  const BAR_ID = '__seswitcher_bar__';
  const BTN_ATTR = 'data-ses-engine-id';

  const ENGINES = [
    { id: 'startpage',  label: 'Startpage',  url: q => `https://www.startpage.com/do/search?query=${q}` },
    { id: 'ddg',        label: 'DDG',        url: q => `https://duckduckgo.com/?q=${q}` },
    { id: 'brave',      label: 'Brave',      url: q => `https://search.brave.com/search?q=${q}` },
    { id: 'searx',      label: 'SearXNG',    url: q => `https://zofumixng.onrender.com/search?q=${q}` },
    { id: 'google',     label: 'Google',     url: q => `https://www.google.com/search?q=${q}` },
  ];

  const ONLY_ON_SEARCH_SITES = true;  // 検索サイトだけに表示
  const TAP_TO_DIM = true;            // バーの空白部タップで半透明トグル
  const DOUBLE_TAP_MS = 320;          // ダブルタップ判定時間

  // ===== クエリ抽出ロジック =====
  function getURLParam(name, url = location.href) {
    try {
      return new URL(url).searchParams.get(name);
    } catch {
      return null;
    }
  }

  function fromCommonParams() {
    for (const n of ['q', 'query', 'p', 'text', 'wd', 'keyword', 'k']) {
      const v = getURLParam(n);
      if (v) return v;
    }
    return null;
  }

  function fromKnownSERPs() {
    const h = location.hostname;
    if (/google\./i.test(h))        return getURLParam('q');
    if (/startpage\.com/i.test(h))  return getURLParam('query') || getURLParam('q');
    if (/duckduckgo\.com/i.test(h)) return getURLParam('q');
    if (/search\.brave\.com/i.test(h)) return getURLParam('q');
    if (/bing\.com/i.test(h))       return getURLParam('q');
    if (/^zofumixng\.onrender\.com$/i.test(h)) return getURLParam('q'); // SearXNG（typo 修正）
    return null;
  }

  function fromSearchInputs() {
    const nodes = document.querySelectorAll(
      'input[type="search"], input[name="q"], input[name="query"], input[name="text"], textarea[name="q"], textarea[type="search"]'
    );
    const arr = Array.from(nodes);
    const focused = arr.find(el => el === document.activeElement && el.value && el.value.trim());
    if (focused) return focused.value.trim();
    const filled = arr.find(el => el.value && el.value.trim());
    return filled ? filled.value.trim() : null;
  }

  function fromSelection() {
    const s = String(getSelection && getSelection().toString() || '').trim();
    return s || null;
  }

  function fromTitleHeuristics() {
    const t = document.title || '';
    const m1 = t.match(/^(.+?)\s+[-|–]\s+(Google.*検索|Bing|Startpage|DuckDuckGo|Brave Search|Searx)/i);
    if (m1) return m1[1].trim();
    const m2 = t.match(/^(.+?)\s+at\s+(DuckDuckGo|Brave|Searx)/i);
    if (m2) return m2[1].trim();
    return null;
  }

  function extractQuery() {
    return (
      fromKnownSERPs()     ||
      fromCommonParams()   ||
      fromSearchInputs()   ||
      fromSelection()      ||
      fromTitleHeuristics()||
      null
    );
  }

  function isSearchSite() {
    const h = location.hostname;
    return /google\./i.test(h) ||
           /startpage\.com/i.test(h) ||
           /duckduckgo\.com/i.test(h) ||
           /search\.brave\.com/i.test(h) ||
           /bing\.com/i.test(h) ||
           /^zofumixng\.onrender\.com$/i.test(h);
  }

  // ===== URLを開く（標準：新規タブ、ダブルタップ：同一タブ） =====
  function openURL(url, { newTab = true } = {}) {
    if (newTab) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();

      const w = window.open(url, '_blank', 'noopener');
      if (!w) location.assign(url);
    } else {
      location.assign(url);
    }
  }

  // ===== 現在どのエンジンか判定 =====
  function detectCurrentEngineId() {
    const h = location.hostname;
    if (/startpage\.com/i.test(h))           return 'startpage';
    if (/duckduckgo\.com/i.test(h))          return 'ddg';
    if (/search\.brave\.com/i.test(h))       return 'brave';
    if (/google\./i.test(h))                 return 'google';
    if (/^zofumixng\.onrender\.com$/i.test(h)) return 'searx';
    return null;
  }

  // ===== UI（ボトムバー） =====
  function createBar(initialQ) {
    // 多重実行対策：すでにバーがあれば何もしない
    if (document.getElementById(BAR_ID)) return;

    const wrap = document.createElement('div');
    wrap.id = BAR_ID;
    wrap.setAttribute('aria-label', 'Search Engine Switcher');

    // CSS 衝突を減らすため、グローバル CSS ではなくインラインスタイルで完結
    wrap.style.position   = 'fixed';
    wrap.style.left       = '50%';
    wrap.style.bottom     = '10px';
    wrap.style.transform  = 'translateX(-50%)';
    wrap.style.zIndex     = '2147483647';
    wrap.style.display    = 'flex';
    wrap.style.gap        = '8px';
    wrap.style.padding    = '8px';
    wrap.style.borderRadius = '14px';
    wrap.style.background   = 'rgba(20,20,20,0.85)';
    wrap.style.backdropFilter = 'saturate(1.2) blur(6px)';
    wrap.style.boxShadow   = '0 6px 24px rgba(0,0,0,0.25)';
    wrap.style.fontFamily  = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    wrap.style.fontSize    = '14px';
    wrap.style.lineHeight  = '1';
    wrap.style.color       = '#fff';
    wrap.style.userSelect  = 'none';

    ENGINES.forEach(engine => {
      const btn = document.createElement('button');
      btn.textContent = engine.label;
      btn.title = 'シングルタップ: 新規タブ / ダブルタップ: 同一タブ';
      btn.setAttribute(BTN_ATTR, engine.id);

      btn.style.appearance   = 'none';
      btn.style.border       = 'none';
      btn.style.padding      = '8px 10px';
      btn.style.borderRadius = '10px';
      btn.style.background   = '#2a2a2a';
      btn.style.color        = '#fff';
      btn.style.letterSpacing= '.2px';
      btn.style.boxShadow    = 'inset 0 0 0 1px rgba(255,255,255,0.06)';
      btn.style.touchAction  = 'manipulation';
      btn.style.font         = 'inherit';
      btn.style.cursor       = 'pointer';
      btn.style.whiteSpace   = 'nowrap';

      let lastTap = 0;
      btn.addEventListener('pointerup', () => {
        let q = extractQuery() || initialQ || '';
        if (!q) {
          q = prompt('検索語が見つかりません。クエリを入力してください：') || '';
          q = q.trim();
          if (!q) return;
        }
        const enc = encodeURIComponent(q);
        const engineCfg = ENGINES.find(e => e.id === engine.id);
        if (!engineCfg) return;
        const url = engineCfg.url(enc);

        const now = Date.now();
        const isDouble = (now - lastTap) <= DOUBLE_TAP_MS;
        lastTap = now;

        openURL(url, { newTab: !isDouble });
      });

      wrap.appendChild(btn);
    });

    // 現在のエンジンをハイライト
    const current = detectCurrentEngineId();
    if (current) {
      const active = wrap.querySelector(`[${BTN_ATTR}="${current}"]`);
      if (active) {
        active.style.background = '#4a64ff';
        active.style.boxShadow  = 'inset 0 0 0 1px rgba(255,255,255,0.12)';
      }
    }

    // バー空白タップで半透明トグル
    if (TAP_TO_DIM) {
      wrap.addEventListener('click', (ev) => {
        if (ev.target.tagName.toLowerCase() === 'button') return;
        wrap.style.opacity = (wrap.style.opacity === '0.25') ? '1' : '0.25';
      });
      wrap.title = 'バーの空白部分をタップで半透明切替';
    }

    const root = document.body || document.documentElement;
    root.appendChild(wrap);
  }

  // ===== 実行 =====
  if (ONLY_ON_SEARCH_SITES && !isSearchSite()) return;

  const initialQ = extractQuery();
  createBar(initialQ);

  // 一応、後から検索クエリが埋まるサイト向けにポーリング（バーの再生成はしない）
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (extractQuery()) clearInterval(timer);
    if (tries > 40) clearInterval(timer);
  }, 100);
})();
