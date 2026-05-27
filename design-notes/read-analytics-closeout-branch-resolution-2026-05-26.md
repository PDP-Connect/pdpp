# Read Analytics Closeout Branch Resolution

Status: decided-defer
Owner: reference implementation owner
Created: 2026-05-26
Updated: 2026-05-26
Related: `read-analytics-closeout`, `canonicalize-public-read-contract`, `expose-connection-identity-on-public-read`, `add-postgres-expand-hydration`

## Question

Should the stale `read-analytics-closeout` branch be merged into `main`,
salvaged by cherry-pick, or retired?

## Context

`read-analytics-closeout` was a large workstream branch with 56 commits on
top of an older mainline. By 2026-05-26, `main` had already landed newer
versions of the high-confidence read-contract, connection identity, MCP,
Postgres expansion, record-version, compaction, dashboard, and search fan-in
work.

Direct merge is not acceptable. The branch diff against current `main`
touches 361 files, deletes 124 files, and removes current fan-in/search,
records explorer, compaction, and dashboard tests. Its direction is stale
relative to the current construction boundaries.

A direct cherry-pick probe of the most valuable remaining commit,
`26607f2c feat(reference): land time_bucket date aggregation (Phase 2)`,
also conflicted across MCP tool definitions, reference-contract files,
generated docs, `server/index.js`, `server/records.js`, and runtime tests.
That confirms the remaining useful work cannot be replayed safely as patches.

## Stakes

Keeping the branch as an active worktree creates cognitive load and makes
`workstreams:status` look less trustworthy. Merging it would be worse: it
would regress the current reference implementation and overwrite newer
contract work. Deleting it without preserving the useful residuals would lose
valid product/API ideas.

## Current Leaning

Retire the branch as an implementation branch. Preserve its remaining value as
future current-main work, not as old code.

Already superseded by current `main`:

- Hosted MCP grant packages and connection-aware MCP selection.
- MCP/REST read parity and LLM-facing read guidance.
- Connection identity on public reads and search hits.
- Postgres one-hop expansion hydration.
- Canonical read envelope, warning vocabulary, schema capability truth, and
  fan-in search semantics.
- Record-version no-op detection, compaction, and connector fingerprint cursor
  fixes.

Still useful but not currently landed on `main`:

- Date-bucket aggregations, e.g. `time_bucket=sent_at:month`.
- Reverse relation filters, e.g. `filter[via.reactions.user_id]=U123`.
- Stream-catalog change detection, e.g. `/v1/streams?changed_since=<iso>`.
- Safer first-party facet declarations for Slack and Gmail categorical/time
  fields.
- Filed research prompts for Drive parity and lexical term-frequency
  aggregation.

The SLVP path is a fresh OpenSpec change against current `main`, scoped to
analytics read capabilities, using the current canonical read/operation
boundaries. Do not revive the stale branch wholesale.

## Promotion Trigger

Promote this note when the next read/explorer/MCP tranche needs one of the
remaining analytics capabilities. The new change should start from the
current source of truth in `packages/reference-contract/src/public/index.ts`,
`reference-implementation/operations/*`, `reference-implementation/server/*`,
and `packages/mcp-server/src/tools.js`, not from the old branch layout.

## Decision Log

- 2026-05-26: Classified `read-analytics-closeout` as not mergeable because it
  would delete or stale-revert current mainline work.
- 2026-05-26: Tested cherry-picking `26607f2c` onto current `main`; conflicts
  confirmed that even the best residual analytics work requires a fresh
  implementation.
- 2026-05-26: Decision: remove the local worktree/branch after this note lands;
  keep the remote branch only as historical backup unless explicitly deleted
  later.
