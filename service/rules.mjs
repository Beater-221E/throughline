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

/** Only explicit durability markers count; generic words like 规则 appear in
 *  discussions about rules and produced too many false positives. */
const DURABLE = /记住|记得|以后|从现在起|下次|每次/;
/** Sentences that talk *about* rules rather than state one. */
const DISCUSSION = /我认为|我觉得|观察到|理论上|还是认为|应该由|是一种|是合理|想法|讨论|意义|假设/;
/** Questions and meta-discussion are never rules. */
const QUESTION = /[？?]\s*$|吗|呢|是否|为什么|怎么|如何|什么|能不能|可不可以|你觉得|你认为|有什么/;
const META = /^(动机|因为|所以|但是|如果|另外|而且|不过|也就是说|其次|同时)/;
const MIN_CHARS = 8;
const MAX_CHARS = 100;
const PER_SESSION = 5;
const TOTAL_CAP = 200;
export const INJECT_CAP = 5;

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
      if (QUESTION.test(sentence) || META.test(sentence) || DISCUSSION.test(sentence)) continue;
      if (!DURABLE.test(sentence)) continue;
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
