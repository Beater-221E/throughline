# How we validate Throughline

The plugin only earns its place if a session that uses it finishes **faster and with fewer tokens**
than the same session without it. Retrieval quality alone does not prove that. This document defines
the three layers we use, and what each one can and cannot show.

## Layer 1 — retrieval quality (offline, cheap)

Fixed query set over a real corpus, ranking measured with nDCG@10 / MRR / R@5.

- 24–25 topics × 3 layers (anchor / paraphrase / cross-lingual).
- Run whenever the ranking, tokenizer or model changes.
- **Shows**: the index finds the right turns.
- **Does not show**: whether the agent uses them, or whether the task got cheaper.

## Layer 2 — live telemetry (no behaviour change)

Collected automatically by the plugin; visible in Settings → Throughline.

| Metric | Definition | What it catches |
|---|---|---|
| Trigger rate | sessions with ≥1 call / sessions started | the plugin is never used |
| Calls per session | calls / sessions started | over- or under-calling |
| Empty-result rate | calls returning 0 turns / calls | wasted calls |
| Injected tokens per call | returned tokens / calls | budget bloat |
| Estimated tokens saved | source-session tokens − injected tokens | rough confidence check only |

The last row is an **estimate**: it assumes the alternative was reading whole sessions. The real
counterfactual is measured in layer 3, not here.

## Layer 3 — task-level A/B (the decisive one)

### Task suite

20–30 tasks that need knowledge from earlier sessions but are *solvable without the plugin* by
re-exploring files or re-deriving decisions. If a task is impossible without memory, the comparison
is trivial and tells us nothing.

Typical shapes:

- continue an old project (directory conventions, script names, parameters);
- reuse a past decision and its rationale;
- follow a standing rule (delivery checklist, formatting preference).

### Protocol

- Two conditions, same model, same temperature, same starter context:
  - **Control**: plugin disabled (or tool not provided).
  - **Treatment**: plugin enabled, with the trigger policy in the system prompt.
- Paired: every task runs in both conditions; task order randomized.
- Two runs per task per condition; use the median.
- Record wall-clock from session start to the final answer.

### Metrics

| Metric | Source |
|---|---|
| total tokens (input + output) | session usage records |
| tool calls and turns to completion | session event log |
| wall-clock | session timestamps |
| success | one rubric per task, scored blind to condition |
| injected tokens | plugin `usage.jsonl` |
| net saving | control tokens − treatment tokens |
| ROI | net saving / injected tokens |

### Decision rule (fix before running)

- Median tokens down ≥ 15% **and** success not down → keep.
- Tokens down but success down → the plugin is saving the wrong things; raise precision (excerpts,
  dedupe, lower budget).
- No token change → check trigger rate and empty-result rate before touching ranking.

### Confounders to control

- The control group must not read the plugin's index by accident (disable the tool, not just the UI).
- Tasks must not leak answer text into the starter context.
- Long-tail variance: report medians and bootstrap intervals, not means.
- Learning effects: randomize order; do not reuse a task immediately.

## Usage-proxy (optional, free)

For every retrieved call, compare the rare terms of the returned turns with the next assistant
message; a high overlap suggests the recall was actually used. It is noisy and only a proxy, but it
is the only signal available without running a full A/B.

## What we do not claim

- Runtime "hit rate" is not recall: there is no ground truth at query time.
- "Estimated tokens saved" is not a measurement of task cost.
- Retrieval latency (a few ms) is irrelevant to the end-to-end goal; agent turns and token spend are
  what matter.
