# Changelog

## 1.0.0 — first stable release (2026-11-20)

第一个稳定版本。功能与文档冻结如下：

**检索**
- 轮级混合检索：SQLite FTS5 + multilingual-e5-small（int8 ONNX）。
- 中文词法通道：字符 bigram；英文查询自动切纯稠密通道（中文 0.7 / 英文 1.0）。
- 注入精炼：MMR 去重、长轮次摘录、1500 token 预算、最多 12 条。
- 人工层：`glossary.json` 术语扩展、`pinned.md` 规则（会话开始直接注入）。

**入库**
- 安装时自动全量、`agent/created` 触发增量；水位线、单写者锁、失败退避。
- 排除规则（工作区/会话/关键词）、凭据脱敏（JS/Python 共用规则文件）、按会话替换、向量桶压缩。

**产品**
- 设置页：状态、来源与一键排除、暂停/重建/清空、逐条事件提示、用量与触发率统计。
- 系统提示：显式触发策略；工具描述带示例。

**工程**
- 18 个回归用例；崩溃修复、健康检查与自动重启、日志轮转、用量记账。
- 文档：中文 README、架构、技术报告、验证协议、路线图、变更记录。

## 0.14.0 — language-aware weighting
- Queries without CJK characters use the dense channel only (weight 1.0); Chinese queries keep 0.7.
  Measured: overall nDCG 0.310 → 0.326, cross-lingual 0.072 → 0.117, anchors/paraphrase unchanged.
- Both weights are tunable (`THROUGHLINE_DENSE_WEIGHT` / `THROUGHLINE_EN_DENSE_WEIGHT`).
- Tool description lists trigger examples.

## 0.13.0 — injection efficiency, trigger policy, telemetry
- Excerpts (sentence window around the match) and MMR de-duplication; default budget 3000 → 1500;
  at most 12 turns per call; selection profiled to ~25 ms.
- Explicit trigger policy in the system prompt; `pinned.md` injected at session start
  (`control.json` → `injectPinned`).
- Session-start telemetry; Settings shows trigger rate, calls/session and empty-result rate.
- `docs/VALIDATION.md`: the three-layer protocol for proving end-to-end efficiency.

## 0.12.0 — denser default, public docs
- Default hybrid weight is now **0.7 dense / 0.3 lexical** (0.310 vs 0.275 nDCG@10 on the current
  1,312-turn corpus); `THROUGHLINE_DENSE_WEIGHT` makes the mix tunable.
- README rewritten in Chinese; `docs/TECHNICAL-REPORT.md` added (workflow, component rationale,
  experiments, costs); `docs/EVALUATION.md` merged into it.

## 0.11.0 — usage accounting
- One `usage.jsonl` line per call; settings page shows calls, injected tokens, estimated tokens saved,
  estimated time, share of source, latency, optional cost (`control.json → pricePerMTok`).
- Per-session token stats for the savings estimate.
- Fixes: stale `stats.json` during rebuild; orphan vectors after replace-by-session (compaction);
  unclosed npz handles on Windows.

## 0.10.2 — per-event toasts
- Every call, every ingested session and every finished run produces its own toast (no cap).
- Worker events (`events.jsonl`) are drained incrementally by the panel.

## 0.10.1 — removal-only exclusions
- The settings page no longer has a manual add form; each indexed source has a remove button.

## 0.10.0 — human layers
- `pinned.md` (rules, +0.8 boost) and `glossary.json` (bilingual query expansion).
- Reranker measured but not shipped (latency); auto-derived lexicon rejected.

## 0.9.0 — robustness
- Service health ping with restart, log rotation, bounded run history, on-disk vs loaded version.

## 0.8.0 — usage loop
- Session-start memory hint, exclusions, ingest redaction, Chinese-first query guidance.

## 0.7.0 — evaluation harness
- 72-query layered evaluation; five planned ranking changes measured and rejected.

## 0.6.0 — verifiability
- Test suite, status revision, crash repair on start, failure backoff.

## 0.5.0 — Chinese lexical channel
- CJK bigram term stream, hybrid weight moved to 0.3/0.7.

## 0.4.0 — multilingual embeddings
- bge-small-en replaced by multilingual-e5-small (prefix + pooling support, XLM-R tokenizers).

## 0.3.0 — settings page
- Status, pause/reindex/clear, per-session event toasts (sample UI).

## 0.2.0 — automatic ingest
- Session extractor, watermark, detached worker, sharded vector buckets.

## 0.1.0 — first bundle
- `memory_search` over a manually built SQLite + ONNX index.
