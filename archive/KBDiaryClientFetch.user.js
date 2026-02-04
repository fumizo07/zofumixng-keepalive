// ==UserScript==
// @name         KB Diary Client Fetch (push to server)
// @namespace    kb-diary
// @version      0.3.16
// @description  Fetch diary latest timestamp in real browser and push to KB server (debug phases, hard-force epoch)
// @match        https://*/kb*
// @grant        GM_xmlhttpRequest
// @connect      www.cityheaven.net
// @connect      cityheaven.net
// @connect      www.dto.jp
// @connect      dto.jp
// @connect      s.dto.jp
// ==/UserScript==
// 013

(() => {
  'use strict';

  // ============================================================
  // Debug ring buffer (persistent)
  // ============================================================
  const DBG_RING_KEY = 'kb_diary_debug_ring_v1';
  const DBG_RING_MAX = 120;

  function dbgNow() { return Date.now(); }

  function dbgLoadRing() {
    try {
      const raw = localStorage.getItem(DBG_RING_KEY);
      if (!raw) return [];
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a : [];
    } catch (_) {
      return [];
    }
  }
  function dbgSaveRing(a) {
    try { localStorage.setItem(DBG_RING_KEY, JSON.stringify(a)); } catch (_) {}
  }

  function dbgPush(entry) {
    const e = { t: dbgNow(), ...entry };
    try { console.log('[kb-diary][DBG]', e); } catch (_) {}
    try {
      const ring = dbgLoadRing();
      ring.push(e);
      while (ring.length > DBG_RING_MAX) ring.shift();
      dbgSaveRing(ring);
    } catch (_) {}
    try { window.kbDiaryDebugLast = e; } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('kb-diary-debug', { detail: e })); } catch (_) {}
  }

  function dbgPhase(phase, extra) {
    dbgPush({ phase, ...(extra || {}) });
  }

  try {
    window.kbDiaryDebugDump = () => {
      try { return dbgLoadRing(); } catch (_) { return []; }
    };
  } catch (_) {}

  // ============================================================
  // ====== 共有シークレット（合言葉）で自サイト判定 ======
  // ============================================================
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
    if (!meta) {
      dbgPhase('guard:no_meta');
      return false;
    }

    let sec = getLocalSecret();

    if (sec && sec !== meta) {
      dbgPhase('guard:ls_mismatch', { had: true });
      clearLocalSecret();
      sec = '';
    }

    if (!sec) {
      dbgPhase('guard:prompt');
      const input = prompt(KB_ALLOW_PROMPT_MSG);
      sec = String(input || '').trim();
      if (!sec) {
        dbgPhase('guard:prompt_cancel');
        clearLocalSecret();
        return false;
      }
      setLocalSecret(sec);
    }

    const ok = (sec === meta);
    dbgPhase('guard:ok_check', { ok });
    if (!ok) clearLocalSecret();
    return ok;
  }

  dbgPhase('boot');

  if (!ensureAllowSecret()) {
    dbgPhase('exit:guard_failed');
    return;
  }

  // ============================================================
  // GM availability
  // ============================================================
  const gmOk = (typeof GM_xmlhttpRequest === 'function');
  dbgPhase('gm:check', { gmOk, gmType: typeof GM_xmlhttpRequest });

  if (!gmOk) {
    console.warn('[kb-diary] GM_xmlhttpRequest is not available in this browser.');
    window.kbDiaryForcePush = () => {
      dbgPhase('force:blocked_no_gm');
      alert('このブラウザは GM_xmlhttpRequest 非対応のため、日記の外部取得ができません。');
    };
    dbgPhase('exit:no_gm');
    return;
  }

  // ============================================================
  // ====== 設定 ======
  // ============================================================
  const PUSH_ENDPOINT = '/kb/api/diary_push';
  const CSRF_INIT_ENDPOINT = '/kb/api/csrf_init';
  const CSRF_COOKIE_NAME = 'kb_csrf';
  const CSRF_HEADER_NAME = 'X-KB-CSRF';

  const CACHE_TTL_MS = 10 * 60 * 1000;        // 10分（外部サイト取得キャッシュ）
  const MIN_RUN_INTERVAL_MS = 10 * 60 * 1000; // 10分（interval等の暴走防止）
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
    const existing = getCookie(CSRF_COOKIE_NAME);
    dbgPhase('csrf:check', { has: !!existing });

    if (existing) return true;

    try {
      dbgPhase('csrf:init_fetch:start', { url: CSRF_INIT_ENDPOINT });
      const r = await fetch(CSRF_INIT_ENDPOINT, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
      });
      dbgPhase('csrf:init_fetch:done', { ok: r.ok, status: r.status });
      if (!r.ok) return false;
    } catch (e) {
      dbgPhase('csrf:init_fetch:error', { msg: String(e && e.message ? e.message : e) });
      return false;
    }

    const after = getCookie(CSRF_COOKIE_NAME);
    dbgPhase('csrf:after', { has: !!after });
    return !!after;
  }

  function gmGet(url) {
    return new Promise((resolve) => {
      dbgPhase('gm:get:start', { url });

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
        onload: (res) => {
          dbgPhase('gm:get:done', { url, status: res.status, len: (res.responseText || '').length });
          resolve({ ok: true, status: res.status, text: res.responseText || '' });
        },
        ontimeout: () => {
          dbgPhase('gm:get:timeout', { url });
          resolve({ ok: false, status: 0, text: '', error: 'timeout' });
        },
        onerror: () => {
          dbgPhase('gm:get:error', { url });
          resolve({ ok: false, status: 0, text: '', error: 'network_error' });
        },
      });
    });
  }

  // ====== パース（ヘブン / DTO で分岐） ======

  const RE_MMDD_HHMM = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/;
  const RE_DIARY_TIME_SPAN = /<span[^>]*class="[^"]*\bdiary_time\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;

  const RE_REGIST_TIME_SPAN = /<span[^>]*class="[^"]*\bregist_time\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  const RE_JP_MMDD_HHMM = /(\d{1,2})月\s*(\d{1,2})日(?:\s*\([^)]+\))?\s*(\d{1,2}):(\d{2})/;

  const RE_YEARMON = /(\d{4})年\s*(\d{1,2})月/;
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

    url.pathname = url.pathname.replace(/\/+$/, '');
    if (!url.pathname.endsWith('/diary')) {
      url.pathname += '/diary';
    }

    if (isDtoHost(url.hostname)) {
      url.protocol = 'https:';
      url.hostname = 'www.dto.jp';
      try { url.searchParams.delete('pcmode'); } catch {}
      try { url.searchParams.delete('spmode'); } catch {}
    } else {
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

  function parseLatestByUrlKind(diaryUrl, html) {
    let host = '';
    try { host = new URL(diaryUrl).hostname || ''; } catch { host = ''; }

    if (isDtoHost(host)) {
      return parseLatestTsUtcMsFromHtmlDto(html);
    }
    return parseLatestTsUtcMsFromHtmlHeaven(html);
  }

  async function pushResults(batch, epoch) {
    // ★強制中断：epochが古いrunはpushさせない
    if (epoch !== activeEpoch) {
      dbgPhase('push:skip_stale_epoch', { epoch, activeEpoch });
      return false;
    }

    dbgPhase('push:start', { items: Array.isArray(batch) ? batch.length : -1, epoch });

    const okCsrf = await ensureCsrf();
    dbgPhase('push:csrf_ready', { ok: okCsrf, epoch });

    if (!okCsrf) {
      dbgPhase('push:abort_no_csrf', { epoch });
      return false;
    }

    const csrf = getCookie(CSRF_COOKIE_NAME);
    dbgPhase('push:csrf_cookie', { has: !!csrf, epoch });

    if (!csrf) {
      dbgPhase('push:abort_cookie_empty', { epoch });
      return false;
    }

    try {
      dbgPhase('push:fetch:start', { url: PUSH_ENDPOINT, epoch });

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

      let j = null;
      try { j = await res.json(); } catch (_) {}

      dbgPhase('push:fetch:done', {
        ok: res.ok,
        status: res.status,
        hasJson: !!j,
        epoch,
      });

      return res.ok;
    } catch (e) {
      dbgPhase('push:fetch:error', { msg: String(e && e.message ? e.message : e), epoch });
      return false;
    }
  }

  // ★forceNoCache=true の時は kb_diary_cache を見ずに必ず取りに行く
  async function workerFetchOne(task, forceNoCache, epoch) {
    const { id, diaryUrl } = task;

    // ★強制中断：epochが古いrunはここで終了扱い
    if (epoch !== activeEpoch) {
      dbgPhase('worker:abort_stale_epoch', { id, epoch, activeEpoch });
      return { id, latest_ts: null, error: 'stale_epoch', checked_at_ms: nowMs() };
    }

    dbgPhase('worker:start', { id, forceNoCache, epoch });

    if (!forceNoCache) {
      const c = getCached(diaryUrl);
      if (c) {
        dbgPhase('worker:cache_hit', { id, epoch });
        return { id, latest_ts: c.latestTs, error: c.error || '', checked_at_ms: nowMs() };
      }
    }

    await sleep(250 + Math.floor(Math.random() * 350));

    // もう一回チェック（sleepの間にforceでepochが切り替わることがある）
    if (epoch !== activeEpoch) {
      dbgPhase('worker:abort_stale_epoch_after_sleep', { id, epoch, activeEpoch });
      return { id, latest_ts: null, error: 'stale_epoch', checked_at_ms: nowMs() };
    }

    const r = await gmGet(diaryUrl);
    if (!r.ok) {
      const err = r.error || 'gm_error';
      dbgPhase('worker:gm_fail', { id, err, epoch });
      setCached(diaryUrl, null, err);
      return { id, latest_ts: null, error: err, checked_at_ms: nowMs() };
    }

    if ((r.status || 0) >= 400) {
      const err = `http_${r.status || 0}`;
      dbgPhase('worker:http_fail', { id, err, epoch });
      setCached(diaryUrl, null, err);
      return { id, latest_ts: null, error: err, checked_at_ms: nowMs() };
    }

    const parsed = parseLatestByUrlKind(diaryUrl, r.text);
    dbgPhase('worker:parsed', {
      id,
      ok: (parsed.ts != null && !parsed.err),
      err: parsed.err || '',
      ts: parsed.ts != null ? String(parsed.ts) : '',
      epoch,
    });

    if (parsed.ts != null && !parsed.err) {
      setCached(diaryUrl, parsed.ts, '');
      return { id, latest_ts: parsed.ts, error: '', checked_at_ms: nowMs() };
    } else {
      setCached(diaryUrl, null, parsed.err || 'parse_failed');
      return { id, latest_ts: null, error: parsed.err || 'parse_failed', checked_at_ms: nowMs() };
    }
  }

  // ============================================================
  // Runner
  // ============================================================
  let running = false;
  let lastRunAt = 0;

  // ★epoch：force押下で世代を切り替え、旧runを「強制終了扱い」にする
  let epochCounter = 0;
  let activeEpoch = 0;

  function nextEpoch() {
    epochCounter += 1;
    activeEpoch = epochCounter;
    return activeEpoch;
  }

  function hasAnyUncached(slots) {
    for (const s of slots) {
      if (!getCached(s.diaryUrl)) return true;
    }
    return false;
  }

  async function runOnce(reason, opt) {
    const options = opt && typeof opt === 'object' ? opt : {};
    const forceNoCache = (String(reason || '') === 'force') || !!options.forceNoCache;
    const ignoreRunning = !!options.ignoreRunning;
    const epoch = (options.epoch != null) ? Number(options.epoch) : activeEpoch;

    if (!ignoreRunning && running) {
      dbgPhase('run:skip_already_running', { reason, epoch, activeEpoch });
      return;
    }

    const slots = collectSlots();
    dbgPhase('run:slots', { reason, count: slots.length, epoch, activeEpoch });

    if (!slots.length) {
      dbgPhase('run:abort_no_slots', { reason, epoch });
      return;
    }

    const now = nowMs();
    const intervalOk = (!lastRunAt || (now - lastRunAt) >= MIN_RUN_INTERVAL_MS);

    if (!forceNoCache) {
      if (!intervalOk && !hasAnyUncached(slots)) {
        dbgPhase('run:guard_interval_block', { sinceMs: (now - lastRunAt), epoch });
        return;
      }
    }

    // ★epochが古いrunは開始直後に弾く
    if (epoch !== activeEpoch) {
      dbgPhase('run:abort_stale_epoch_before_start', { reason, epoch, activeEpoch });
      return;
    }

    running = true;
    lastRunAt = now;

    dbgPhase('run:start', { reason, forceNoCache, epoch });

    try {
      const tasks = slots.map(s => ({ id: s.id, diaryUrl: s.diaryUrl }));
      const results = [];
      let idx = 0;

      dbgPhase('run:workers_start', { concurrency: CONCURRENCY, epoch });

      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          // ★forceでepochが切り替わったらこのworkerは即終了
          if (epoch !== activeEpoch) {
            dbgPhase('worker:loop_abort_stale_epoch', { epoch, activeEpoch });
            break;
          }

          if (idx >= tasks.length) break;

          const t = tasks[idx++];
          const r = await workerFetchOne(t, forceNoCache, epoch);
          results.push(r);
        }
      });

      await Promise.all(workers);

      dbgPhase('run:fetched', {
        total: results.length,
        errors: results.filter(x => !!x.error && x.error !== 'stale_epoch').length,
        epoch,
        activeEpoch,
      });

      // ★epochが古いrunはpushしない
      if (epoch !== activeEpoch) {
        dbgPhase('run:skip_push_stale_epoch', { epoch, activeEpoch });
        return;
      }

      const ok = await pushResults(results, epoch);
      dbgPhase('run:pushed', { ok, epoch });

      if (ok) {
        notifyPushed(results.map(x => x.id));
        dbgPhase('run:notify_pushed', { ids: results.map(x => x.id).slice(0, 8).join(','), epoch });
      }
    } catch (e) {
      dbgPhase('run:error', { msg: String(e && e.message ? e.message : e), epoch });
    } finally {
      // ★epochが一致しているrunだけがrunningを戻す（古いrunが新しいrunを邪魔しない）
      if (epoch === activeEpoch) {
        running = false;
      }
      dbgPhase('run:done', { reason, epoch, activeEpoch, running });
    }
  }

  // ============================================================
  // Start & watch
  // ============================================================
  let lastSig = '';
  let timer = null;

  function schedule(reason) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // scheduleは「最新epoch」で走る
      runOnce(reason, { epoch: activeEpoch, ignoreRunning: false }).catch(() => {});
    }, 600);
  }

  function checkSlotsChangedAndSchedule() {
    const slots = collectSlots();
    const sig = computeSlotsSignature(slots);
    if (!sig) return;
    if (sig === lastSig) return;
    lastSig = sig;
    dbgPhase('slots:changed', { count: slots.length, epoch: activeEpoch });
    schedule('slots_changed');
  }

  // 初期epoch
  nextEpoch();
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
    // intervalは「今のepoch」で通常実行（running中はスキップ）
    runOnce('interval', { epoch: activeEpoch, ignoreRunning: false }).catch(() => {});
  }, MIN_RUN_INTERVAL_MS);

  // ============================================================
  // ★最強ボタン（force）：running無視・キャッシュ無視・必ず push まで走らせる
  // ============================================================
  window.kbDiaryForcePush = () => {
    const newEp = nextEpoch();

    dbgPhase('force:hard_called', {
      running,
      lastRunAgoMs: lastRunAt ? (nowMs() - lastRunAt) : -1,
      newEpoch: newEp,
    });

    // ★クールダウン等を完全無視したいので lastRunAt を無効化
    lastRunAt = 0;

    // ★ここが「最強」：running中でも即、別世代で開始（旧runはpushしない）
    runOnce('force', { epoch: newEp, ignoreRunning: true, forceNoCache: true }).catch(() => {});
  };

})();
