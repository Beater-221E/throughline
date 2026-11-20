# Throughline

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的本地跨会话记忆插件：把历史会话按「轮次」建索引，
> 让 agent 用一个工具检索自己的过去，而不是让你重复交代。

Throughline 把 DSH 的会话历史拆成对话轮次（turn）建索引，只暴露一个模型可调用的工具 `memory_search`。
当 agent 怀疑某个事实写在更早的会话里时，它会主动检索；你不需要手动维护 `AGENTS.md`，也不需要把历史
粘进上下文。所有数据留在本机：SQLite + 一个 118M 的多语向量模型，不联网、不上云。

## 特性

- **自动入库**：首次加载自动建库；之后每个新会话触发一次增量入库。当前正在进行的会话永不入库（由 DSH 管理）。
- **轮级混合检索**：默认 `0.7 · z(向量) + 0.3 · z(BM25)`，可用 `THROUGHLINE_DENSE_WEIGHT` 调整；BM25 的词法通道把中文切成字符 bigram，因此中文专名与命令也能精确命中。
  结果按 token 预算装配，一次返回几千 token，而不是整段会话。
- **注入精炼**：默认 token 预算 1500；长轮次只注入命中句附近（摘录模式），相似轮次按 MMR 去重、最多返回 12 条，同样的信息花更少的 token。
- **触发策略**：系统提示明确「上次 / 之前 / 继续 / 约定 / 规则」等场景要先检索再回答。
- **规则注入**：会话开始把 `pinned.md` 直接注入系统提示，规则不依赖检索也生效；`control.json` 里 `"injectPinned": false` 可关闭。
- **设置页**：实时计数、已入库来源（点一下即可排除）、暂停/重建/清空、逐条事件提示、用量统计。
- **人工层**：`pinned.md` 放你希望始终优先的规则，`glossary.json` 做中英术语扩展；都是纯文本，没有编辑器界面。
- **隐私默认**：纯本地、不联网；入库前按规则脱敏凭据；可排除工作区/会话/关键词；索引可随时清空。

## 工作原理

```
会话日志 (zstd 帧)
   │  提取用户消息与助手回复文本，丢弃注入上下文、工具调用与结果
   ▼
SQLite FTS5（中文 bigram 词法）+ 向量桶（e5-small）
   │  0.7 向量 + 0.3 词法（默认），按 token 预算装配
   ▼
memory_search ──► agent 上下文
```

入库由 `agent/created` 事件触发，单写者锁 + 水位线 + 120 秒最小年龄；失败两次后进入 30 分钟退避。

## 安装

要求：DSH 0.2.2-rc.5 及以上、Python 3.10+、Node 20+、约 130 MB 磁盘给模型。

```bash
# 1. Python 依赖（装到插件将使用的同一个解释器）
python -m pip install -r service/requirements.txt

# 2. 向量模型（约 129 MB，一次性）
node scripts/fetch-model.mjs

# 3. 安装 bundle（插件 → 添加插件，选择本目录）
#    或：plugin_manager install_bundle <本目录绝对路径>
```

安装后重启一次 DSH，再刷新页面。入口在 **设置 → Throughline**。

## 使用

agent 会在需要回忆过去时自行调用：

```
memory_search(query="上次定的交付检查是什么", budget_tokens=1500)
```

你也可以把长期规则写进 `storages/throughline/pinned.md`：

```markdown
- 发布检查：提交前必须运行 scripts/audit.sh --strict。
```

`glossary.json` 用于把中文术语映射到英文/同义词，只扩展词法查询，不影响向量通道：

```json
{ "压缩": ["zstd", "compression"] }
```

## 评测摘要

在 1,312 turn / 58 会话的真实中英混合语料上，用 75 条分层查询（锚点 / 改写 / 跨语言）评测：

| 配置 | 总体 nDCG@10 | MRR | R@5 |
|---|---|---|---|
| 纯向量（e5） | 0.258 | 0.409 | 0.520 |
| 纯词法（中文 bigram） | 0.252 | 0.420 | 0.507 |
| 0.3 向量 + 0.7 词法 | 0.275 | 0.448 | 0.533 |
| **0.7 向量 + 0.3 词法（默认）** | **0.310** | **0.491** | **0.627** |

（上表是在当前 1,312 turn 库上重跑的一次消融。权重是环境变量 `THROUGHLINE_DENSE_WEIGHT`，可在 0–1 之间调。）

关键结论：中文词法通道是最大的单点收益；稠密与词法的权重取决于语料规模与查询类型，没有全局最优。
完整的方法、模型对比、被否决的方案与失败分析见 **[docs/TECHNICAL-REPORT.md](docs/TECHNICAL-REPORT.md)**。

## 局限

- **跨语言召回弱**：英文问中文内容时，小模型只有约 0.08 nDCG；同语言检索好得多（0.30–0.44）。
- **纯改写查询不稳定**：带专名、命令、标识符的查询召回最好；这是测量结果，不是猜测。
- 索引是派生缓存，可随时重建；不回写你的会话。
- 只在单机单用户、单一 DSH 版本上验证过；不支持多用户或远程部署。

## 开发

```bash
node tests/run.mjs          # 16 个用例，不需要 DSH
MP_PYTHON=python3 node tests/run.mjs
```

代码结构：`index.js`（Host 插件）、`client.js`（设置页 UI）、`service/memory.py`（索引与检索）、
`service/ingest.mjs`（日志提取与入库）、`service/settings.js`（设置路由）。

## 许可证

MIT，见 [LICENSE](LICENSE)。下载的向量模型遵循其上游许可（`Xenova/multilingual-e5-small`）。
