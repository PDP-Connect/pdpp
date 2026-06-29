# Worktree harvest audit - 2026-06-29

Status: sanitized harvest index captured from low-cost read-only worker audits.

Scope: branch/worktree/documentation inventory only. No worktrees were deleted,
no branches were merged, and no live-stack mutations were performed.

Source reports were written under `tmp/workstreams/` in the operator checkout:

- `harvest-mcp-data-ci-0629.md`
- `harvest-sprawl-0629.md`

Those scratch reports intentionally remain outside the committed corpus because
they include local absolute paths. This note preserves the durable decisions in
repo-safe form.

## Closed or reduced in the closeout tranche

- MCP read-evidence and hosted-surface OpenSpec changes were reconciled and
  archived after the later live ChatGPT retests proved the intended
  schema-to-search-to-bounded-read path.
- Connector affordance OpenSpec changes were archived after schema and non-Slack
  live retests showed message-like text fields advertised lexical and semantic
  affordances.
- Slack scoped historical-hole repair was archived after live aggregate checks
  showed current Slack runs succeeding and no scoped archive keys missing from
  retained Slack `messages`.
- Amazon/Chase connector-code changes were archived or recorded as residual live
  provider gaps. Remaining rows are detail-backlog evidence requiring targeted
  owner/browser retries, not unmerged code fixes.
- CI local-mode/signoff OpenSpec was archived after the local mode status and
  tests passed.

## Branches safe to delete after routine patch-id verification

These branches appear to contain commits already absorbed into `main` or
waspflow stubs with no durable content. Before deletion, run `git cherry` or
patch-id comparison against `origin/main` where noted by the scratch report.

- MCP stale branches: `workstream/mcp-slvp-closeout`,
  `fix/mcp-record-handle-slvp-ideal`, `waspflow/mcp-parity`,
  `waspflow/mcp-topology`, `waspflow/mcp-resolve-audit-20260625`.
- Amazon stale branches: `fix/amazon-detail-budget-main`,
  `fix/amazon-detail-bounded-resume`,
  `waspflow/amazon-detail-budget-fix-0626`,
  `waspflow/amazon-detail-evidence-0626`,
  `waspflow/amazon-detail-fix-0626`.
- Connector-affordance stale branches:
  `workstream/connector-query-affordances-0626`,
  `fix/query-affordance-doc-eof-20260626`,
  `waspflow/lexical-recall`, and the `waspflow/local-bounded-*` branches from
  the same stale epoch.
- One inventory stub: `waspflow/open-threads-inventory-20260625`.

## Branches that need harvest before cleanup

Do not delete these until the named artifacts are confirmed in `main` or copied
into the durable corpus.

- `docs/the-lens-to-main`: highest-value Explore design-cell corpus and `THE-LENS`
  material. This should land as docs/research/design material, not be discarded.
- `chore/explore-research-corpus`: broad Explore research corpus that may
  overlap with, but is not guaranteed to be subsumed by, `docs/the-lens-to-main`.
- `chore/salvage-pr24-research-openspec`: OpenSpec/design-note fragments for
  merged timeline, Explore recordset presentation, owner-console redesign, and
  related wireframes.
- `trial/deploy-runtime-affordances-chatgpt-20260626`: connector query-affordance
  audit and connector-authoring research notes.
- `workstream/mcp-read-evidence-final-20260624`,
  `workstream/mcp-slvp-ideal-full-20260624`,
  `waspflow/mcp-export-revision-contract-20260624`, and
  `waspflow/mcp-rest-evidence-impl-20260624`: MCP research/OpenSpec residue from
  the June 24 closeout epoch. Most code appears superseded by shipped main, but
  research notes should be checked before cleanup.

## Branches requiring human or owner-diff review

These are not safe deletion candidates from the read-only audit alone.

- Chase QFX branches contain console UI changes beyond the QFX selector pre-wait.
  Diff them against `origin/main` before deleting or merging.
- Slack high-water branch contains collector-runner and OpenSpec material that
  may be either superseded or a fuller unmerged fix. It needs patch-id and
  behavior comparison against the shipped Slack fixes.
- Large refactor/design-sweep worktrees should remain outside this closeout
  until their owning lane marks them landed, superseded, or abandoned.

## Cleanup rule

Use patch-id equivalence and committed corpus presence as the deletion gate.
Ahead-count alone is not reliable because many stale worktrees forked from old
history and appear thousands of commits ahead while carrying little or no unique
content.
