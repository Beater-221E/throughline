/**
 * Throughline local memory — DSH Host plugin.
 *
 * One model-callable tool, `memory_search`, backed by a persistent Python child
 * process (SQLite FTS5 + bge-small int8 ONNX vectors) and a sharded vector store.
 * Nothing leaves the machine.
 *
 * Ingestion is automatic:
 *   - first load with an empty index -> full bootstrap in a detached worker;
 *   - every `agent/created` -> incremental check that indexes only finished
 *     sessions (the live session is always excluded; DSH owns it).
 */
import { createSettings } from './service/settings.js';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const name = 'throughline';
export const inject = ['tools'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, 'service', 'memory.py');
const INGEST = path.join(HERE, 'service', 'ingest.mjs');
const VENDOR = path.join(HERE, 'service', 'vendor');
const MODEL = path.join(HERE, 'service', 'model');

function detectPython(profileDir) {
  const candidates = [];
  if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON);
  const profile = profileDir || process.env.DSH_PROFILE_DIR;
  if (profile) {
    candidates.push(path.join(profile, '..', '..', 'dsh-runtimes',
      'dsh-primary-runtime', 'dependencies', 'python',
      process.platform === 'win32' ? 'python.exe' : 'python'));
  }
  candidates.push(process.platform === 'win32' ? 'python.exe' : 'python3', 'python');
  for (const c of candidates) {
    try {
      if (c.includes(path.sep) || c.includes('/')) {
        if (fs.existsSync(c)) return c;
      } else {
        return c;
      }
    } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function detectNode(profileDir) {
  if (process.env.DSH_NODE) return process.env.DSH_NODE;
  if (!process.versions.electron && path.basename(process.execPath).toLowerCase().startsWith('node')) {
    return process.execPath;
  }
  const profile = profileDir || process.env.DSH_PROFILE_DIR;
  if (profile) {
    const p = path.join(profile, '..', '..', 'dsh-runtimes',
      'dsh-primary-runtime', 'dependencies', 'node', 'bin',
      process.platform === 'win32' ? 'node.exe' : 'node');
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * The profile that loaded this bundle. `DSH_PROFILE_DIR` is present in shell
 * environments but not always in the Host process, so fall back to the
 * `@local/throughline` junction that points at this package.
 */
function detectProfileDir() {
  const fromEnv = process.env.DSH_PROFILE_DIR;
  if (fromEnv) return fromEnv;
  try {
    const base = path.join(os.homedir(), '.dsh', 'profiles');
    const self = fs.realpathSync(HERE).toLowerCase();
    for (const name of fs.readdirSync(base)) {
      const link = path.join(base, name, 'node_modules', '@local', 'throughline');
      try {
        if (fs.realpathSync(link).toLowerCase() === self) return path.join(base, name);
      } catch { /* not this profile */ }
    }
  } catch { /* ignore */ }
  return '';
}

function defaultDb(profileDir) {
  const base = profileDir || process.env.DSH_PROFILE_DIR || HERE;
  return path.join(base, 'storages', 'throughline', 'memory.sqlite');
}

function dshHome(profileDir) {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  if (profileDir) return path.resolve(profileDir, '..', '..');
  return path.join(os.homedir(), '.dsh');
}

export function apply(ctx, config = {}) {
  const profileDir = detectProfileDir();
  const python = config.pythonPath || detectPython(profileDir);
  const node = config.nodePath || detectNode(profileDir);
  const dbPath = config.dbPath || defaultDb(profileDir);
  const modelDir = config.modelDir || MODEL;
  const maxTurns = Number(config.maxTurns ?? 60);
  const autoIngest = config.autoIngest !== false;
  const minAgeSec = Number(config.minAgeSec ?? 120);
  const home = config.dshHome || dshHome(profileDir);
  const store = path.dirname(dbPath);
  const statusFile = path.join(store, 'ingest.json');
  const settings = createSettings({
    store, dbPath, python, node, home, modelDir, minAgeSec, profileDir,
    service: SERVICE, ingest: INGEST,
    serviceState: () => ({ ...health }),
  });

  let child = null;
  let rl = null;
  let readyPromise = null;
  let readyReject = null;
  const pending = [];
  const state = { seen: new Set(), lastCheck: 0, lastSession: null, worker: null };
  const health = { state: 'stopped', pid: null, restarts: 0, lastPingAt: 0, lastError: null };

  function failAll(err) {
    while (pending.length) {
      const p = pending.shift();
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  function startServer() {
    if (child && !child.killed) return readyPromise;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const env = { ...process.env };
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PYTHONPATH = [VENDOR, env.PYTHONPATH || ''].filter(Boolean).join(sep);
    child = spawn(python, [SERVICE, 'serve', '--db', dbPath, '--model-dir', modelDir], {
      cwd: HERE, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    health.state = 'starting';
    health.pid = child.pid ?? null;
    child.stderr.on('data', () => { /* onnxruntime warnings */ });
    rl = readline.createInterface({ input: child.stdout });
    readyPromise = new Promise((resolve, reject) => {
      readyReject = reject;
      const timer = setTimeout(() => reject(new Error(
        `memory service did not become ready in 60s (python: ${python})`)), 60_000);
      rl.once('line', (line) => {
        clearTimeout(timer);
        try {
          const hello = JSON.parse(line);
          if (!hello.ready) return reject(new Error('memory service failed to start'));
          health.state = 'running';
          health.lastPingAt = Date.now();
          resolve(hello);
        } catch (e) { reject(e); }
      });
    });
    // later lines are query responses, in FIFO order
    rl.on('line', (line) => {
      if (pending.length === 0) return;
      const p = pending.shift();
      clearTimeout(p.timer);
      try { p.resolve(JSON.parse(line)); } catch (e) { p.reject(e); }
    });
    child.on('exit', (code) => {
      const err = new Error(`memory service exited (${code})`);
      health.state = 'stopped';
      health.lastError = err.message;
      failAll(err);
      try { readyReject?.(err); } catch { /* ignore */ }
      child = null;
    });
    child.on('error', (err) => {
      health.state = 'stopped';
      health.lastError = String(err?.message || err);
      failAll(err);
      try { readyReject?.(err); } catch { /* ignore */ }
      child = null;
    });
    return readyPromise;
  }

  function request(req, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('memory query timed out')), timeoutMs);
      pending.push({ resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify(req) + '\n');
      } catch (e) {
        clearTimeout(timer);
        pending.pop();
        reject(e);
      }
    });
  }

  async function call(req) {
    await startServer();
    return request(req);
  }

  async function heartbeat() {
    if (!child) {
      health.state = 'stopped';
      return;
    }
    try {
      await readyPromise;
      await request({ cmd: 'ping' }, 5000);
      health.state = 'running';
      health.lastPingAt = Date.now();
    } catch (e) {
      health.lastError = String(e?.message || e);
      health.state = 'restarting';
      health.restarts += 1;
      try { child?.kill(); } catch { /* ignore */ }
      child = null;
      try {
        await startServer();
      } catch (e2) {
        health.state = 'stopped';
        health.lastError = String(e2?.message || e2);
      }
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => { void heartbeat(); }, 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'throughline: service heartbeat');

  const usageFile = path.join(store, 'usage.jsonl');
  const sessionsFile = path.join(store, 'sessions.jsonl');
  const USAGE_CAP = 5000;
  const SESSION_CAP = 2000;

  function appendBounded(file, line, cap) {
    try {
      fs.appendFileSync(file, `${line}\n`, 'utf8');
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > cap) {
        fs.writeFileSync(file, lines.slice(-cap).join('\n') + '\n', 'utf8');
      }
    } catch { /* accounting is best effort */ }
  }

  function appendUsage(entry) {
    appendBounded(usageFile, JSON.stringify(entry), USAGE_CAP);
  }

  /** Denominator for the trigger rate: one line per started session. */
  function appendSession(session) {
    appendBounded(sessionsFile, JSON.stringify({ at: Date.now(), session: session || null }), SESSION_CAP);
  }

  function readStatus() {
    try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return null; }
  }

  function indexState() {
    try {
      const db = fs.statSync(dbPath);
      const watermark = fs.existsSync(path.join(store, 'watermark.json'));
      return { exists: true, bytes: db.size, watermark };
    } catch {
      return { exists: false, bytes: 0, watermark: false };
    }
  }

  /** Spawn the detached extractor+indexer; never blocks the caller. */
  function runIngest(sessionId, full) {
    if (!autoIngest) return null;
    const st = indexState();
    const argv = [
      INGEST,
      '--db', dbPath,
      '--python', python,
      '--home', home,
      '--model-dir', modelDir,
      '--min-age', String(minAgeSec),
      '--status', statusFile,
    ];
    if (sessionId) argv.push('--exclude', String(sessionId));
    if (full) argv.push('--full');
    try {
      const worker = spawn(node, argv, {
        cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env },
      });
      worker.on('error', () => { /* status file carries the failure */ });
      worker.unref();
      state.worker = worker;
      try { settings.record({ kind: 'ingest-start', full: !!full }); } catch { /* ignore */ }
      return worker.pid;
    } catch {
      return null;
    }
  }

  /** Called once per new session: warm the service, then index finished sessions. */
  function onSessionStart(agent) {
    const id = agent?.id ? String(agent.id) : null;
    state.lastSession = id;
    appendSession(id);
    startServer().catch(() => { /* tool call will surface it */ });
    if (!autoIngest || (id && state.seen.has(id))) return;
    if (id) state.seen.add(id);
    const now = Date.now();
    if (now - state.lastCheck < 5000) return;
    state.lastCheck = now;
    if (!settings.canIngest()) return;
    const st = indexState();
    // No index yet, or an interrupted bootstrap: rebuild from scratch.
    runIngest(id, !st.exists || st.bytes === 0 || !st.watermark);
  }

  ctx.on('agent/created', ({ agent }) => {
    try { onSessionStart(agent); } catch { /* never break session creation */ }
  });

  const tool = {
    name: 'memory_search',
    description: 'Search the user\'s local long-term conversation memory — every past session except '
      + 'the current one — and return the most relevant dialogue turns. Runs entirely on this '
      + 'machine with a multilingual 118M CPU model (Chinese and English); no network or cloud calls. Use it when the user refers to '
      + 'something said in an earlier session, asks about past preferences, plans, or events, or '
      + 'when the current context is missing a fact that may exist in their history. This history '
      + 'is mostly Chinese: Chinese queries retrieve best, while English works for distinctive '
      + 'names, commands and terms. Typical triggers: "上次定的交付检查是什么", '
      + '"之前评估 reranker 的结论", "what did we decide about the embedding model". '
      + 'English queries are routed to the dense channel, which crosses languages better.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'What to look for, phrased as a natural-language question or a few keywords.',
        },
        budget_tokens: {
          type: 'number',
          description: 'Approximate token budget for the returned turns (default 1500; typical range 800-3000).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'mode', 'tokens', 'n', 'latency_ms', 'turns'],
        properties: {
          query: { type: 'string' },
          mode: { type: 'string' },
          tokens: { type: 'number' },
          n: { type: 'number' },
          latency_ms: { type: 'number' },
          turns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'session_id', 'turn_idx', 'text', 'score', 'tokens'],
              properties: {
                id: { type: 'number' },
                session_id: { type: 'string' },
                turn_idx: { type: 'number' },
                role: { type: 'string' },
                date: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
                tokens: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value || !value.turns || value.turns.length === 0) {
          const st = readStatus();
          const building = st && (st.phase === 'parse' || st.phase === 'embed' || st.phase === 'repair');
          if (building) {
            const done = Number(st.done || 0);
            const total = Number(st.total || st.turns || 0);
            const pct = total > 0 ? ` (${Math.min(99, Math.round(done / total * 100))}%)` : '';
            return [{
              type: 'text',
              text: `The local memory index is still being built${pct}: ${done}/${total || '?'} turns embedded. `
                + 'Try again in a minute.',
            }];
          }
          if (st && st.phase === 'error') {
            return [{ type: 'text', text: `Local memory index failed to build: ${st.error || 'unknown error'}` }];
          }
          return [{
            type: 'text',
            text: 'No matching memory found. The local memory index may still be empty; it builds in the '
              + 'background on the next session start.',
          }];
        }
        const head = `local memory · ${value.mode} · ${value.turns.length}/${value.n} turns · ${value.tokens} tokens · ${value.latency_ms} ms`;
        const body = value.turns.slice(0, maxTurns).map((t, i) => {
          const head = [t.date, t.role].filter(Boolean).join(' · ');
          const sid = t.session_id ? ` · ${String(t.session_id).replace(/^session-/, '').slice(0, 8)}` : '';
          return `${i + 1}. ${head}${sid}\n${t.text}`;
        }).join('\n\n');
        return [{ type: 'text', text: `${head}\n\n${body}` }];
      },
    },
    async execute(args) {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query must be a non-empty string');
      let budget = Number(args.budget_tokens ?? 1500);
      if (!Number.isFinite(budget)) budget = 1500;
      budget = Math.max(500, Math.min(8000, Math.round(budget)));
      let res;
      try {
        res = await call({ query, budget });
        if (!res || res.ok === false) throw new Error(res?.error || 'memory search failed');
      } catch (e) {
        appendUsage({ at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 120),
          session: state.lastSession || null, query_len: query.length });
        try { settings.record({ kind: 'error', message: String(e?.message || e).slice(0, 160) }); } catch { /* ignore */ }
        throw e;
      }
      // Self-heal: an empty index with no ingest ever started gets a bootstrap.
      if (res.mode === 'empty' && autoIngest && settings.canIngest()) {
        const st = readStatus();
        if (!st || Date.now() - Number(st.at || 0) > 60_000) {
          runIngest(state.lastSession, true);
        }
      }
      const out = {
        query: res.query, mode: res.mode, tokens: res.tokens, n: res.n,
        latency_ms: res.latency_ms, turns: res.turns || [],
      };
      appendUsage({
        at: Date.now(), ok: true, mode: out.mode, turns: out.turns.length,
        tokens: out.tokens, latency_ms: out.latency_ms, budget,
        query_len: query.length,
        session: state.lastSession || null,
        sources: [...new Set(out.turns.map((t) => t.session_id).filter(Boolean))],
      });
      try {
        settings.record({
          kind: 'search',
          query: query.length > 90 ? `${query.slice(0, 90)}…` : query,
          turns: out.turns.length,
          tokens: out.tokens,
          mode: out.mode,
          ms: Math.round(Number(out.latency_ms) || 0),
        });
      } catch { /* ignore */ }
      return out;
    },
  };

  ctx.tools.register(tool);

  // Session-start memory hint: tell the model that an index exists and what it
  // covers, so it knows it can ask before answering from the current context.
  // Registered as a prompt section (live counts come from a variable) rather
  // than injected text, so every step sees the current figure.
  ctx.inject(['systemPrompt'], (sp) => {
    try {
      const indexSummary = () => {
        try {
          const st = settings.status();
          const turns = Number(st.index?.turns || 0);
          const sessions = Number(st.index?.sessions || 0);
          if (!turns) return 'the local memory index is still empty';
          const when = st.lastIngest?.at ? new Date(st.lastIngest.at).toISOString().slice(0, 10) : 'unknown';
          return `${turns.toLocaleString()} turns from ${sessions} past sessions (last indexed ${when}, current session excluded)`;
        } catch {
          return 'a local memory index is available';
        }
      };
      // Pinned rules are the only deterministic channel: they apply without a
      // retrieval call. Users opt out with control.json {"injectPinned": false}.
      const pinnedBlock = () => {
        try {
          const ctrl = JSON.parse(fs.readFileSync(path.join(store, 'control.json'), 'utf8'));
          if (ctrl.injectPinned === false) return '';
        } catch { /* default: on */ }
        try {
          const rules = fs.readFileSync(path.join(store, 'pinned.md'), 'utf8').split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('- '))
            .map((line) => line.slice(2).trim())
            .filter(Boolean);
          if (!rules.length) return '';
          return '\nPinned rules the user wants applied in every session:\n'
            + rules.slice(0, 20).map((rule) => `- ${rule}`).join('\n');
        } catch { return ''; }
      };
      // Rules captured from earlier sessions (user-stated, auto-extracted).
      const autoRulesBlock = () => {
        try {
          const ctrl = JSON.parse(fs.readFileSync(path.join(store, 'control.json'), 'utf8'));
          if (ctrl.injectRules === false) return '';
        } catch { /* default: on */ }
        try {
          const lines = fs.readFileSync(path.join(store, 'rules.jsonl'), 'utf8')
            .split('\n').filter(Boolean);
          const rules = lines.slice(-8).map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          }).filter(Boolean);
          if (!rules.length) return '';
          return '\nRules the user stated in earlier sessions (editable in Settings → Throughline):\n'
            + rules.map((rule) => `- ${rule.text}`).join('\n');
        } catch { return ''; }
      };
      sp.systemPrompt.variable('throughline_index', indexSummary);
      sp.systemPrompt.variable('throughline_pinned', pinnedBlock);
      sp.systemPrompt.variable('throughline_rules', autoRulesBlock);
      sp.systemPrompt.section({
        name: 'throughline',
        order: 50,
        text: 'Local conversation memory: {{throughline_index}}. Call memory_search BEFORE answering '
          + 'when the user refers to something said before (phrases like 上次/之前/继续/前面/'
          + '我们之前定的/规则/约定), continues an older project, or asks about past preferences, '
          + 'plans or decisions; if the results do not contain the answer, say the memory has '
          + 'nothing relevant instead of guessing. Chinese queries retrieve best here; English is '
          + 'fine for distinctive names, commands and terms.{{throughline_pinned}}{{throughline_rules}}',
      });
    } catch { /* profiles without the system prompt service keep working */ }
  });

  // Settings management page: read-mostly status plus pause / reindex / clear.
  // `webServer` is optional (a desktop IPC build has none), so it is pulled in
  // through a scoped inject instead of a hard dependency.
  const routeDisposers = [];
  ctx.inject(['webServer'], (webCtx) => {
    try {
      routeDisposers.push(webCtx.webServer.register({
        kind: 'exact', path: '/throughline/status', handler: settings.handleStatus,
      }));
      routeDisposers.push(webCtx.webServer.register({
        kind: 'exact', path: '/throughline/action', handler: settings.handleAction,
      }));
    } catch { /* no web surface */ }
  });
  ctx.effect(() => () => {
    for (const off of routeDisposers.splice(0)) {
      try { off(); } catch { /* ignore */ }
    }
  }, 'throughline: settings panel routes');

  ctx.effect(() => () => {
    failAll(new Error('plugin unloaded'));
    try { rl?.close(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    child = null;
  }, 'throughline: local service');
}
