// ==UserScript==
// @name         KB Diary Client Fetch (push to server)
// @namespace    kb-diary
// @version      0.3.13
// @description  Fetch diary latest timestamp in real browser and push to KB server
// @match        https://*/kb*
// @grant        GM_xmlhttpRequest
// @connect      www.cityheaven.net
// @connect      cityheaven.net
// @connect      www.dto.jp
// @connect      dto.jp
// @connect      s.dto.jp
// ==/UserScript==
// 012

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

  // ====== Soul等で GM_xmlhttpRequest が無いと全処理が沈黙するので、即わかるようにする
  if (typeof GM_xmlhttpRequest !== 'function') {
    console.warn('[kb-diary] GM_xmlhttpRequest is not available in this browser.');
    window.kbDiaryForcePush = () => alert('このブラウザは GM_xmlhttpRequest 非対応のため、日記の外部取得ができません。');
    return;
  }

  // ====== 設定 ======
  const PUSH_ENDPOINT = '/kb/api/diary_push';
  const CSRF_INIT_ENDPOINT = '/kb/api/csrf_init';
  const CSRF_COOKIE_NAME = 'kb_csrf';
  const CSRF_HEADER_NAME = 'X-KB-CSRF';

  const CACHE_TTL_MS = 10 * 60 * 1000;        // 10分（外部サイト取得キャッシュ）
  const MIN_RUN_INTERVAL_MS = 10 * 60 * 1000; // 10分（暴走防止：通常運用のみ）
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

  // ====== パース（ヘブン / DTO で分岐） ======

  // Heaven: "12/30 23:47"
  const RE_MMDD_HHMM = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/;
  // Heaven: <span class="diary_time">12/30 23:47</span>
  const RE_DIARY_TIME_SPAN = /<span[^>]*class="[^"]*\bdiary_time\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;

  // DTO(www): <span class="regist_time">2月3日(火) 03:02</span>
  const RE_REGIST_TIME_SPAN = /<span[^>]*class="[^"]*\bregist_time\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  // DTO text: "2月3日(火) 03:02" （曜日は任意）
  const RE_JP_MMDD_HHMM = /(\d{1,2})月\s*(\d{1,2})日(?:\s*\([^)]+\))?\s*(\d{1,2}):(\d{2})/;

  // "2026年1月"
  const RE_YEARMON = /(\d{4})年\s*(\d{1,2})月/;
  // "2026年"
  const RE_YEAR = /(\d{4})年/;

  function extractYearMonth(text) {
    const m = (text || '').match(RE_YEARMON);
    if (!m) return { y: null, mo: null };
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12) return { y, mo };
    return { y: null, mo: null };
  }

  function extractYearOnly(text) {
    const m = (text || '').match(RE_YEAR);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    if (y >= 1900 && y <= 2100) return y;
    return null;
  }

  function guessYear(headerY, headerMo, entryMo) {
    if (headerY == null) return null;
    if (headerMo == null) return headerY;
    if (headerMo === 1 && entryMo === 12) return headerY - 1;
    if (headerMo === 12 && entryMo === 1) return headerY + 1;
    return headerY;
  }

  function parseLatestTsUtcMsFromHtmlHeaven(html) {
    if (!html) return { ts: null, err: 'empty_html' };

    const ym = extractYearMonth(html);
    const headerY = ym.y;
    const headerMo = ym.mo;

    let maxTs = null;
    let foundAny = false;

    let mSpan;
    while ((mSpan = RE_DIARY_TIME_SPAN.exec(html)) !== null) {
      const inner = String(mSpan[1] || '').replace(/<[^>]+>/g, ' ').trim();
      const m = inner.match(RE_MMDD_HHMM);
      if (!m) continue;

      foundAny = true;

      const mm = parseInt(m[1], 10);
      const dd = parseInt(m[2], 10);
      const hh = parseInt(m[3], 10);
      const mi = parseInt(m[4], 10);

      if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59)) {
        continue;
      }

      let y = guessYear(headerY, headerMo, mm);
      if (y == null) y = new Date().getFullYear();

      const iso = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+09:00`;
      const dt = new Date(iso);
      const ts = dt.getTime();

      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (maxTs == null || ts > maxTs) maxTs = ts;
    }

    if (!foundAny) return { ts: null, err: 'no_diary_time_found' };
    if (maxTs == null) return { ts: null, err: 'diary_time_parse_failed' };

    return { ts: maxTs, err: '' };
  }

  function parseLatestTsUtcMsFromHtmlDto(html) {
    if (!html) return { ts: null, err: 'empty_html' };

    const ym = extractYearMonth(html);
    let headerY = ym.y;
    const headerMo = ym.mo;

    // DTOは「YYYY年」だけ出て月が無いケースもあるので、yearだけ拾う保険
    if (headerY == null) {
      headerY = extractYearOnly(html);
    }

    let maxTs = null;
    let foundAny = false;

    let mSpan;
    while ((mSpan = RE_REGIST_TIME_SPAN.exec(html)) !== null) {
      const inner = String(mSpan[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const m = inner.match(RE_JP_MMDD_HHMM);
      if (!m) continue;

      foundAny = true;

      const mm = parseInt(m[1], 10);
      const dd = parseInt(m[2], 10);
      const hh = parseInt(m[3], 10);
      const mi = parseInt(m[4], 10);

      if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59)) {
        continue;
      }

      let y = guessYear(headerY, headerMo, mm);
      if (y == null) y = new Date().getFullYear();

      const iso = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+09:00`;
      const dt = new Date(iso);
      const ts = dt.getTime();

      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (maxTs == null || ts > maxTs) maxTs = ts;
    }

    if (!foundAny) return { ts: null, err: 'no_regist_time_found' };
    if (maxTs == null) return { ts: null, err: 'regist_time_parse_failed' };

    return { ts: maxTs, err: '' };
  }

  function isDtoHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'dto.jp' || h.endsWith('.dto.jp');
  }

  function normalizeDiaryUrl(u) {
    const raw = String(u || '').trim();
    if (!raw) return '';

    let url;
    try {
      url = raw.startsWith('http://') || raw.startsWith('https://')
        ? new URL(raw)
        : new URL(raw, 'https://www.cityheaven.net');
    } catch (_) {
      return '';
    }

    // path normalize
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (!url.pathname.endsWith('/diary')) {
      url.pathname += '/diary';
    }

    // host別の正規化
    if (isDtoHost(url.hostname)) {
      // 取得は必ず www.dto.jp に寄せる（安定化）
      url.protocol = 'https:';
      url.hostname = 'www.dto.jp';

      // 余計なパラメータは落とす（DTO側で不要＆挙動が変わる可能性）
      try { url.searchParams.delete('pcmode'); } catch {}
      try { url.searchParams.delete('spmode'); } catch {}
    } else {
      // Heaven: spmode=pc に寄せる（現状仕様）
      try { url.searchParams.delete('pcmode'); } catch {}
      try { url.searchParams.set('spmode', 'pc'); } catch {}
    }

    return url.toString();
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
    return slots
      .slice()
      .sort((a, b) => (a.id - b.id))
      .map(x => `${x.id}|${x.diaryUrl}`)
      .join(',');
  }

  function notifyPushed(ids) {
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

  function parseLatestByUrlKind(diaryUrl, html) {
    let host = '';
    try { host = new URL(diaryUrl).hostname || ''; } catch { host = ''; }

    if (isDtoHost(host)) {
      return parseLatestTsUtcMsFromHtmlDto(html);
    }
    return parseLatestTsUtcMsFromHtmlHeaven(html);
  }

  // ★forceNoCache=true の時は kb_diary_cache を見ずに必ず取りに行く
  async function workerFetchOne(task, forceNoCache) {
    const { id, diaryUrl } = task;

    if (!forceNoCache) {
      const c = getCached(diaryUrl);
      if (c) {
        return { id, latest_ts: c.latestTs, error: c.error || '', checked_at_ms: nowMs() };
      }
    }

    // 通常運用だけ軽いジッター（forceは最速を優先）
    if (!forceNoCache) {
      await sleep(250 + Math.floor(Math.random() * 350));
    }

    const r = await gmGet(diaryUrl);
    if (!r.ok) {
      const err = r.error || 'gm_error';
      setCached(diaryUrl, null, err); // force時も更新して次回安定
      return { id, latest_ts: null, error: err, checked_at_ms: nowMs() };
    }

    if ((r.status || 0) >= 400) {
      const err = `http_${r.status || 0}`;
      setCached(diaryUrl, null, err);
      return { id, latest_ts: null, error: err, checked_at_ms: nowMs() };
    }

    const parsed = parseLatestByUrlKind(diaryUrl, r.text);
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

  // ★最強ボタン用：forceを“予約”できるようにする（押したのに無反応を防ぐ）
  let forceQueued = false;

  function hasAnyUncached(slots) {
    for (const s of slots) {
      if (!getCached(s.diaryUrl)) return true;
    }
    return false;
  }

  async function runOnce(reason) {
    const forceNoCache = (String(reason || '') === 'force');

    // ★forceは実行中でも「予約」して、終わった直後に必ずもう一度回す
    if (running) {
      if (forceNoCache) {
        forceQueued = true;
      }
      return;
    }

    const slots = collectSlots();
    if (!slots.length) return;

    const now = nowMs();
    const intervalOk = (!lastRunAt || (now - lastRunAt) >= MIN_RUN_INTERVAL_MS);

    // 通常運用のみ 10分ガード（forceは完全無視）
    if (!forceNoCache) {
      if (!intervalOk && !hasAnyUncached(slots)) {
        return;
      }
    }

    running = true;

    // ★通常運用だけ lastRunAt を更新（forceは更新しない＝連打しても毎回最強）
    if (!forceNoCache) {
      lastRunAt = now;
    }

    try {
      const tasks = slots.map(s => ({ id: s.id, diaryUrl: s.diaryUrl }));
      const results = [];
      let idx = 0;

      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (idx < tasks.length) {
          const t = tasks[idx++];
          const r = await workerFetchOne(t, forceNoCache);
          results.push(r);
        }
      });

      await Promise.all(workers);

      const ok = await pushResults(results);
      if (ok) notifyPushed(results.map(x => x.id));
    } catch (_) {
      // 失敗しても暴走しない
    } finally {
      running = false;

      // ★forceが予約されていたら、直ちにもう一度forceを実行（最強保証）
      if (forceQueued) {
        forceQueued = false;
        // 直列化のため tick を挟む
        setTimeout(() => {
          runOnce('force').catch(() => {});
        }, 0);
      }
    }
  }

  // ===== 起動＆監視（slot集合が変わった時だけ走る） =====
  let lastSig = '';
  let timer = null;

  function schedule(reason) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      runOnce(reason).catch(() => {});
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

  checkSlotsChangedAndSchedule();

  const mo = new MutationObserver((mutations) => {
    let touched = false;
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      if ((m.addedNodes && m.addedNodes.length) || (m.removedNodes && m.removedNodes.length)) {
        touched = true;
        break;
      }
    }
    if (!touched) return;
    checkSlotsChangedAndSchedule();
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    runOnce('interval').catch(() => {});
  }, MIN_RUN_INTERVAL_MS);

  // ★手動で「今すぐ取得→push」したい時の最強ボタン
  // - ガード完全無視
  // - キャッシュ無視
  // - 実行中でも予約して“必ず通す”
  window.kbDiaryForcePush = () => {
    // すでに走っているなら予約だけ（終わった直後にforceが必ず走る）
    if (running) {
      forceQueued = true;
      return;
    }
    runOnce('force').catch(() => {});
  };

})();
