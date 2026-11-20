# Evaluation

All numbers come from one real 1,167-turn / 54-session personal corpus (972 Chinese, 195 English turns).
They are single-machine measurements, not a benchmark claim.

## Protocol

- **Queries**: 24 topics × 3 layers = 72 queries.
  - *anchors*: the query contains a distinctive token (command, model name, identifier).
  - *paraphrase*: Chinese paraphrase with minimal literal overlap.
  - *crosslingual*: English paraphrase of Chinese content.
- **Gold**: turns containing the topic's rare token (2–80 turns per topic).
- **Metrics**: nDCG@10 (primary), MRR, R@5, R@1; paired bootstrap over queries.
- **Corpus**: the same 1,167 turns for every configuration.

## Lexical channel (the biggest single win)

Adding CJK bigrams to the term stream (instead of FTS5's default tokenizer):

| Configuration | nDCG@10 | MRR | R@5 |
|---|---|---|---|
| dense only (e5) | 0.304 | 0.391 | 0.486 |
| BM25 with CJK bigrams only | 0.344 | 0.524 | — |
| 0.7·dense + 0.3·BM25 (old default) | 0.323 | 0.443 | 0.528 |
| **0.3·dense + 0.7·BM25 (current)** | **0.346** | **0.583** | 0.528 |

Weight sweep (dense/BM25): the optimum is flat between 0.0/1.0 and 0.3/0.7
(MRR 0.573 → 0.563); 1.0/0.0 collapses to 0.304.

## Embedding model

Same corpus, same queries, hybrid 0.3/0.7 where applicable:

| Model | Size | anchors | paraphrase | crosslingual | overall nDCG | MRR |
|---|---|---|---|---|---|---|
| bge-small-en-v1.5 | 34 MB | 0.471 | 0.377 | 0.084 | 0.311 | 0.474 |
| bge-small-zh-v1.5 | 23 MB | 0.405 | 0.331 | 0.080 | 0.272 | 0.408 |
| **multilingual-e5-small** | **129 MB** | 0.437 | 0.379 | 0.084 | 0.300 | 0.449 |
| paraphrase-multilingual-MiniLM-L12 | 129 MB | — | — | — | 0.052 (dense) | — |

Dense-only comparison shows the trade-off more clearly: e5 reaches 0.168 nDCG on the paraphrase layer,
the English model 0.000 (it cannot embed Chinese), and e5 improves cross-lingual dense recall 2.6× over
the English model. The hybrid total hides this because BM25 carries most of the signal on anchor queries.

**Known gap**: English query → Chinese content stays around 0.08 nDCG across all tested models. A stronger
multilingual model (bge-m3, 543 MB int8) raises dense-only cross-lingual nDCG from 0.075 to 0.195 but does
not change the hybrid total much; it is not shipped by default.

## Interventions that did **not** help

| Change | Δ nDCG@10 | 95% CI | Verdict |
|---|---|---|---|
| short-turn damping (cos × len/40) | −0.012 | [−0.029, +0.002] | rejected — hurts anchors |
| adaptive weight (dense 0.6 when <3 lexical hits) | −0.001 | [−0.003, +0.000] | rejected |
| Chinese stop-bigram filtering | −0.000 | 0 | rejected |
| 510-token window | −0.000 | [−0.002, +0.003] | rejected (long-gold R@10 39/72 unchanged) |
| corpus-derived bilingual lexicon | −0.097 | — | rejected (noise) |
| curated glossary expansion (24 terms) | **+0.067** | — | adopted, but the term list was written with the eval topics in view (upper bound) |
| pinned facts + 0.8 boost | hit@3 4/6 → **6/6** | — | adopted |
| bge-reranker-base int8, top-20 | R@1 0.347 → 0.417, MRR 0.449 → 0.506 | — | not default: **~1.8 s/query** |

## Honest caveats

- 72 queries over 24 topics are not independent; differences below ~0.02 are not distinguishable.
- The query set is anchor-heavy, which flatters BM25. The pure-paraphrase layer is the honest weak spot.
- Savings reported in the settings page are estimates (source-session tokens minus injected tokens;
  time assumes 300 tokens/s re-reading). They are labelled as estimates in the UI.
- Runtime "hit rate" is a proxy (fraction of calls returning at least one turn), not recall: there is no
  ground truth at query time.
