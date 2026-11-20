#!/usr/bin/env node
/**
 * Throughline plugin smoke + regression suite.
 *
 * Runs without DSH: the Host plugin is imported directly and applied to a stub
 * context, and the Python service is exercised through its CLI on a temporary
 * SQLite database.
 *
 *   node tests/run.mjs            # all cases
 *   MP_PYTHON=... node tests/run.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PY = process.env.MP_PYTHON
  || (process.platform === 'win32' ? 'python.exe' : 'python3');
const MEMORY = path.join(ROOT, 'service', 'memory.py');
const MODEL = path.join(ROOT, 'service', 'model');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
const DB = path.join(WORK, 'memory.sqlite');
const NO_MODEL_DB = path.join(WORK, 'nomodel.sqlite');
const FIXTURE = path.join(WORK, 'turns.jsonl');

const RULE = 'ORION-7 交付规则：报告必须先运行 scripts/audit.sh --strict，审计失败禁止提交。';

fs.writeFileSync(FIXTURE, [
  { session_id: 'session-test-rule', seq: 0, turn_idx: 0, role: 'user', date: '2026-10-02', text: '记一下 ORION-7 的交付规则。' },
  { session_id: 'session-test-rule', seq: 1, turn_idx: 1, role: 'assistant', date: '2026-10-02', text: RULE },
  { session_id: 'session-test-other', seq: 0, turn_idx: 0, role: 'user', date: '2026-10-03', text: '今天先把服务器上的旧日志清理掉。' },
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

function py(args, options = {}) {
  const res = spawnSync(PY, args, {
    encoding: 'utf8', timeout: options.timeout ?? 180_000, env: { ...process.env },
  });
  if (res.error) throw new Error(res.error.message);
  if (res.status !== 0) {
    throw new Error(`python exit ${res.status}: ${(res.stderr || res.stdout || '').slice(-600)}`);
  }
  const out = (res.stdout || '').trim().split('\n').filter(Boolean);
  return out.length ? JSON.parse(out[out.length - 1]) : null;
}

function addTurns(db, modelDir = MODEL) {
  return py([MEMORY, 'add', '--db', db, '--jsonl', FIXTURE, '--model-dir', modelDir]);
}

function search(db, query, modelDir = MODEL, budget = 800) {
  return py([MEMORY, 'search', '--db', db, '--query', query, '--model-dir', modelDir,
    '--budget', String(budget)]);
}

function sqliteText(db, sessionId) {
  const script = [
    'import sqlite3, sys, json',
    `c = sqlite3.connect(${JSON.stringify(db)})`,
    `rows = c.execute("SELECT text FROM turns WHERE session_id=?", (${JSON.stringify(sessionId)},)).fetchall()`,
    'print(json.dumps(" ".join(r[0] for r in rows), ensure_ascii=False))',
  ].join('\n');
  const res = spawnSync(PY, ['-c', script], { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse((res.stdout || '""').trim().split('\n').pop());
}

function stats(db, modelDir = MODEL) {
  return py([MEMORY, 'stats', '--db', db, '--model-dir', modelDir]);
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message || e) });
    console.log(`FAIL  ${name}\n      ${String(e?.message || e).split('\n')[0]}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------- 1. exports
await check('module exports the Host plugin shape', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
  assert(mod.name === 'throughline', `name=${mod.name}`);
  assert(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject must list tools');
  assert(typeof mod.apply === 'function', 'apply must be a function');
});

// ------------------------------------------------ 2. tool + route registration
await check('apply registers the tool and the panel routes', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
  const tools = [];
  const routes = [];
  const events = [];
  const promptVars = [];
  const promptSections = [];
  const ctx = {
    on(event) { events.push(event); },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    inject(deps, cb) {
      const scoped = {
        webServer: { register(route) { routes.push(route); return () => {}; } },
        systemPrompt: {
          variable(name, fn) { promptVars.push([name, fn]); },
          section(opts) { promptSections.push(opts); },
        },
      };
      const dispose = cb(scoped);
      return typeof dispose === 'function' ? dispose : () => {};
    },
    tools: { register(tool) { tools.push(tool); } },
  };
  mod.apply(ctx, { dbPath: DB, pythonPath: PY, modelDir: MODEL, autoIngest: false });
  assert(tools.length === 1, `expected 1 tool, got ${tools.length}`);
  const tool = tools[0];
  assert(tool.name === 'memory_search', `tool name ${tool.name}`);
  assert(tool.parameters && tool.parameters.type === 'object', 'parameters must be a JSON schema object');
  assert(Array.isArray(tool.parameters.required) && tool.parameters.required.includes('query'), 'query is required');
  assert(typeof tool.execute === 'function', 'execute missing');
  assert(routes.length === 2, `expected 2 routes, got ${routes.length}`);
  const paths = routes.map((r) => r.path).sort();
  assert(paths[0] === '/throughline/action', `route ${paths[0]}`);
  assert(paths[1] === '/throughline/status', `route ${paths[1]}`);
  assert(events.includes('agent/created'), 'agent/created listener missing');
  assert(promptSections.some((x) => x.name === 'throughline'), 'prompt section missing');
  assert(promptVars.some(([name]) => name === 'throughline_index'), 'prompt variable missing');
});

// ------------------------------------------------------------- 3. ingest + hit
await check('ingest stores turns and a lexical query finds the rule', async () => {
  const added = addTurns(DB);
  assert(added.added === 3, `expected 3 added, got ${added.added}`);
  const hit = search(DB, 'ORION-7 audit.sh 交付规则');
  assert(hit.mode === 'hybrid', `mode ${hit.mode}`);
  assert(hit.turns.some((t) => t.text.includes('audit.sh')), 'rule turn not in results');
  assert(hit.turns[0].text.includes('ORION-7'), `top hit is ${hit.turns[0].text.slice(0, 40)}`);
});

// --------------------------------------------------- 4. CJK bigram lexical hit
await check('CJK bigrams let a Chinese query reach BM25', async () => {
  const hit = search(DB, '旧日志清理');
  assert(hit.mode === 'hybrid', `mode ${hit.mode}`);
  assert(hit.turns.some((t) => t.text.includes('旧日志')), 'Chinese lexical match failed');
});

// --------------------------------------------------------------- 5. purge
await check('purge empties the index but keeps the file', async () => {
  py([MEMORY, 'purge', '--db', DB, '--model-dir', MODEL]);
  const s = stats(DB);
  assert(s.turns === 0, `turns=${s.turns}`);
  assert(s.buckets === 0, `buckets=${s.buckets}`);
  assert(fs.existsSync(DB), 'database file should still exist');
});

// ------------------------------------------------------- 6. no-model fallback
await check('missing model degrades to BM25 only', async () => {
  const empty = path.join(WORK, 'empty-model');
  fs.mkdirSync(empty, { recursive: true });
  const added = addTurns(NO_MODEL_DB, empty);
  assert(added.model === false, 'encoder should report unavailable');
  assert(added.vectors === 0, `vectors=${added.vectors}`);
  const hit = search(NO_MODEL_DB, 'ORION-7 audit.sh', empty);
  assert(hit.mode === 'bm25', `mode ${hit.mode}`);
  assert(hit.turns.length > 0, 'no lexical result without a model');
});

// ------------------------------------------------- 7. crashed-add repair
await check('service re-embeds rows a crashed add left behind', async () => {
  const db = path.join(WORK, 'repair.sqlite');
  addTurns(db);
  const svcDir = path.join(ROOT, 'service');
  const script = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(svcDir)})`,
    'import memory',
    `con = memory.connect(${JSON.stringify(db)})`,
    "con.execute('UPDATE turns SET vec_ok=0')",
    'con.commit(); con.close()',
    `svc = memory.Service(${JSON.stringify(db)}, ${JSON.stringify(MODEL)})`,
    'print(\'{"vectors": %d}\' % svc.vec_count)',
  ].join('\n');
  py(['-c', script]);
  const s = stats(db);
  assert(s.vectors === 3, `vectors=${s.vectors} after repair`);
});


// ------------------------------------------- 8. panel status / pause / resume
await check('panel reports revision and honours pause', async () => {
  const { createSettings } = await import(pathToFileURL(path.join(ROOT, 'service', 'settings.js')).href);
  const store = path.join(WORK, 'panel-store');
  fs.mkdirSync(store, { recursive: true });
  const db = path.join(store, 'memory.sqlite');
  addTurns(db);
  const settings = createSettings({
    store, dbPath: db, python: PY, node: process.execPath,
    service: MEMORY, ingest: path.join(ROOT, 'service', 'ingest.mjs'),
    home: WORK, modelDir: MODEL, minAgeSec: 0,
  });
  const st = settings.status();
  assert(st.revision && typeof st.revision.manifestMtime === 'number', 'revision missing');
  assert(st.revision.count === 3, `revision.count=${st.revision.count}`);
  assert(typeof st.stale === 'boolean', 'stale flag missing');
  assert(st.failures === 0, `failures=${st.failures}`);
  assert(settings.canIngest() === true, 'ingest should be allowed by default');
  await settings.action('pause');
  assert(settings.canIngest() === false, 'pause must block ingest');
  await settings.action('resume');
  assert(settings.canIngest() === true, 'resume must allow ingest');
});

// ------------------------------------------------------- 9. failure backoff
await check('two ingest failures block the next trigger until the window ends', async () => {
  const { createSettings } = await import(pathToFileURL(path.join(ROOT, 'service', 'settings.js')).href);
  const store = path.join(WORK, 'backoff-store');
  fs.mkdirSync(store, { recursive: true });
  const db = path.join(store, 'memory.sqlite');
  fs.writeFileSync(path.join(store, 'control.json'), JSON.stringify({
    ingestFailures: 2, backoffUntil: Date.now() + 60_000,
  }), 'utf8');
  const settings = createSettings({
    store, dbPath: db, python: PY, node: process.execPath,
    service: MEMORY, ingest: path.join(ROOT, 'service', 'ingest.mjs'),
    home: WORK, modelDir: MODEL, minAgeSec: 0,
  });
  assert(settings.canIngest() === false, 'backoff window must block ingest');
  fs.writeFileSync(path.join(store, 'control.json'), JSON.stringify({
    ingestFailures: 2, backoffUntil: Date.now() - 1000,
  }), 'utf8');
  assert(settings.canIngest() === true, 'expired backoff must allow ingest');
});


// ------------------------------------------------------ 10. credential redaction
await check('credentials are redacted before storage', async () => {
  const db = path.join(WORK, 'redact.sqlite');
  const jsonl = path.join(WORK, 'secret.jsonl');
  fs.writeFileSync(jsonl, JSON.stringify({
    session_id: 'session-secret', seq: 0, turn_idx: 0, role: 'user', date: '2026-10-04',
    text: '部署用的 key 是 sk-abcdefghijklmnopqrstuvwxyz 和 password=hunter2secret，别外传。',
  }) + '\n', 'utf8');
  const added = py([MEMORY, 'add', '--db', db, '--jsonl', jsonl, '--model-dir', MODEL]);
  assert(added.redacted >= 1, `redacted=${added.redacted}`);
  const row = sqliteText(db, 'session-secret');
  assert(!row.includes('sk-abcdefghijklmnopqrstuvwxyz'), 'api key leaked into storage');
  assert(!row.includes('hunter2secret'), 'password leaked into storage');
  assert(row.includes('[REDACTED]'), 'redaction marker missing');
});

// --------------------------------------------------------- 11. workspace exclusion
await check('excluded workspaces are skipped by ingestion', async () => {
  const { zstdCompressSync } = await import('node:zlib');
  const home = path.join(WORK, 'fake-home');
  const ws = '--D-proj-Excluded--';
  const sid = 'session-excluded-1';
  const dir = path.join(home, 'sessions', ws, sid);
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    { type: 'session', version: 4, id: sid, cwd: 'D:\\proj\\Excluded', createdAt: Date.now() },
    { type: 'user/message', seq: 0, time: Date.now(), data: {
      content: [{ type: 'text', text: '这个项目不要进记忆库。' }],
      source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' } } },
    { type: 'assistant/message', seq: 1, time: Date.now(), data: {
      message: { role: 'assistant', content: [{ type: 'text', text: '明白，这个项目不写索引。' }] } } },
  ];
  const frames = events.map((e) => zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')));
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));

  const db = path.join(WORK, 'exclude.sqlite');
  const exFile = path.join(WORK, 'exclude.json');
  fs.writeFileSync(exFile, JSON.stringify({ workspaces: [ws], sessions: [], keywords: [] }), 'utf8');
  const runSessions = (excludeFile) => spawnSync(process.execPath, [
    path.join(ROOT, 'service', 'ingest.mjs'), '--db', db, '--home', home,
    '--python', PY, '--model-dir', MODEL, '--full', '--min-age', '0',
    '--exclude-file', excludeFile,
  ], { encoding: 'utf8', timeout: 180_000 });
  const r1 = runSessions(exFile);
  assert(r1.status === 0, `sessions exit ${r1.status}: ${(r1.stderr || '').slice(-300)}`);
  assert(stats(db).turns === 0, `excluded workspace indexed ${stats(db).turns} turns`);

  fs.writeFileSync(exFile, JSON.stringify({ workspaces: [], sessions: [], keywords: [] }), 'utf8');
  const r2 = runSessions(exFile);
  assert(r2.status === 0, `sessions exit ${r2.status}`);
  assert(stats(db).turns > 0, 'workspace not indexed after removing the exclusion');
});


// --------------------------------------- 12. re-ingest replaces, not duplicates
await check('re-ingesting a session replaces its rows', async () => {
  const db = path.join(WORK, 'replace.sqlite');
  addTurns(db);
  const first = stats(db).turns;
  addTurns(db);
  const second = stats(db).turns;
  assert(first === 3, `first ingest turns=${first}`);
  assert(second === 3, `second ingest turns=${second} (duplicates were appended)`);
});


// ------------------------------------------------ 13. pinned facts rank first
await check('pinned facts are ingested and boosted to the top', async () => {
  const home = path.join(WORK, 'pinned-home');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const db = path.join(WORK, 'pinned.sqlite');
  addTurns(db); // three unrelated turns
  const store = path.dirname(db);
  fs.writeFileSync(path.join(store, 'pinned.md'),
    '- 发布规则：提交前必须运行 scripts/audit.sh --strict，审计失败禁止发布。\n'
    + '- 部署窗口：每周二禁止上线。\n', 'utf8');
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'service', 'ingest.mjs'), '--db', db, '--home', home,
    '--python', PY, '--model-dir', MODEL, '--full', '--min-age', '0',
  ], { encoding: 'utf8', timeout: 180_000 });
  assert(r.status === 0, `sessions exit ${r.status}: ${(r.stderr || '').slice(-300)}`);
  const hit = search(db, '发布前要跑什么检查');
  assert(hit.turns.length > 0, 'no result');
  assert(hit.turns[0].text.includes('audit.sh'), `top hit is ${hit.turns[0].text.slice(0, 40)}`);
});

// ------------------------------------------------- 14. glossary query expansion
await check('glossary terms expand the lexical query', async () => {
  const script = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'service'))})`,
    'import memory',
    'print(json.dumps(memory.expand_query("模型压缩怎么做", {"模型": ["model"], "压缩": ["zstd"]}), ensure_ascii=False))',
  ].join('\n');
  const res = spawnSync(PY, ['-c', script], { encoding: 'utf8', timeout: 30_000 });
  const out = JSON.parse((res.stdout || '""').trim().split('\n').pop());
  assert(out.includes('model') && out.includes('zstd'), `expanded=${out}`);
});


// ---------------------------------------- 15. worker events reach the toast feed
await check('per-session ingest events surface in the panel feed', async () => {
  const { createSettings } = await import(pathToFileURL(path.join(ROOT, 'service', 'settings.js')).href);
  const store = path.join(WORK, 'feed-store');
  fs.mkdirSync(store, { recursive: true });
  const db = path.join(store, 'memory.sqlite');
  const settings = createSettings({
    store, dbPath: db, python: PY, node: process.execPath,
    service: MEMORY, ingest: path.join(ROOT, 'service', 'ingest.mjs'),
    home: WORK, modelDir: MODEL, minAgeSec: 0,
  });
  settings.status(); // baselines the event log offset
  fs.appendFileSync(path.join(store, 'events.jsonl'),
    JSON.stringify({ at: Date.now(), kind: 'turns', session: 'session-abc', turns: 12 }) + '\n', 'utf8');
  const st = settings.status();
  const hit = (st.events || []).find((e) => e.kind === 'turns' && e.turns === 12);
  assert(hit, 'worker event missing from the panel feed');
  assert(st.events.length <= 20, `feed too small: ${st.events.length}`);
});


// ------------------------------------------------- 16. usage accounting summary
await check('usage summary aggregates calls, tokens and avoided tokens', async () => {
  const { createSettings } = await import(pathToFileURL(path.join(ROOT, 'service', 'settings.js')).href);
  const store = path.join(WORK, 'usage-store');
  fs.mkdirSync(store, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(store, 'usage.jsonl'), [
    JSON.stringify({ at: now, ok: true, tokens: 400, turns: 3, latency_ms: 4, sources: ['s1'], mode: 'hybrid' }),
    JSON.stringify({ at: now, ok: true, tokens: 600, turns: 2, latency_ms: 8, sources: ['s1'], mode: 'hybrid' }),
    JSON.stringify({ at: now, ok: false, error: 'boom' }),
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(store, 'session_stats.json'),
    JSON.stringify({ s1: { tokens: 5000, turns: 40 } }), 'utf8');
  const settings = createSettings({
    store, dbPath: path.join(store, 'memory.sqlite'), python: PY, node: process.execPath,
    service: MEMORY, ingest: path.join(ROOT, 'service', 'ingest.mjs'),
    home: WORK, modelDir: MODEL, minAgeSec: 0,
  });
  const u = settings.status().usage;
  assert(u.calls === 2, `calls=${u.calls}`);
  assert(u.errors === 1, `errors=${u.errors}`);
  assert(u.injectedTokens === 1000, `tokens=${u.injectedTokens}`);
  assert(u.avoidedTokens === 9000, `avoided=${u.avoidedTokens}`);
  assert(u.hitRate === 1, `hit=${u.hitRate}`);
  assert(u.cost === null, `cost=${u.cost}`);
});

// --------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`- ${f.name}: ${f.error}`);
  process.exitCode = 1;
}
fs.rmSync(WORK, { recursive: true, force: true });
