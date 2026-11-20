# Architecture

Throughline is a DSH Host bundle plus a local Python service. It owns no conversation data of its own:
the session log stays the source of truth, and the index is a derived cache that can be rebuilt at any
time.

## Components

| File | Role |
|---|---|
| `index.js` | DSH Host plugin: registers `memory_search`, listens for `agent/created`, manages the Python child process, exposes the settings routes, logs usage, injects the session-start memory hint. |
| `client.js` | Web client: the Settings section and the bottom-right toast layer. |
| `service/memory.py` | SQLite + FTS5 + ONNX embeddings; hybrid ranking; the `serve` JSON-lines protocol; compaction and repair. |
| `service/ingest.mjs` | Extracts dialogue turns from DSH session logs (zstd frames), applies exclusions/redaction, drives ingestion. |
| `service/settings.js` | Route handlers and aggregation for the settings page (status, usage, history, exclusions). |
| `service/redaction.json` | Credential patterns shared by the JS and Python paths. |
| `tests/run.mjs` | End-to-end smoke and regression suite (no DSH required). |

## Data flow

```
sessions/*.jsonl.zstd
  │  service/ingest.mjs: frame-by-frame zstd decode, keep user messages whose source is the user
  │  and the text blocks of assistant messages; drop injected context, tool calls and results
  ▼
turns.jsonl ──► memory.py add ──► SQLite (turns + FTS5) + memory.buckets/*.npz
  │                                  │
  │                                  └─ hybrid search: 0.3·z(dense) + 0.7·z(BM25)
  ▼
agent/created ──► one incremental pass; the live session is excluded
```

## Storage

`<profile>/storages/throughline/`

| Item | Meaning |
|---|---|
| `memory.sqlite` | `turns` (id, session_id, turn_idx, role, date, text, hash, vec_ok), `turns_fts` (space-joined term stream), `meta` |
| `memory.buckets/` | Append-only vector buckets (`bucket-NNNN.npz`, 2048 turns each) + `manifest.json` |
| `watermark.json` | per-session `(mtime, size)` already indexed |
| `ingest.json` / `ingest.log` / `history.jsonl` | last run state, log, bounded run history |
| `events.jsonl` | per-session turn events consumed by the toast feed |
| `usage.jsonl` | one line per `memory_search` call (mode, turns, tokens, latency, source sessions) |
| `session_stats.json` | per-session turn/token size, used for the "tokens saved" estimate |
| `pinned.md` / `glossary.json` | human-maintained rules and term expansion |
| `exclude.json` | workspaces / sessions / keywords never indexed |
| `control.json` | paused flag, notification flag, ingest failure backoff, optional `pricePerMTok` |

## Lexical channel

DSH sessions are mostly Chinese with English technical terms. The default FTS5 tokenizer treats a run of
CJK as one token, which makes BM25 useless. Throughline therefore builds its own term stream at index and
query time:

- latin words (`[a-zA-Z0-9_]+`, lowercased)
- CJK character bigrams and unigrams for every CJK run

FTS5 stores the joined terms; queries OR up to 96 distinct terms. This is the single largest recall
improvement measured on the project (see `TECHNICAL-REPORT.md`).

## Ranking

```
dense   = cosine(query, turn)                    (multilingual-e5-small, mean pooling)
lexical = FTS5 bm25 over the term stream
hybrid  = 0.3 · z(dense) + 0.7 · z(lexical)
pinned  += 0.8                                   (rows with session_id = "pinned")
select  = turns in score order until the token budget (default 3000) is filled
```

`z` is per-query standardization. If the embedding model is missing, search falls back to BM25 only
(`mode: "bm25"`); a model whose dimension does not match the stored buckets also falls back instead of
failing.

## Model spec

`service/model/model.json` declares the conventions the encoder needs:

```json
{ "name": "multilingual-e5-small", "pooling": "mean",
  "queryPrefix": "query: ", "docPrefix": "passage: ", "maxTokens": 254 }
```

BGE-style models use `pooling: "cls"` and the instruction prefix; XLM-R style models use `<s>/</s>` instead
of `[CLS]/[SEP]` (detected at load). Changing the model requires `purge` + a full re-ingest.

## Triggers and lifecycle

- **Bootstrap**: first load with an empty index starts a detached full ingest.
- **Incremental**: every `agent/created` stats the session directory and ingests finished sessions only
  (excluded by `--exclude <current session>` and by a 120 s minimum age).
- **Single writer**: an `ingest.lock` with a pid check plus a 60 s debounce.
- **Failure backoff**: two consecutive ingest failures pause triggers for 30 minutes.
- **Service health**: a 60 s `ping`; a hung child is killed and restarted once, with the state exposed in
  the settings page.
- **Consistency**: `serve` reloads when the bucket manifest changes; a crashed `add` is repaired on start;
  deleted rows trigger bucket compaction so orphan vectors do not accumulate.

## Web routes

| Route | Purpose |
|---|---|
| `GET /throughline/status` | index, revision, service health, usage, history, exclusions |
| `POST /throughline/action` | `pause` · `resume` · `reindex` · `clear` · `notify-on/off` · `exclude-add/remove` |

Routes are plain localhost HTTP without extra authentication; this is a single-user local tool.

## Privacy

- Only dialogue text is indexed; tool calls, tool results and reasoning are dropped.
- Credentials matching `service/redaction.json` are replaced with `[REDACTED]` before storage.
- Whole workspaces, sessions or keywords can be excluded; re-ingesting applies the rule.
- `clear` removes the derived index only; session logs are never modified.
