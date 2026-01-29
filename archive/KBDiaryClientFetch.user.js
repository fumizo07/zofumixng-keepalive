// ==UserScript==
// @name         KB Diary Client Fetch (push to server)
// @namespace    kb-diary
// @version      0.3.9
// @description  Fetch diary latest timestamp in real browser and push to KB server
// @match        https://*/kb*
// @grant        GM_xmlhttpRequest
// @connect      www.cityheaven.net
// @connect      cityheaven.net
// @connect      www.dto.jp
// @connect      dto.jp
// ==/UserScript==
// 007

(() => {
  'use strict';

  // ====== 共有シークレット（合言葉）で自サイト判定 ======
  const KB_ALLOW_META_NAME = 'kb-allow-konbankonban';
  const KB_ALLOW_LS_KEY = 'kb_allow_secret_v1';
  const KB_ALLOW_PROMPT_MSG = '合言葉を入力してください';

  function getLocalSecret() {
    try { return String(localStorage.getItem(KB_ALLOW_LS_KEY) || '').trim(); } catch { return ''; }
  }
  function setLocalSecret(v) {
    try { localStorage.setItem(KB_ALLOW_LS_KEY, String(v || '').trim()); } catch {}
  }
  function clearLocalSecret() {
    try { localStorage.removeItem(KB_ALLOW_LS_KEY); } catch {}
  }

  function getMetaSecret() {
    const el = document.querySelector(`meta[name="${KB_ALLOW_META_NAME}"]`);
    if (!el) return '';
    return String(el.getAttribute('content') || '').trim();
  }

  function ensureAllowSecret() {
    const meta = getMetaSecret();
    if (!meta) return false; // 自サイト以外は即終了（promptも出ない）

    let sec = getLocalSecret();

    if (sec && sec !== meta) {
      clearLocalSecret();
      sec = '';
    }

    if (!sec) {
      const input = prompt(KB_ALLOW_PROMPT_MSG);
      sec = String(input || '').trim();
      if (!sec) {
        clearLocalSecret();
        return false;
      }
      setLocalSecret(sec);
    }

    const ok = (sec === meta);
    if (!ok) clearLocalSecret();
    return ok;
  }

  if (!ensureAllowSecret()) return;

  // ====== 設定 ======
  const PUSH_ENDPOINT = '/kb/api/diary_push';
  const CSRF_INIT_ENDPOINT = '/kb/api/csrf_init';
  const CSRF_COOKIE_NAME = 'kb_csrf';
  const CSRF_HEADER_NAME = 'X-KB-CSRF';

  const CACHE_TTL_MS = 10 * 60 * 1000; // 10分（外部サイト取得キャッシュ）
  const MIN_RUN_INTERVAL_MS = 10 * 60 * 1000; // ★暴走防止：最低でも10分に1回
  const MAX_IDS = 30;
  const CONCURRENCY = 2;

  // ====== ユーティリティ ======
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowMs = () => Date.now();

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  function cacheKeyForUrl(url) {
    return 'kb_diary_cache:' + url;
  }

  function getCached(url) {
    const k = cacheKeyForUrl(url);
    const v = lsGet(k);
    if (!v || typeof v !== 'object') return null;
    if (!v.savedAt || (nowMs() - v.savedAt) > CACHE_TTL_MS) return null;
    return v;
  }

  function setCached(url, latestTs, error) {
    const k = cacheKeyForUrl(url);
    lsSet(k, { savedAt: nowMs(), latestTs: latestTs ?? null, error: error || '' });
  }

  function getCookie(name) {
    const all = String(document.cookie || '');
    if (!all) return '';
    const parts = all.split(';');
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1);
      if (k === name) return decodeURIComponent(v || '');
    }
    return '';
  }

  async function ensureCsrf() {
    if (getCookie(CSRF_COOKIE_NAME)) return true;

    try {
      const r = await fetch(CSRF_INIT_ENDPOINT, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
      });
      if (!r.ok) return false;
    } catch (_) {
      return false;
    }

    return !!getCookie(CSRF_COOKIE_NAME);
  }

  function gmGet(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        anonymous: false,
        timeout: 25000,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
          'Upgrade-Insecure-Requests': '1',
        },
        onload: (res) => resolve({ ok: true, status: res.status, text: res.responseText || '' }),
        ontimeout: () => resolve({ ok: false, status: 0, text: '', error: 'timeout' }),
        onerror: () => resolve({ ok: false, status: 0, text: '', error: 'network_error' }),
      });
    });
  }

  // "12/30 23:47"
  const RE_MMDD_HHMM = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/;
  // "2026年1月"
  const RE_YEARMON = /(\d{4})年\s*(\d{1,2})月/;

  function extractYearMonth(text) {
    const m = (text || '').match(RE_YEARMON);
    if (!m) return { y: null, mo: null };
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12) return { y, mo };
    return { y: null, mo: null };
  }

  function guessYear(headerY, headerMo, entryMo) {
    if (headerY == null) return null;
    if (headerMo == null) return headerY;
    if (headerMo === 1 && entryMo === 12) return headerY - 1;
    return headerY;
  }

  function parseLatestTsUtcMsFromHtml(html) {
    if (!html) return { ts: null, err: 'empty_html' };
    const m = html.match(RE_MMDD_HHMM);
    if (!m) return { ts: null, err: 'no_datetime_found' };

    const mm = parseInt(m[1], 10);
    const dd = parseInt(m[2], 10);
    const hh = parseInt(m[3], 10);
    const mi = parseInt(m[4], 10);
    if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59)) {
      return { ts: null, err: 'datetime_out_of_range' };
    }

    const ym = extractYearMonth(html);
    let y = guessYear(ym.y, ym.mo, mm);
    if (y == null) y = new Date().getFullYear();

    const iso = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+09:00`;
    const dt = new Date(iso);
    const ts = dt.getTime();
    if (!Number.isFinite(ts) || ts <= 0) return { ts: null, err: 'datetime_to_epoch_failed' };
    return { ts, err: '' };
  }

  function normalizeDiaryUrl(u) {
    const s = (u || '').trim();
    if (!s) return '';
    if (s.replace(/\/+$/, '').endsWith('/diary')) return s.replace(/\/+$/, '');
    return s.replace(/\/+$/, '') + '/diary';
  }

  function isTrackedSlot(el) {
    const v = String(el.getAttribute('data-diary-track') || '1').trim();
    return v === '1';
  }

  function collectSlots() {
    const nodes = Array.from(document.querySelectorAll('[data-kb-diary-slot][data-person-id]'));
    const out = [];
    for (const el of nodes) {
      if (!isTrackedSlot(el)) continue;

      const pid = parseInt(el.getAttribute('data-person-id') || '0', 10);
      const du = normalizeDiaryUrl(el.getAttribute('data-diary-url') || '');
      if (!pid || !du) continue;

      out.push({ id: pid, diaryUrl: du });
      if (out.length >= MAX_IDS) break;
    }

    // idでユニーク化
    const seen = new Set();
    const uniq = [];
    for (const x of out) {
      const k = String(x.id);
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(x);
    }
    return uniq;
  }

  function computeSlotsSignature(slots) {
    // DOMの「テキスト更新」では変わらず、スロットの追加/削除/URL変更でだけ変わる
    return slots
      .slice()
      .sort((a, b) => (a.id - b.id))
      .map(x => `${x.id}|${x.diaryUrl}`)
      .join(',');
  }

  function notifyPushed(ids) {
    // ★二重発火を廃止：イベントだけ送る（kb.js側が対応していれば即時更新）
    try { window.dispatchEvent(new CustomEvent('kb-diary-pushed', { detail: { ids } })); } catch {}
  }

  async function pushResults(batch) {
    const okCsrf = await ensureCsrf();
    if (!okCsrf) return false;

    const csrf = getCookie(CSRF_COOKIE_NAME);
    if (!csrf) return false;

    const res = await fetch(PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CSRF_HEADER_NAME]: csrf,
      },
      body: JSON.stringify({ items: batch }),
      credentials: 'same-origin',
      keepalive: true,
    });

    try { await res.json(); } catch {}
    return res.ok;
  }

  async function workerFetchOne(task) {
    const { id, diaryUrl } = task;

    const c = getCached(diaryUrl);
    if (c) {
      return { id, latest_ts: c.latestTs, error: c.error || '', checked_at_ms: nowMs() };
    }

    await sleep(250 + Math.floor(Math.random() * 350));

    const r = await gmGet(diaryUrl);
    if (!r.ok) {
      const err = r.error || 'gm_error';
      setCached(diaryUrl, null, err);
      return { id, latest_ts: null, error: err, checked_at_ms: nowMs() };
    }

    if ((r.status || 0) >= 400) {
      const err = `http_${r.status || 0}`;
      setCached(diaryUrl, null, err);
      return { id, latest_ts: null, error: err, checked_at_ms: nowMs() };
    }

    const parsed = parseLatestTsUtcMsFromHtml(r.text);
    if (parsed.ts != null && !parsed.err) {
      setCached(diaryUrl, parsed.ts, '');
      return { id, latest_ts: parsed.ts, error: '', checked_at_ms: nowMs() };
    } else {
      setCached(diaryUrl, null, parsed.err || 'parse_failed');
      return { id, latest_ts: null, error: parsed.err || 'parse_failed', checked_at_ms: nowMs() };
    }
  }

  let running = false;
  let lastRunAt = 0;

  async function runOnce() {
    if (running) return;

    const now = nowMs();
    if (lastRunAt && (now - lastRunAt) < MIN_RUN_INTERVAL_MS) {
      return; // ★暴走防止：短時間で再実行しない
    }

    const slots = collectSlots();
    if (!slots.length) return;

    running = true;
    lastRunAt = now;

    try {
      const tasks = slots.map(s => ({ id: s.id, diaryUrl: s.diaryUrl }));
      const results = [];
      let idx = 0;

      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (idx < tasks.length) {
          const t = tasks[idx++];
          const r = await workerFetchOne(t);
          results.push(r);
        }
      });

      await Promise.all(workers);

      const ok = await pushResults(results);
      if (ok) notifyPushed(results.map(x => x.id));
    } catch (_) {
      // 失敗しても暴走しないように、ここでは何もしない
    } finally {
      running = false;
    }
  }

  // ===== 起動＆監視（slot集合が変わった時だけ走る） =====
  let lastSig = '';
  let timer = null;

  function schedule(reason) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      runOnce().catch(() => {});
    }, 600);
  }

  function checkSlotsChangedAndSchedule() {
    const slots = collectSlots();
    const sig = computeSlotsSignature(slots);
    if (!sig) return;
    if (sig === lastSig) return;
    lastSig = sig;
    schedule('slots_changed');
  }

  // 初回：slotがあれば1回だけ
  checkSlotsChangedAndSchedule();

  const mo = new MutationObserver((mutations) => {
    // ★追加/削除のときだけ反応（テキスト更新は基本的に無視）
    let touched = false;
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      if ((m.addedNodes && m.addedNodes.length) || (m.removedNodes && m.removedNodes.length)) {
        touched = true;
        break;
      }
    }
    if (!touched) return;

    // ここで「slot集合が変わったか」を確定判定
    checkSlotsChangedAndSchedule();
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    runOnce().catch(() => {});
  }, MIN_RUN_INTERVAL_MS);
  
  // ★手動で「今すぐ取得→push」したい時の逃げ道
  // 使い方：ブラウザのConsoleで  window.kbDiaryForcePush()
  window.kbDiaryForcePush = () => {
    lastRunAt = 0;        // 10分ガードを一時解除
    running = false;      // 念のため（実害は少ないけど保険）
    runOnce().catch(() => {});
  };

})();
