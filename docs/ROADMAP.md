# Roadmap

## v1.0.0 已完成

- Turn-level indexing with automatic bootstrap and per-session incremental ingest.
- Hybrid ranking with CJK bigram lexical channel.
- Append-only vector buckets with compaction, crash repair and manifest-based reload.
- Settings page: status, sources and one-click exclusion, pause / reindex / clear, per-event toasts,
  usage accounting.
- Human layers: `pinned.md`, `glossary.json`.
- Local-credential redaction shared by JS and Python.
- Test suite (`node tests/run.mjs`, 16 cases).

## 1.x 候选

| Item | Why it is not done | Cost |
|---|---|---|
| Optional cross-encoder rerank ("deep search") | quality +7pt R@1, but ~1.8 s/query breaks the latency budget | 283 MB, opt-in |
| Date-aware filtering ("last week") | mechanism verified on a 6-query pilot, evidence too thin | parsing + eval set |
| Stronger multilingual model | bge-m3 is 543 MB for a dense-only gain | size |
| Passage-level chunking for long turns | 510-token window showed no gain; needs a long-reply eval first | medium |
| Multi-user / remote serving | out of scope: localhost single-user tool | large |

## Non-goals

- A memory browser or editor: the index is derived and would drift.
- A self-updating `AGENTS.md` / knowledge graph: earlier measurements showed the write side costs more
  than it saves (89% of repeated work is environment rebuild, 87.8% of errors never recur).
- Cloud sync, authentication, multi-tenant deployment.
