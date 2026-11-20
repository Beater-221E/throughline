#!/usr/bin/env node
/**
 * Session -> turns extractor for the Throughline memory index.
 *
 * DSH stores one zstd frame per append, so a whole-file decode stops at frame 1;
 * this walks frame boundaries (RFC 8878 §3.1.1) and decodes each frame.
 *
 * The extractor keeps only real dialogue: `user/message` events whose source kind
 * is `user` (injected runtime context, time context, skill catalog and subagent
 * notices are skipped) and the text blocks of `assistant/message`. Tool calls and
 * results are not indexed.
 *
 * Modes: `--full` (install-time bootstrap) or incremental against a watermark.
 * Exits quietly when another ingest holds the lock or nothing changed.
 *
 * usage:
 *   node ingest.mjs --db <sqlite> --python <py> [--home <dsh home>]
 *        [--exclude <sessionId>] [--full] [--min-age <sec>] [--dry-run]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { zstdDecompressSync } from 'node:zlib';
import { extractRules, saveRules } from './rules.mjs';
import { fileURLToPath } from 'node:url';

const MAGIC = 0xfd2fb528;
const TURN_CHARS = 8000; // very long turns would eat the whole retrieval budget

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const A = parseArgs(process.argv.slice(2));
if (!A.db) {
  console.error('--db is required');
  process.exit(2);
}
const DB = path.resolve(String(A.db));
const STORE = path.dirname(DB);
const HOME = path.resolve(String(A.home || path.join(os.homedir(), '.dsh')));
const SESSIONS = path.join(HOME, 'sessions');
const STATUS = path.resolve(String(A.status || path.join(STORE, 'ingest.json')));
const WATER = path.resolve(String(A.watermark || path.join(STORE, 'watermark.json')));
const LOCK = path.join(STORE, 'ingest.lock');
const SERVICE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.py');
const MIN_AGE_MS = Number(A['min-age'] ?? 120) * 1000;
const FULL = A.full === true;
const DRY = A['dry-run'] === true;
const TMP = path.join(STORE, 'ingest-turns.jsonl');
const EXCLUDE = path.resolve(String(A['exclude-file'] || path.join(STORE, 'exclude.json')));
const HISTORY = path.join(STORE, 'history.jsonl');
const PINNED = path.join(STORE, 'pinned.md');

function mergeSessionStats(entries) {
  if (!entries.length) return;
  try {
    const file = path.join(STORE, 'session_stats.json');
    const cur = readJson(file, {});
    for (const e of entries) {
      cur[e.session] = { turns: e.turns, tokens: e.tokens, at: Date.now() };
    }
    const keys = Object.keys(cur);
    if (keys.length > 500) {
      keys.sort((a, b) => (cur[a].at || 0) - (cur[b].at || 0));
      for (const k of keys.slice(0, keys.length - 500)) delete cur[k];
    }
    fs.writeFileSync(file, JSON.stringify(cur), 'utf8');
  } catch { /* stats are best effort */ }
}

/** Append one event line for the panel's toast feed. */
function appendEvent(entry) {
  try {
    const file = path.join(STORE, 'events.jsonl');
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 300) fs.writeFileSync(file, lines.slice(-300).join('\n') + '\n', 'utf8');
  } catch { /* best effort */ }
}

/** Human-maintained facts: one bullet per line under an optional heading. */
function readPinned() {
  try {
    return fs.readFileSync(PINNED, 'utf8').split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Append one bounded run record so the panel can show recent ingests. */
function appendHistory(entry) {
  try {
    fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n', 'utf8');
    const lines = fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 50) {
      fs.writeFileSync(HISTORY, lines.slice(-50).join('\n') + '\n', 'utf8');
    }
  } catch { /* history is best effort */ }
}

function readExclude() {
  const raw = readJson(EXCLUDE, {});
  return {
    workspaces: Array.isArray(raw.workspaces) ? raw.workspaces.map(String) : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions.map(String) : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(String).filter(Boolean) : [],
  };
}

function writeStatus(obj) {
  try {
    fs.mkdirSync(STORE, { recursive: true });
    const tmp = `${STATUS}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...obj, at: Date.now() }), 'utf8');
    fs.renameSync(tmp, STATUS);
  } catch { /* best effort */ }
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  const held = readJson(LOCK, null);
  if (held?.pid && held.pid !== process.pid && pidAlive(held.pid)) return false;
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
  return true;
}

function releaseLock() {
  try {
    const held = readJson(LOCK, null);
    if (held?.pid === process.pid) fs.unlinkSync(LOCK);
  } catch { /* ignore */ }
}

function frameSpans(buf) {
  const spans = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== MAGIC) throw new Error(`bad magic at ${off}`);
    let p = off + 4;
    const fhd = buf[p++];
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictIdFlag = fhd & 3;
    if (!singleSegment) p += 1;
    p += [0, 1, 2, 4][dictIdFlag];
    p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
    for (;;) {
      const bh = buf.readUIntLE(p, 3);
      p += 3;
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      p += type === 1 ? 1 : size;
      if (last) break;
    }
    if (checksum) p += 4;
    if (p > buf.length) throw new Error(`frame overruns at ${off}`);
    spans.push([off, p]);
    off = p;
  }
  return spans;
}

function readEvents(file) {
  const raw = fs.readFileSync(file);
  const parts = frameSpans(raw).map(([a, b]) => zstdDecompressSync(raw.subarray(a, b)));
  const events = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { /* torn frame */ }
  }
  return events;
}

function blocksText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n').trim();
}

function fmtDate(ms, tz) {
  const d = new Date(Number(ms) || Date.now());
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const REDACTORS = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(SERVICE, 'redaction.json'), 'utf8'));
    return (raw.patterns || []).map((p) => new RegExp(p.regex, p.flags || ''));
  } catch {
    return [];
  }
})();

/** Replace credential-shaped substrings before a turn reaches the index. */
function redact(text) {
  let out = String(text);
  let count = 0;
  for (const re of REDACTORS) {
    out = out.replace(re, (match, word) => {
      count += 1;
      return word ? `${word} [REDACTED]` : '[REDACTED]';
    });
  }
  return { text: out, count };
}

function clip(s) {
  const t = String(s).trim();
  return t.length > TURN_CHARS ? `${t.slice(0, TURN_CHARS)} …` : t;
}

function extractTurns(file, sessionId) {
  const events = readEvents(file);
  let tz = null;
  for (const e of events) {
    const z = e?.data?.source?.clientTimeZone;
    if (z) { tz = z; break; }
  }
  const turns = [];
  let idx = 0;
  for (const e of events) {
    if (e?.type === 'user/message') {
      const d = e.data || {};
      if ((d.source || {}).kind !== 'user') continue; // injected context
      const text = blocksText(d.content);
      if (!text) continue;
      turns.push({ session_id: sessionId, seq: Number(e.seq) || 0, turn_idx: idx++,
        role: 'user', date: fmtDate(e.time, tz), text: clip(text) });
    } else if (e?.type === 'assistant/message') {
      const m = (e.data || {}).message || {};
      const text = blocksText(m.content);
      if (!text) continue;
      turns.push({ session_id: sessionId, seq: Number(e.seq) || 0, turn_idx: idx++,
        role: 'assistant', date: fmtDate(e.time, tz), text: clip(text) });
    }
  }
  return { turns, events: events.length };
}

function listSessions() {
  const out = [];
  let wsDirs = [];
  try { wsDirs = fs.readdirSync(SESSIONS, { withFileTypes: true }); } catch { return out; }
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    const wp = path.join(SESSIONS, ws.name);
    let subs = [];
    try { subs = fs.readdirSync(wp, { withFileTypes: true }); } catch { continue; }
    for (const sd of subs) {
      if (!sd.isDirectory()) continue;
      const file = path.join(wp, sd.name, 'session.v4.jsonl.zstd');
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      out.push({ file, id: sd.name, ws: ws.name,
        rel: path.relative(SESSIONS, file).split(path.sep).join('/'),
        mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function runPython(jsonl) {
  // File-backed stdio: piping another program's output is unavailable to a
  // sandboxed host, and a log file is easier to inspect after a failed run.
  return new Promise((resolve) => {
    const python = String(A.python || (process.platform === 'win32' ? 'python.exe' : 'python3'));
    const argv = [SERVICE, 'add', '--db', DB, '--jsonl', jsonl, '--status', STATUS];
    if (A['model-dir']) argv.push('--model-dir', String(A['model-dir']));
    const logPath = path.join(STORE, 'ingest.log');
    try {
      if (fs.statSync(logPath).size > 1_000_000) fs.renameSync(logPath, `${logPath}.1`);
    } catch { /* no log yet */ }
    let fdOut = -1;
    let fdErr = -1;
    try {
      fs.mkdirSync(STORE, { recursive: true });
      fdOut = fs.openSync(logPath, 'w');
      fdErr = fdOut;
    } catch {
      fdOut = 'ignore';
      fdErr = 'ignore';
    }
    const child = spawn(python, argv, { stdio: ['ignore', fdOut, fdErr], windowsHide: true });
    const done = (code) => {
      let out = '';
      try { out = fs.readFileSync(logPath, 'utf8'); } catch { /* ignore */ }
      try { if (typeof fdOut === 'number') fs.closeSync(fdOut); } catch { /* ignore */ }
      resolve({ code, out, err: out });
    };
    child.on('error', () => done(-1));
    child.on('close', (code) => done(code));
  });
}

async function ingestPinned() {
  const facts = readPinned();
  if (!facts.length) return { facts: 0, ok: true };
  const file = path.join(STORE, 'ingest-pinned.jsonl');
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, facts.map((text, i) => JSON.stringify({
    session_id: 'pinned', seq: i, turn_idx: i, role: 'user', date: today, text,
  })).join('\n') + '\n', 'utf8');
  const result = await runPython(file);
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return { facts: facts.length, ok: result.code === 0 };
}

async function main() {
  if (!fs.existsSync(SESSIONS)) {
    writeStatus({ phase: 'idle', reason: 'no sessions directory', sessions: SESSIONS });
    return;
  }
  if (!acquireLock()) {
    writeStatus({ phase: 'busy', reason: 'another ingest is running' });
    return;
  }
  const t0 = Date.now();
  try {
    const pinned = await ingestPinned();
    const watermark = readJson(WATER, { version: 1, files: {} });
    if (!watermark.files) watermark.files = {};
    const cutoff = Date.now() - MIN_AGE_MS;
    const exclude = A.exclude ? String(A.exclude) : null;
    const all = listSessions();
    const rules = readExclude();
    const skipWs = new Set(rules.workspaces);
    const skipSessions = new Set(rules.sessions);
    const keywords = rules.keywords.map((k) => k.toLowerCase());
    const changed = all.filter((s) => {
      if (exclude && s.id === exclude) return false;
      if (skipWs.has(s.ws) || skipSessions.has(s.id)) return false;
      if (s.mtime > cutoff) return false; // still being written (live/subagent)
      if (FULL) return true;
      const seen = watermark.files[s.rel];
      return !seen || seen.mtime !== s.mtime || seen.size !== s.size;
    });
    writeStatus({ phase: 'scan', sessions: all.length, pending: changed.length, full: FULL,
      pinned: pinned.facts });
    if (DRY) {
      console.log(JSON.stringify({ sessions: all.length, changed: changed.length,
        sample: changed.slice(0, 5).map((s) => s.id) }, null, 2));
      return;
    }
    if (!changed.length) {
      writeStatus({ phase: 'idle', sessions: all.length, pending: 0, elapsed_ms: Date.now() - t0 });
      return;
    }

    const fd = fs.openSync(TMP, 'w');
    const okFiles = [];
    const warnings = [];
    const perFile = [];
    let turns = 0;
    let dropped = 0;
    let rulesAdded = 0;
    const pinnedForDedupe = readPinned().map((r) => `- ${r}`).join('\n');
    let redactions = 0;
    for (let i = 0; i < changed.length; i++) {
      const s = changed[i];
      writeStatus({ phase: 'parse', file: i + 1, files: changed.length, turns });
      try {
        const got = extractTurns(s.file, s.id);
        let kept = 0;
        let chars = 0;
        for (const t of got.turns) {
          if (keywords.length && keywords.some((k) => t.text.toLowerCase().includes(k))) {
            dropped += 1;
            continue;
          }
          const r = redact(t.text);
          redactions += r.count;
          t.text = r.text;
          fs.writeSync(fd, `${JSON.stringify(t)}\n`);
          chars += t.text.length;
          kept += 1;
        }
        turns += kept;
        okFiles.push(s);
        try {
          rulesAdded += saveRules(STORE, s.id, extractRules(got.turns), pinnedForDedupe);
        } catch { /* rule capture is best effort */ }
        perFile.push({ session: s.id, ws: s.ws, turns: kept, redacted: redactions,
          tokens: Math.round(chars / 4) });
      } catch (e) {
        warnings.push(`${s.id}: ${e.message || e}`);
      }
    }
    fs.closeSync(fd);

    mergeSessionStats(perFile);
    if (perFile.length && perFile.length <= 5) {
      for (const f of perFile) {
        appendEvent({ kind: 'turns', session: f.session, turns: f.turns, full: FULL });
      }
    } else if (perFile.length > 5) {
      appendEvent({ kind: 'turns', sessions: perFile.length, turns, full: FULL });
    }
    writeStatus({ phase: 'embed', files: okFiles.length, turns, rules: rulesAdded,
      warnings: warnings.slice(0, 5) });
    const r = await runPython(TMP);
    let summary = null;
    try { summary = JSON.parse((r.out || '').trim().split('\n').pop()); } catch { /* ignore */ }
    if (r.code !== 0) {
      writeStatus({ phase: 'error', stage: 'embed', code: r.code,
        error: (r.err || r.out || '').slice(-2000), warnings: warnings.slice(0, 5) });
      appendHistory({ at: Date.now(), phase: 'error', files: okFiles.length, turns,
        redacted: redactions, filtered: dropped, code: r.code });
      process.exitCode = 1;
      return;
    }

    const now = Date.now();
    for (const s of okFiles) watermark.files[s.rel] = { mtime: s.mtime, size: s.size };
    watermark.version = 1;
    watermark.updatedAt = now;
    watermark.turns = Number(summary?.vectors ?? watermark.turns ?? turns);
    try { fs.writeFileSync(WATER, JSON.stringify(watermark), 'utf8'); } catch { /* ignore */ }
    writeStatus({ phase: 'ready', files: okFiles.length, turns, elapsed_ms: now - t0,
      added: summary?.added ?? null, buckets: summary?.buckets ?? null,
      model: summary?.model ?? null, redacted: redactions, filtered: dropped,
      rules: rulesAdded,
      sessions: summary?.sessions ?? null, pinned: pinned.facts,
      excludedWorkspaces: rules.workspaces.length, excludedSessions: rules.sessions.length,
      warnings: warnings.slice(0, 5) });
    appendHistory({ at: now, phase: 'ready', files: okFiles.length, turns,
      added: summary?.added ?? null, redacted: redactions, filtered: dropped,
      elapsedMs: now - t0 });
  } finally {
    try { fs.unlinkSync(TMP); } catch { /* ignore */ }
    releaseLock();
  }
}

main().catch((e) => {
  writeStatus({ phase: 'error', error: String(e?.stack || e) });
  releaseLock();
  process.exitCode = 1;
});
