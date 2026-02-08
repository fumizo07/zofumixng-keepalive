// ==UserScript==
// @name         KB Diary Client Fetch (push to server)
// @namespace    kb-diary
// @version      0.3.22
// @description  Fetch diary latest timestamp in real browser and push to KB server (DOM CustomEvent bridge, epoch force, stage signals; pushed=kb:diary:pushed only)
// @match        https://*/kb*
// @grant        GM_xmlhttpRequest
// @connect      www.cityheaven.net
// @connect      cityheaven.net
// @connect      www.dto.jp
// @connect      dto.jp
// @connect      s.dto.jp
// ==/UserScript==
// 018

(() => {
  "use strict";

  // ============================================================
  // Bridge events (DOM CustomEvent)
  // ============================================================
  const EV_FORCE = "kb:diary:force";
  const EV_SIGNAL = "kb:diary:signal";
  const EV_PUSHED2 = "kb:diary:pushed"; // ★統一

  // ============================================================
  // Guard (shared secret)
  // ============================================================
  const KB_ALLOW_META_NAME = "kb-allow-konbankonban";
  const KB_ALLOW_LS_KEY = "kb_allow_secret_v1";
  const KB_ALLOW_PROMPT_MSG = "合言葉を入力してください";

  function getLocalSecret() {
    try { return String(localStorage.getItem(KB_ALLOW_LS_KEY) || "").trim(); } catch { return ""; }
  }
  function setLocalSecret(v) {
    try { localStorage.setItem(KB_ALLOW_LS_KEY, String(v || "").trim()); } catch {}
  }
  function clearLocalSecret() {
    try { localStorage.removeItem(KB_ALLOW_LS_KEY); } catch {}
  }
  function getMetaSecret() {
    const el = document.querySelector(`meta[name="${KB_ALLOW_META_NAME}"]`);
    if (!el) return "";
    return String(el.getAttribute("content") || "").trim();
  }
  function ensureAllowSecret() {
    const meta = getMetaSecret();
    if (!meta) return false;

    let sec = getLocalSecret();
    if (sec && sec !== meta) {
      clearLocalSecret();
      sec = "";
    }

    if (!sec) {
      const input = prompt(KB_ALLOW_PROMPT_MSG);
      sec = String(input || "").trim();
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

  // ============================================================
  // GM availability
  // ============================================================
  const gmOk = (typeof GM_xmlhttpRequest === "function");

  // ============================================================
  // Config
  // ============================================================
  const PUSH_ENDPOINT = "/kb/api/diary_push";
  const CSRF_INIT_ENDPOINT = "/kb/api/csrf_init";
  const CSRF_COOKIE_NAME = "kb_csrf";
  const CSRF_HEADER_NAME = "X-KB-CSRF";

  const CACHE_TTL_MS = 10 * 60 * 1000;
  const MIN_RUN_INTERVAL_MS = 10 * 60 * 1000;
  const MAX_IDS = 30;
  const CONCURRENCY = 2;

  const nowMs = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ============================================================
  // Signals (for kb_diary_show.js)
  // ============================================================
  function emit(stage, detail) {
    const payload = { stage, at: nowMs(), ...(detail || {}) };
    try { window.__kbDiaryLastSignal = payload; } catch (_) {}

    try { document.dispatchEvent(new CustomEvent(EV_SIGNAL, { detail: payload })); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent(EV_SIGNAL, { detail: payload })); } catch (_) {}
  }

  function broadcastPushed(ids, rid, epoch) {
    const detail = { ids: Array.isArray(ids) ? ids : [], rid: String(rid || ""), epoch: Number(epoch || 0) };
    try { document.dispatchEvent(new CustomEvent(EV_PUSHED2, { detail })); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent(EV_PUSHED2, { detail })); } catch (_) {}
  }

  // ============================================================
  // LocalStorage cache
  // ============================================================
  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }
  function cacheKeyForUrl(url) {
    return "kb_diary_cache:" + url;
  }
  function getCached(url) {
    const k = cacheKeyForUrl(url);
    const v = lsGet(k);
    if (!v || typeof v !== "object") return null;
    if (!v.savedAt || (nowMs() - v.savedAt) > CACHE_TTL_MS) return null;
    return v;
  }
  function setCached(url, latestTs, error) {
    const k = cacheKeyForUrl(url);
    lsSet(k, { savedAt: nowMs(), latestTs: latestTs ?? null, error: error || "" });
  }

  // ============================================================
  // Cookies / CSRF
  // ============================================================
  function getCookie(name) {
    const all = String(document.cookie || "");
    if (!all) return "";
    const parts = all.split(";");
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      const eq = s.indexOf("=");
      if (eq <= 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1);
      if (k === name) return decodeURIComponent(v || "");
    }
    return "";
  }

  async function ensureCsrf() {
    if (getCookie(CSRF_COOKIE_NAME)) return true;

    try {
      const r = await fetch(CSRF_INIT_ENDPOINT, {
        method: "GET",
        credentials: "same-origin",
        headers: { "Accept": "application/json" },
        cache: "no-store",
      });
      if (!r.ok) return false;
    } catch (_) {
      return false;
    }

    return !!getCookie(CSRF_COOKIE_NAME);
  }

  // ============================================================
  // GM GET
  // ============================================================
  function gmGet(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        anonymous: false,
        timeout: 25000,
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
          "Upgrade-Insecure-Requests": "1",
        },
        onload: (res) => resolve({ ok: true, status: res.status, text: res.responseText || "" }),
        ontimeout: () => resolve({ ok: false, status: 0, text: "", error: "timeout" }),
        onerror: () => resolve({ ok: false, status: 0, text: "", error: "network_error" }),
      });
    });
  }

  // ============================================================
  // Parsers (Heaven / DTO)
  // ============================================================
  const RE_MMDD_HHMM = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/;
  const RE_DIARY_TIME_SPAN = /<span[^>]*class="[^"]*\bdiary_time\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;

  const RE_REGIST_TIME_SPAN = /<span[^>]*class="[^"]*\bregist_time\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  const RE_JP_MMDD_HHMM = /(\d{1,2})月\s*(\d{1,2})日(?:\s*\([^)]+\))?\s*(\d{1,2}):(\d{2})/;

  const RE_YEARMON = /(\d{4})年\s*(\d{1,2})月/;
  const RE_YEAR = /(\d{4})年/;

  function extractYearMonth(text) {
    const m = (text || "").match(RE_YEARMON);
    if (!m) return { y: null, mo: null };
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12) return { y, mo };
    return { y: null, mo: null };
  }

  function extractYearOnly(text) {
    const m = (text || "").match(RE_YEAR);
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
    if (!html) return { ts: null, err: "empty_html" };

    const ym = extractYearMonth(html);
    const headerY = ym.y;
    const headerMo = ym.mo;

    let maxTs = null;
    let foundAny = false;

    let mSpan;
    while ((mSpan = RE_DIARY_TIME_SPAN.exec(html)) !== null) {
      const inner = String(mSpan[1] || "").replace(/<[^>]+>/g, " ").trim();
      const m = inner.match(RE_MMDD_HHMM);
      if (!m) continue;

      foundAny = true;

      const mm = parseInt(m[1], 10);
      const dd = parseInt(m[2], 10);
      const hh = parseInt(m[3], 10);
      const mi = parseInt(m[4], 10);

      if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59)) continue;

      let y = guessYear(headerY, headerMo, mm);
      if (y == null) y = new Date().getFullYear();

      const iso = `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00+09:00`;
      const ts = new Date(iso).getTime();

      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (maxTs == null || ts > maxTs) maxTs = ts;
    }

    if (!foundAny) return { ts: null, err: "no_diary_time_found" };
    if (maxTs == null) return { ts: null, err: "diary_time_parse_failed" };
    return { ts: maxTs, err: "" };
  }

  function parseLatestTsUtcMsFromHtmlDto(html) {
    if (!html) return { ts: null, err: "empty_html" };

    const ym = extractYearMonth(html);
    let headerY = ym.y;
    const headerMo = ym.mo;

    if (headerY == null) headerY = extractYearOnly(html);

    let maxTs = null;
    let foundAny = false;

    let mSpan;
    while ((mSpan = RE_REGIST_TIME_SPAN.exec(html)) !== null) {
      const inner = String(mSpan[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const m = inner.match(RE_JP_MMDD_HHMM);
      if (!m) continue;

      foundAny = true;

      const mm = parseInt(m[1], 10);
      const dd = parseInt(m[2], 10);
      const hh = parseInt(m[3], 10);
      const mi = parseInt(m[4], 10);

      if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59)) continue;

      let y = guessYear(headerY, headerMo, mm);
      if (y == null) y = new Date().getFullYear();

      const iso = `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00+09:00`;
      const ts = new Date(iso).getTime();

      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (maxTs == null || ts > maxTs) maxTs = ts;
    }

    if (!foundAny) return { ts: null, err: "no_regist_time_found" };
    if (maxTs == null) return { ts: null, err: "regist_time_parse_failed" };
    return { ts: maxTs, err: "" };
  }

  function isDtoHost(host) {
    const h = String(host || "").toLowerCase();
    return h === "dto.jp" || h.endsWith(".dto.jp");
  }

  function normalizeDiaryUrl(u) {
    const raw = String(u || "").trim();
    if (!raw) return "";

    let url;
    try {
      url = raw.startsWith("http://") || raw.startsWith("https://")
        ? new URL(raw)
        : new URL(raw, "https://www.cityheaven.net");
    } catch (_) {
      return "";
    }

    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/diary")) url.pathname += "/diary";

    if (isDtoHost(url.hostname)) {
      url.protocol = "https:";
      url.hostname = "www.dto.jp";
      try { url.searchParams.delete("pcmode"); } catch {}
      try { url.searchParams.delete("spmode"); } catch {}
    } else {
      try { url.searchParams.delete("pcmode"); } catch {}
      try { url.searchParams.set("spmode", "pc"); } catch {}
    }

    return url.toString();
  }

  function isTrackedSlot(el) {
    const v = String(el.getAttribute("data-diary-track") || "1").trim();
    return v === "1";
  }

  function collectSlots() {
    const nodes = Array.from(document.querySelectorAll("[data-kb-diary-slot][data-person-id]"));
    const out = [];
    for (const el of nodes) {
      if (!isTrackedSlot(el)) continue;

      const pid = parseInt(el.getAttribute("data-person-id") || "0", 10);
      const du = normalizeDiaryUrl(el.getAttribute("data-diary-url") || "");
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

  function parseLatestByUrlKind(diaryUrl, html) {
    let host = "";
    try { host = new URL(diaryUrl).hostname || ""; } catch { host = ""; }
    if (isDtoHost(host)) return parseLatestTsUtcMsFromHtmlDto(html);
    return parseLatestTsUtcMsFromHtmlHeaven(html);
  }

  // ============================================================
  // Push
  // ============================================================
  async function pushResults(batch, epoch, rid) {
    if (epoch !== activeEpoch) {
      emit("push_skip_stale_epoch", { rid, epoch, activeEpoch });
      return { ok: false, status: 0, reason: "stale_epoch" };
    }

    emit("push_start", { rid, epoch, items: Array.isArray(batch) ? batch.length : 0 });

    const okCsrf = await ensureCsrf();
    if (!okCsrf) {
      emit("push_abort_no_csrf", { rid, epoch });
      return { ok: false, status: 0, reason: "no_csrf" };
    }

    const csrf = getCookie(CSRF_COOKIE_NAME);
    if (!csrf) {
      emit("push_abort_cookie_empty", { rid, epoch });
      return { ok: false, status: 0, reason: "cookie_empty" };
    }

    try {
      emit("push_fetch_start", { rid, epoch });
      const res = await fetch(PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [CSRF_HEADER_NAME]: csrf,
        },
        body: JSON.stringify({ items: batch }),
        credentials: "same-origin",
        cache: "no-store",
      });

      emit("push_fetch_done", { rid, epoch, ok: !!res.ok, status: res.status });
      return { ok: !!res.ok, status: res.status, reason: res.ok ? "" : "http_error" };
    } catch (e) {
      emit("push_fetch_error", { rid, epoch, msg: String(e && e.message ? e.message : e) });
      return { ok: false, status: 0, reason: "exception" };
    }
  }

  // ============================================================
  // Worker
  // ============================================================
  async function workerFetchOne(task, forceNoCache, epoch) {
    const { id, diaryUrl } = task;

    if (epoch !== activeEpoch) {
      return { id, latest_ts: null, error: "stale_epoch", checked_at_ms: nowMs() };
    }

    if (!forceNoCache) {
      const c = getCached(diaryUrl);
      if (c) return { id, latest_ts: c.latestTs, error: c.error || "", checked_at_ms: nowMs() };
    }

    await sleep(250 + Math.floor(Math.random() * 350));

    if (epoch !== activeEpoch) {
      return { id, latest_ts: null, error: "stale_epoch", checked_at_ms: nowMs() };
    }

    const r = await gmGet(diaryUrl);
    if (!r.ok) {
      const err = r.error || "gm_error";
      setCached(diaryUrl, null, err);
      return { id, latest_ts: null, error: err, checked_at_ms: nowMs() };
    }

    if ((r.status || 0) >= 400) {
      const err = `http_${r.status || 0}`;
      setCached(diaryUrl, null, err);
      return { id, latest_ts: null, error: err, checked_at_ms: nowMs() };
    }

    const parsed = parseLatestByUrlKind(diaryUrl, r.text);
    if (parsed.ts != null && !parsed.err) {
      setCached(diaryUrl, parsed.ts, "");
      return { id, latest_ts: parsed.ts, error: "", checked_at_ms: nowMs() };
    } else {
      setCached(diaryUrl, null, parsed.err || "parse_failed");
      return { id, latest_ts: null, error: parsed.err || "parse_failed", checked_at_ms: nowMs() };
    }
  }

  // ============================================================
  // Runner (epoch force)
  // ============================================================
  let running = false;
  let lastRunAt = 0;

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
    const options = opt && typeof opt === "object" ? opt : {};
    const rid = String(options.rid || "");
    const forceNoCache = (String(reason || "") === "force") || !!options.forceNoCache;
    const ignoreRunning = !!options.ignoreRunning;
    const epoch = (options.epoch != null) ? Number(options.epoch) : activeEpoch;

    if (!ignoreRunning && running) {
      emit("run_blocked_running", { rid, reason, epoch, activeEpoch });
      return;
    }

    if (!gmOk) {
      emit("gm_unavailable", { rid, reason, epoch, activeEpoch });
      return;
    }

    const slots = collectSlots();
    if (!slots.length) {
      emit("run_abort_no_slots", { rid, reason, epoch, activeEpoch });
      return;
    }

    const now = nowMs();
    const intervalOk = (!lastRunAt || (now - lastRunAt) >= MIN_RUN_INTERVAL_MS);

    if (!forceNoCache) {
      if (!intervalOk && !hasAnyUncached(slots)) {
        emit("run_guard_interval_block", { rid, reason, epoch, sinceMs: (now - lastRunAt) });
        return;
      }
    }

    if (epoch !== activeEpoch) {
      emit("run_blocked_epoch", { rid, reason, epoch, activeEpoch });
      return;
    }

    running = true;
    lastRunAt = now;

    emit("run_start", { rid, reason, epoch, slot_count: slots.length });

    try {
      const tasks = slots.map((s) => ({ id: s.id, diaryUrl: s.diaryUrl }));
      const results = [];
      let idx = 0;

      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          if (epoch !== activeEpoch) break;
          if (idx >= tasks.length) break;
          const t = tasks[idx++];
          const r = await workerFetchOne(t, forceNoCache, epoch);
          results.push(r);
        }
      });

      await Promise.all(workers);

      if (epoch !== activeEpoch) {
        emit("run_abort_stale_epoch", { rid, reason, epoch, activeEpoch });
        return;
      }

      const pushRes = await pushResults(results, epoch, rid);
      if (pushRes.ok) {
        broadcastPushed(results.map((x) => x.id), rid, epoch);
      } else {
        emit("push_failed", { rid, epoch, status: pushRes.status || 0, reason: pushRes.reason || "" });
      }

      emit("done", { rid, epoch, ok: !!pushRes.ok, status: pushRes.status || 0 });
    } finally {
      if (epoch === activeEpoch) running = false;
    }
  }

  // ============================================================
  // Start & watch (auto)
  // ============================================================
  let lastSig = "";
  let timer = null;

  function computeSlotsSignature(slots) {
    return slots
      .slice()
      .sort((a, b) => (a.id - b.id))
      .map((x) => `${x.id}|${x.diaryUrl}`)
      .join(",");
  }

  function schedule(reason) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      runOnce(reason, { epoch: activeEpoch, ignoreRunning: false, rid: "" }).catch(() => {});
    }, 600);
  }

  function checkSlotsChangedAndSchedule() {
    const slots = collectSlots();
    const sig = computeSlotsSignature(slots);
    if (!sig) return;
    if (sig === lastSig) return;
    lastSig = sig;
    schedule("slots_changed");
  }

  nextEpoch();
  checkSlotsChangedAndSchedule();

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== "childList") continue;
      if ((m.addedNodes && m.addedNodes.length) || (m.removedNodes && m.removedNodes.length)) {
        checkSlotsChangedAndSchedule();
        return;
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    runOnce("interval", { epoch: activeEpoch, ignoreRunning: false, rid: "" }).catch(() => {});
  }, MIN_RUN_INTERVAL_MS);

  // ============================================================
  // Force (DOM event)
  // ============================================================
  let lastForceAt = 0;
  const FORCE_DEBOUNCE_MS = 500;

  function onForceEvent(ev) {  
    const d = ev && ev.detail ? ev.detail : {};
    const rid = String(d.rid || "");
    const origin = String(d.origin || "");
    const now = nowMs();

    emit("force_received", { rid, origin });

    if (!gmOk) {
      emit("gm_unavailable", { rid, origin });
      return;
    }

    if (now - lastForceAt < FORCE_DEBOUNCE_MS) {
      emit("force_debounced", { rid, ms: (now - lastForceAt) });
      return;
    }
    lastForceAt = now;

    const newEp = nextEpoch();
    lastRunAt = 0;

    emit("force_accept", { rid, newEpoch: newEp });
    runOnce("force", { epoch: newEp, ignoreRunning: true, forceNoCache: true, rid }).catch(() => {});
  }

  try { document.addEventListener(EV_FORCE, onForceEvent, { passive: true }); } catch (_) {}
  try { window.addEventListener(EV_FORCE, onForceEvent, { passive: true }); } catch (_) {}
})();
