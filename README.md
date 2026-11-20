# Throughline

> Cross-session conversation memory for [DeepSeek Harness](https://github.com/deepseek-ai) — search every past
> turn of your own sessions, locally, with one tool.

**English** | [简体中文](#简体中文)

Throughline indexes your DSH session history as dialogue turns and exposes it as a single model-callable
tool, `memory_search`. The agent can recall what was said in an earlier session instead of asking you to
repeat it. Everything runs on your machine: SQLite + a 118M multilingual embedding model, no network calls.

## What it does

- **Automatic indexing** — on first load it bootstraps the existing history; afterwards every new session
  triggers one incremental pass. The live session is never indexed (DSH owns it).
- **Turn-level hybrid search** — `0.3 · z(dense) + 0.7 · z(BM25)`, where BM25 runs over latin words plus
  CJK character bigrams. Results are filled to a token budget, so a call returns a few thousand tokens
  instead of whole sessions.
- **Settings page** — live counts, indexed sources with one-click exclusion, pause/rebuild/clear,
  per-event toasts, and usage accounting.
- **Human-maintained layers** — `pinned.md` for rules you want to stay first in recall, `glossary.json`
  for bilingual term expansion. Both are plain files; there is no authoring UI.
- **Privacy by default** — local-only, no cloud, credentials redacted at ingest, workspaces/sessions
  can be excluded, the index can be wiped at any time.

## Requirements

- DSH 0.2.2-rc.5 or newer (Host bundle with a web client)
- Python 3.10+ with `numpy`, `onnxruntime`, `tokenizers` (see `service/requirements.txt`)
- Node.js 20+ (the DSH runtime's node works)
- ~130 MB of disk for the embedding model (downloaded, not committed)

## Install

```bash
# 1. dependencies (into the same Python the plugin will use)
python -m pip install -r service/requirements.txt

# 2. embedding model (~129 MB, one time)
node scripts/fetch-model.mjs

# 3. install the bundle into your DSH profile
#    Plugins → Add plugin → choose this directory, or:
#    plugin_manager install_bundle <absolute path to this directory>
```

Restart DSH once so the Host module loads, then refresh the page. Open **Settings → Throughline**.

## Usage

The agent calls `memory_search` on its own when it suspects a fact lives in earlier sessions:

```
memory_search(query="上次定的交付检查是什么", budget_tokens=1500)
```

You can also write long-term rules to `storages/throughline/pinned.md`:

```markdown
- 发布检查：提交前必须运行 scripts/audit.sh --strict。
```

## Design

Throughline is the *retrieval* branch of a memory design, not a self-updating knowledge base.
Earlier experiments on the author's own sessions showed that write-side distillation (knowledge graphs,
auto-maintained `AGENTS.md`) costs more than it saves: 89% of repeated work was environment rebuild,
87.8% of error signatures never recur, and a distilled wiki tends to grow as large as its corpus.
Indexing raw turns and searching them on demand keeps fidelity and has no drift.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/EVALUATION.md`](docs/EVALUATION.md).

## Limitations

- **Cross-lingual recall is weak** (English query → Chinese content): the small multilingual model reaches
  ~0.19 nDCG@10 on that layer. Same-language recall is much better (0.30–0.44).
- **Pure paraphrase without distinctive terms** is unreliable; queries carrying names, commands or
  identifiers retrieve best. This is measured, not guessed.
- The index is a derived cache. It can be rebuilt in seconds; nothing is written back to your sessions.
- Retrieval quality and runtime are validated on one machine; large multi-user deployments are unsupported.

## License

MIT — see [`LICENSE`](LICENSE). The bundled/downloaded embedding model follows its upstream license
(`Xenova/multilingual-e5-small`).

---

## 简体中文

**Throughline** 是给 DeepSeek Harness 用的本地跨会话记忆插件：把历史会话按「轮次」建索引，通过一个
`memory_search` 工具按需召回，数据全部留在本机。

- 安装：`pip install -r service/requirements.txt` → `node scripts/fetch-model.mjs` →
  `plugin_manager install_bundle <本目录绝对路径>` → 重启 DSH。
- 能力：自动入库、中英混合检索（0.3 向量 + 0.7 词法，中文用字符 bigram）、设置页（暂停/重建/清空/
  排除来源/用量统计/逐条提示）、`pinned.md` 手工规则、`glossary.json` 术语扩展。
- 已知边界：英文问中文内容召回较弱；不带专名的纯改写查询不稳定；索引是派生缓存，可随时重建。

详细设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，评测与数字见
[`docs/EVALUATION.md`](docs/EVALUATION.md)。
