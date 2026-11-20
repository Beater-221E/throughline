/**
 * Panel backend for the memory settings section.
 *
 * Pure Node (no DSH imports) so it can be exercised outside the Harness:
 *   node -e "import('./service/settings.js').then(...)"
 *
 * Everything here reads the on-disk artifacts the indexer already writes
 * (ingest.json, watermark.json, the bucket manifest) plus file sizes; the only
 * writes are the pause flag and the purge/reindex actions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LOADED_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0';
  }
})();

/** Read the on-disk manifest so an update is visible before a restart. */
function diskVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return LOADED_VERSION;
  }
}

/** Last few ingest runs, newest first. */
function readHistory(store, limit = 5) {
  try {
    const lines = fs.readFileSync(path.join(store, 'history.jsonl'), 'utf8')
      .split('\n').filter(Boolean).slice(-limit).reverse();
    return lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function dirSize(dir, ext) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (ext && !name.endsWith(ext)) continue;
      total += sizeOf(path.join(dir, name));
    }
  } catch { /* missing */ }
  return total;
}

const REMOTE_SLUG = /\.dsh-remote-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([A-Za-z0-9_-]+)$/;

/**
 * Display form of a workspace slug. Remote workspaces carry the real remote
 * path as a base64 tail, which decodes unambiguously; local slugs do not
 * round-trip (hyphens vs separators), so they stay as-is with the marker
 * characters stripped.
 */
function prettyWorkspace(slug) {
  const raw = String(slug || '').replace(/^--/, '').replace(/--$/, '');
  const m = REMOTE_SLUG.exec(raw);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      if (/^(\/|[A-Za-z]:[\\/])/.test(decoded) && !decoded.includes('\u0000')) return decoded;
    } catch { /* fall through */ }
  }
  // Local slugs do not round-trip in general, but a decode that lands on an
  // existing directory is almost certainly the real path.
  const local = /^([A-Za-z])-(.+)$/.exec(raw);
  if (local) {
    const guess = `${local[1]}:\\${local[2].replace(/-/g, '\\')}`;
    try { if (fs.existsSync(guess)) return guess; } catch { /* ignore */ }
  }
  return raw;
}

export function createSettings(options) {
  const store = options.store;
  const dbPath = options.dbPath;
  const bucketDir = path.join(store, path.basename(dbPath, path.extname(dbPath)) + '.buckets');
  const statusFile = path.join(store, 'ingest.json');
  const excludeFile = path.join(store, 'exclude.json');
  const eventsFile = path.join(store, 'events.jsonl');
  // Baseline at construction: events written before this process started are
  // history, not new toasts.
  let eventsOffset = 0;
  try { eventsOffset = fs.statSync(eventsFile).size; } catch { eventsOffset = 0; }

  function readExclude() {
    const raw = readJson(excludeFile, {});
    return {
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces.map(String) : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions.map(String) : [],
      keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String).filter(Boolean) : [],
    };
  }

  function writeExclude(next) {
    writeJson(excludeFile, {
      workspaces: [...new Set(next.workspaces)].filter(Boolean),
      sessions: [...new Set(next.sessions)].filter(Boolean),
      keywords: [...new Set(next.keywords)].filter(Boolean),
    });
  }
  const watermarkFile = path.join(store, 'watermark.json');
  const controlFile = path.join(store, 'control.json');
  const manifestFile = path.join(bucketDir, 'manifest.json');
  const logFile = path.join(store, 'ingest.log');
  const statsFile = path.join(store, 'stats.json');
  let lastStatsSpawn = 0;

  // Recent trigger events for the toast feed. In-memory: a restart clears the
  // history and the client re-baselines against the newest id.
  const events = [];
  let nextEventId = 1;
  let lastIngestAt = 0;

  function record(event) {
    events.unshift({ id: nextEventId++, at: Date.now(), ...event });
    if (events.length > 30) events.pop();
    return events[0];
  }

  /** Drain events the ingest worker appended (per-session turn writes). */
  function syncExternalEvents() {
    try {
      const st = fs.statSync(eventsFile);
      if (st.size < eventsOffset) eventsOffset = 0;
      if (st.size === eventsOffset) return;
      const len = st.size - eventsOffset;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(eventsFile, 'r');
      fs.readSync(fd, buf, 0, len, eventsOffset);
      fs.closeSync(fd);
      eventsOffset = st.size;
      for (const line of buf.toString('utf8').split('\n')) {
        const text = line.trim();
        if (!text) continue;
        try {
          const e = JSON.parse(text);
          record({
            kind: e.kind || 'turns', session: e.session, ws: e.ws,
            turns: e.turns, sessions: e.sessions, full: e.full, at: e.at,
          });
        } catch { /* torn line */ }
      }
    } catch { /* no event log yet */ }
  }

  /** Turn a finished ingest run into one completion toast. */
  function trackIngest() {
    const st = readJson(statusFile, null);
    const at = Number(st?.at || 0);
    if (!at || at === lastIngestAt) return;
    lastIngestAt = at;
    if (st.phase === 'ready') {
      const c = control();
      if (c.failures || c.backoffUntil) {
        writeJson(controlFile, {
          ...c, ingestFailures: 0, backoffUntil: 0, updatedAt: Date.now(),
        });
      }
      record({
        kind: 'ingest-done',
        turns: st.turns ?? null,
        added: st.added ?? null,
        elapsedMs: st.elapsed_ms ?? null,
      });
    } else if (st.phase === 'error') {
      const c = control();
      const failures = c.failures + 1;
      const backoff = failures >= 2 ? Date.now() + 30 * 60_000 : 0;
      writeJson(controlFile, {
        ...c, ingestFailures: failures, backoffUntil: backoff, updatedAt: Date.now(),
      });
      record({
        kind: 'error',
        message: String(st.error || 'ingest failed').slice(0, 160),
        failures,
        backoffMin: backoff ? 30 : 0,
      });
    }
  }

  /** Ask the Python side for exact counts; never blocks a request. */
  function refreshStats() {
    let fresh = false;
    try { fresh = Date.now() - fs.statSync(statsFile).mtimeMs < 60_000; } catch { fresh = false; }
    if (fresh || Date.now() - lastStatsSpawn < 30_000) return;
    lastStatsSpawn = Date.now();
    try {
      const child = spawn(python, [service, 'stats', '--db', dbPath,
        '--model-dir', modelDir, '--out', statsFile], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
    } catch { /* the counters fall back to the manifest */ }
  }

  const python = options.python;
  const node = options.node;
  const service = options.service;
  const ingest = options.ingest;
  const home = options.home;
  const modelDir = options.modelDir;
  const minAgeSec = Number(options.minAgeSec ?? 120);

  function control() {
    const c = readJson(controlFile, {});
    return {
      paused: !!c.paused,
      notify: c.notify !== false,
      updatedAt: c.updatedAt || null,
      failures: Number(c.ingestFailures || 0),
      backoffUntil: Number(c.backoffUntil || 0),
    };
  }

  /** Ingest is allowed unless paused or inside a failure backoff window. */
  function canIngest() {
    const c = control();
    if (c.paused) return false;
    return !(c.backoffUntil && c.backoffUntil > Date.now());
  }

  function usageSummary() {
    const rows = (() => {
      try {
        return fs.readFileSync(path.join(store, 'usage.jsonl'), 'utf8')
          .split('\n').filter(Boolean).map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean);
      } catch { return []; }
    })();
    const ok = rows.filter((r) => r.ok !== false);
    const dayOf = (ts) => new Date(Number(ts) || 0).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const stats = readJson(path.join(store, 'session_stats.json'), {});
    const ctrl = control();
    const price = Number(ctrl.pricePerMTok || 0);
    let tokens = 0;
    let avoided = 0;
    const lat = [];
    const sources = new Set();
    const byDay = {};
    for (const r of ok) {
      const t = Number(r.tokens || 0);
      tokens += t;
      lat.push(Number(r.latency_ms || 0));
      const src = (r.sources || []).reduce((a, s0) => a + Number(stats[s0]?.tokens || 0), 0);
      avoided += Math.max(0, src - t);
      for (const s0 of r.sources || []) sources.add(s0);
      const d = dayOf(r.at);
      const e = byDay[d] || { calls: 0, tokens: 0 };
      e.calls += 1;
      e.tokens += t;
      byDay[d] = e;
    }
    const pct = (q) => {
      if (!lat.length) return 0;
      const a = [...lat].sort((x, y) => x - y);
      return Math.round(a[Math.min(a.length - 1, Math.floor(q * a.length))]);
    };
    const empty = ok.filter((r) => Number(r.turns || 0) === 0).length;
    const total = tokens + avoided;
    return {
      calls: ok.length,
      errors: rows.length - ok.length,
      callsToday: ok.filter((r) => dayOf(r.at) === today).length,
      tokensToday: ok.filter((r) => dayOf(r.at) === today).reduce((a, r) => a + Number(r.tokens || 0), 0),
      injectedTokens: tokens,
      turnsReturned: ok.reduce((a, r) => a + Number(r.turns || 0), 0),
      avgTokensPerCall: ok.length ? Math.round(tokens / ok.length) : 0,
      hitRate: ok.length ? Number(((ok.length - empty) / ok.length).toFixed(3)) : 0,
      emptyRate: ok.length ? Number((empty / ok.length).toFixed(3)) : 0,
      latencyP50: pct(0.5),
      latencyP95: pct(0.95),
      avoidedTokens: avoided,
      savedSeconds: Math.round(avoided / 300),
      share: total > 0 ? Number((tokens / total).toFixed(3)) : 0,
      distinctSessions: sources.size,
      pricePerMTok: price || null,
      cost: price > 0 ? Number((tokens * price / 1e6).toFixed(4)) : null,
      byDay: Object.entries(byDay).sort().slice(-7).map(([day, v]) => ({ day, ...v })),
    };
  }

  function readPinnedCount() {
    try {
      return fs.readFileSync(path.join(store, 'pinned.md'), 'utf8').split('\n')
        .filter((line) => line.trim().startsWith('- ')).length;
    } catch {
      return 0;
    }
  }

  function readGlossaryCount() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(store, 'glossary.json'), 'utf8'));
      return Object.keys(raw).length;
    } catch {
      return 0;
    }
  }

  function status() {
    syncExternalEvents();
    trackIngest();
    const ingestState = readJson(statusFile, null);
    const watermark = readJson(watermarkFile, { files: {} });
    const manifest = readJson(manifestFile, null);
    refreshStats();
    const stats = readJson(statsFile, null);
    const ctrl = control();
    const files = Object.entries(watermark.files || {});

    const byWorkspace = new Map();
    for (const [rel, meta] of files) {
      const ws = String(rel).split('/')[0];
      const entry = byWorkspace.get(ws) || { workspace: ws, label: prettyWorkspace(ws), sessions: 0, last: 0 };
      entry.sessions += 1;
      entry.last = Math.max(entry.last, Math.round(Number(meta?.mtime || 0)));
      byWorkspace.set(ws, entry);
    }
    const sources = [...byWorkspace.values()]
      .sort((a, b) => b.sessions - a.sessions || b.last - a.last)
      .map((e) => ({ workspace: e.workspace, label: e.label, sessions: e.sessions, last: e.last || null }));

    const buckets = Array.isArray(manifest?.buckets) ? manifest.buckets.length : 0;
    const turns = Number(manifest?.count || 0);
    const vectorsMb = dirSize(bucketDir, '.npz') / 1e6;

    return {
      ok: true,
      version: diskVersion(),
      loadedVersion: LOADED_VERSION,
      restartPending: diskVersion() !== LOADED_VERSION,
      service: options.serviceState ? options.serviceState() : null,
      history: readHistory(store, 5),
      paused: ctrl.paused,
      pausedAt: ctrl.updatedAt,
      notify: ctrl.notify,
      events: events.slice(0, 20),
      model: ingestState ? !!ingestState.model : true,
      phase: ingestState?.phase || (watermark.updatedAt ? 'ready' : 'idle'),
      lastIngest: ingestState
        ? {
          at: ingestState.at || null,
          phase: ingestState.phase,
          added: ingestState.added ?? null,
          turns: ingestState.turns ?? null,
          files: ingestState.files ?? null,
          elapsedMs: ingestState.elapsed_ms ?? null,
          error: ingestState.error ?? null,
        }
        : null,
      index: {
        turns: Number(stats?.turns ?? ingestState?.turns ?? turns),
        sessions: Number(stats?.sessions ?? ingestState?.sessions ?? files.length),
        buckets,
        cap: manifest?.cap ?? null,
        dbMb: Number(((sizeOf(dbPath) + sizeOf(`${dbPath}-wal`)) / 1e6).toFixed(2)),
        vectorsMb: Number(vectorsMb.toFixed(2)),
        logMb: Number((sizeOf(logFile) / 1e6).toFixed(2)),
      },
      revision: {
        manifestMtime: (() => {
          try { return fs.statSync(manifestFile).mtimeMs; } catch { return 0; }
        })(),
        count: turns,
        statsAt: Number(stats?.at || 0),
      },
      stale: !!(stats?.at && (() => {
        try { return stats.at < fs.statSync(manifestFile).mtimeMs; } catch { return false; }
      })()),
      backoffUntil: control().backoffUntil || 0,
      failures: control().failures,
      exclude: readExclude(),
      usage: usageSummary(),
      human: {
        pinned: readPinnedCount(),
        glossary: readGlossaryCount(),
        pinnedFile: path.join(store, 'pinned.md'),
        glossaryFile: path.join(store, 'glossary.json'),
      },
      sources: sources.slice(0, 12),
      sourceCount: sources.length,
      paths: { db: dbPath, store, home: options.home || null, profile: options.profileDir || null },
    };
  }

  function run(args, timeoutMs = 60_000) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(python, args, {
          stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
        });
      } catch (e) {
        return resolve({ code: -1, error: String(e) });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ code: -1, error: 'timeout' });
      }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, error: String(e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, error: null }); });
    });
  }

  async function purge() {
    for (const stale of [statsFile]) {
      try { fs.unlinkSync(stale); } catch { /* missing */ }
    }
    const r = await run([service, 'purge', '--db', dbPath, '--model-dir', modelDir], 120_000);
    if (r.code !== 0) throw new Error(r.error || `purge exited ${r.code}`);
  }

  function startIngest(full) {
    const argv = [ingest, '--db', dbPath, '--python', python, '--home', home,
      '--model-dir', modelDir, '--min-age', '0'];
    if (full) argv.push('--full');
    const child = spawn(node, argv, {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env },
    });
    child.unref();
    return child.pid;
  }

  async function action(name, payload = {}) {
    const at = Date.now();
    if (name === 'pause' || name === 'resume') {
      writeJson(controlFile, { ...control(), paused: name === 'pause', updatedAt: at });
      return { ok: true, action: name, status: status() };
    }
    if (name === 'exclude-add' || name === 'exclude-remove') {
      const kind = String(payload?.kind || '');
      const value = String(payload?.value || '').trim();
      if (!['workspaces', 'sessions', 'keywords'].includes(kind)) {
        throw new Error('kind must be workspaces | sessions | keywords');
      }
      if (!value) throw new Error('value is required');
      const rules = readExclude();
      if (name === 'exclude-add') {
        if (!rules[kind].includes(value)) rules[kind].push(value);
      } else {
        rules[kind] = rules[kind].filter((v) => v !== value);
      }
      writeExclude(rules);
      return { ok: true, action: name, status: status() };
    }
    if (name === 'notify-on' || name === 'notify-off') {
      writeJson(controlFile, { ...control(), notify: name === 'notify-on', updatedAt: at });
      return { ok: true, action: name, status: status() };
    }
    if (name === 'clear') {
      await purge();
      writeJson(controlFile, { ...control(), updatedAt: at });
      return { ok: true, action: name, status: status() };
    }
    if (name === 'reindex') {
      await purge();
      const pid = startIngest(true);
      return { ok: true, action: name, pid, status: status() };
    }
    throw new Error(`unknown action: ${name}`);
  }

  function json(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  function handleStatus(req, res) {
    try {
      json(res, 200, status());
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  function handleAction(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > 64 * 1024) { tooBig = true; json(res, 413, { ok: false, error: 'body too large' }); req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
      const name = parsed.action;
      if (!['pause', 'resume', 'clear', 'reindex', 'notify-on', 'notify-off',
        'exclude-add', 'exclude-remove'].includes(name)) {
        return json(res, 400, { ok: false, error: `unsupported action: ${name}` });
      }
      try {
        json(res, 200, await action(name, parsed));
      } catch (e) {
        json(res, 500, { ok: false, error: String(e?.message || e) });
      }
    });
  }

  return { status, action, handleStatus, handleAction, control, canIngest, record };
}
