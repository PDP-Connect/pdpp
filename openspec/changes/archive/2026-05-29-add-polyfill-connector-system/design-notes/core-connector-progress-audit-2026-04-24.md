# Core Connector Progress Audit

Status: captured
Owner: connector worker
Created: 2026-04-24
Updated: 2026-04-24
Related: openspec/changes/add-polyfill-connector-system

## Question

Which core polyfill connectors can emit honest `PROGRESS.count` and `PROGRESS.total` without changing protocol contracts or doing extra source reads solely for progress?

## Context

The reference runtime already accepts optional non-negative `PROGRESS.count` and `PROGRESS.total`; this pass is connector-side only. Totals are useful only when the connector already has a bounded unit in hand, such as an API response array, an in-memory metadata list, or an enumerated account/document list.

## Stakes

Dashboard progress should distinguish a live but long connector from a stuck connector. Faked totals are worse than no percent because they make operator confidence look better than the source can justify.

## Current Leaning

| Connector | Existing PROGRESS | Honest count/total opportunity | Action |
| --- | --- | --- | --- |
| ynab | Phase-only per stream/budget | API arrays returned for budgets, accounts, categories, payees, transactions, scheduled transactions, months, active month-category months | Patched bounded completion/progress counters |
| gmail | Header/body batch progress | Header list count after metadata pass; body pass knows `metas.length` | Patched body batch `total` and final header total |
| github | Phase-only per stream | Search API exposes `total_count` for pull request search; REST list streams do not cheaply expose total with current helper | Patched PR page counters; current code no longer emits undeclared `commits` progress |
| slack | Phase and incremental filtering messages | Full-run totals come from slackdump archive and SQLite rows after expensive subprocess/import work; incremental row count is already known | Deferred beyond existing incremental count-in-message |
| chase | Account and statement lists are enumerated before per-item work | Filtered account count and statement row count | Patched per-account and per-statement counters |
| usaa | Browser extraction and PDF hydration progress | Statement hydration summary has attempts/successes | Patched hydration counters |
| chatgpt | Conversation listing and detail batches | Detail phase has a bounded conversation list | Patched found/synced conversation counters |
| claude_code | Very noisy per-file/per-line parse progress in two passes | Total files would require a pre-walk; duplicate per-line build/emit progress can be compacted | Patched line-progress to emit phase only and labeled build vs emit file progress |
| codex | File/line progress and coarse phase messages | Total rollouts can be known only while walking the filesystem already done by the connector, but current progress is not the highest live pain | Deferred |

## Promotion Trigger

Promote to a protocol/OpenSpec change only if the runtime needs a new progress state model, estimated totals, nested phases, or streamless connector-level progress fields. This pass did not require any protocol change.

## Decision Log

- 2026-04-24: Use optional `count`/`total` only where the bounded unit is already known. Do not add network calls, pre-walks, or second reads just to compute percentages.
