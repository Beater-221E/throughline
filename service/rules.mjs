#!/usr/bin/env node
/**
 * Rule capture: turn explicit user-stated rules into durable memory.
 *
 * Throughline is retrieval-only by design; the one exception is a narrow write
 * path: when the user states a rule or preference in their own words ("以后…
 * 必须… 不要… 统一…"), we keep that sentence so later sessions can inject it.
 * Nothing assistant-generated is ever stored here.
 *
 * Rules live in `<store>/rules.jsonl` (separate from the hand-written
 * `pinned.md`), are de-duplicated, capped, and removable from Settings.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Wording that marks a sentence as a stated rule rather than a task. */
const CUE = /(不要|必须|需要|应该|以后|每次|统一|一律|优先|避免|禁止|记得|记住|规则|规范|约定|简化|清理|整理|保持|不能|别忘|要求)/;
const MIN_CHARS = 8;
const MAX_CHARS = 160;
const PER_SESSION = 5;
const TOTAL_CAP = 200;

export function normalize(text) {
  return String(text).replace(/[\s，。！？、；：,.!?;:（）()"“”'']/g, '').toLowerCase();
}

export function ruleId(text) {
  return crypto.createHash('sha1').update(normalize(text)).digest('hex').slice(0, 10);
}

/** Extract candidate rules from one session's turns (user role only). */
export function extractRules(turns) {
  const out = [];
  const seen = new Set();
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    for (const raw of String(turn.text || '').split(/(?<=[。！？!?])|\n+/)) {
      const sentence = raw.replace(/\s+/g, ' ').trim();
      if (sentence.length < MIN_CHARS || sentence.length > MAX_CHARS) continue;
      if (!CUE.test(sentence)) continue;
      const key = normalize(sentence);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(sentence);
      if (out.length >= PER_SESSION) return out;
    }
  }
  return out;
}

export function loadRules(store) {
  try {
    return fs.readFileSync(path.join(store, 'rules.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeRules(store, rules) {
  const file = path.join(store, 'rules.jsonl');
  const lines = rules.slice(-TOTAL_CAP).map((r) => JSON.stringify(r));
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

/**
 * Merge new candidates into the store. Returns the number of rules added.
 * A candidate is skipped when its normalized text matches an existing rule or
 * a hand-written pinned rule.
 */
export function saveRules(store, session, candidates, pinnedText = '') {
  const existing = loadRules(store);
  const known = new Set(existing.map((r) => normalize(r.text)));
  for (const line of String(pinnedText).split('\n')) {
    const m = line.trim();
    if (m.startsWith('- ')) known.add(normalize(m.slice(2)));
  }
  let added = 0;
  const now = Date.now();
  for (const text of candidates) {
    const key = normalize(text);
    if (!key || known.has(key)) continue;
    known.add(key);
    existing.push({ id: ruleId(text), text: text.slice(0, MAX_CHARS), session, at: now });
    added += 1;
  }
  if (added) writeRules(store, existing);
  return added;
}

export function removeRule(store, id) {
  const rules = loadRules(store);
  const next = rules.filter((r) => r.id !== id);
  writeRules(store, next);
  return rules.length - next.length;
}
