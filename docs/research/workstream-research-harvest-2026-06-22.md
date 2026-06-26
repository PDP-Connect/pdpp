# Workstream Research Harvest Recovery - 2026-06-22

Status: captured from delegated read-only harvest lanes. This note is a synthesis, not a bulk import of worker reports.

## Source Reports

Four Sonnet lanes scanned ignored `tmp/workstreams/` reports and related worktrees for findings that should not remain scratch-only:

- `tmp/workstreams/research-harvest-explore-20260622.md`
- `tmp/workstreams/research-harvest-owner-20260622.md`
- `tmp/workstreams/research-harvest-ri-20260622.md`
- `tmp/workstreams/research-harvest-mcp-20260622.md`

The reports themselves remain operational scratch. This document records the durable synthesis.

## High-Confidence Recoveries

- `docs/research/` currently contains 35 untracked research notes. This is the largest immediate recovery target because these notes are already in the correct durable location but are not protected by git. They should be reviewed as a batch, then committed or explicitly discarded.
- The Explore redesign corpus is legitimate collateral, not noise. It includes the verbatim feedback corpus, prior-art notes, relayout plan, visual-feel plan, burst-ordering research, semantic-time/load-more/cursor diagnoses, and full-visibility/search-result-set research. Some older diagnosis notes describe bugs that were later fixed; keep them as historical root-cause evidence only if their status is made clear.
- The MCP large-content/accessibility findings are legitimate and should feed an OpenSpec change before MCP tool responses, resource contracts, or body-window endpoints change. The live issue is not simply token budgeting; client-visible opaque markers can block full navigation even when the data exists server-side.
- The ChatGPT connector batch/improvement notes and instance-branding note are legitimate research artifacts. They should be committed or explicitly folded into their owning OpenSpec/code changes.

## Not Durable Research By Itself

- Waspflow verdict files are mostly operational gate evidence. Keep them only when they contain a reusable design decision, failure mode, or test invariant that is not already in OpenSpec, tests, or a research note.
- Screenshots and JPEG audit artifacts at the repo root are transient evidence. Archive outside tracked docs or discard unless a specific issue needs a stable image artifact.
- Several worker claims about Explore are stale because later commits fixed or superseded the issue. Do not promote a scratch finding without reconciling it against current main/live state.

## Branch/Workstream Recovery Signals

The RI harvest surfaced recoverable implementation work rather than research prose:

- `decomplect-ri-construction-boundaries` is the largest unmerged body and needs an owner review or explicit closure.
- `workstream/lexical-search-recency-ri`, `overnight-ui-work`, and `workstream/ri-seam-march-v1` appear to contain potentially useful commits that need normal review gates, not blind merge.
- Older single-commit OJ, connector-summary, overview/standing, and perf branches should be batch-triaged as merge, superseded, or discard.

## Recommended Follow-Up

1. Commit or explicitly discard the 35 untracked `docs/research/` files. Leaving them untracked recreates the same memory-loss risk as `tmp/workstreams/`.
2. Open an OpenSpec change for the MCP content ladder before changing MCP response shapes. Seed it from `docs/research/mcp-large-data-surface-patterns-2026-06-22.md` and `docs/research/mcp-content-ladder-slvp-research-2026-06-22.md`.
3. Batch-review the named RI/workstream branches with normal merge gates. Treat them as implementation recovery, not research promotion.
4. Add a workstream closeout rule: every nontrivial worker report should end as `promoted`, `absorbed`, `committed`, `superseded`, or `discarded`. `tmp/workstreams/` must not be the terminal location for durable findings.
