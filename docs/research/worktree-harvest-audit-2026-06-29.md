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

## 2026-06-30 closeout update

The closeout pass added the remaining durable scratch findings to
`docs/research/`:

- `chatgpt-session-reuse-regression-closeout-2026-06-29.md`
- `amazon-detail-hydration-rootcause-2026-06-26.md`
- `mcp-handle-footgun-audit-2026-06-26.md`

It also reopened `openspec/changes/unify-source-actionability-model` with a
specific unchecked task for the connection-diagnostics bypass found after the
actionability surface work landed. That change is valid and intentionally active;
do not archive it until the detail diagnostics surface consumes the shared
source-actionability model.

Seventeen completed OpenSpec changes were archived after the CLI successfully
folded their deltas into the canonical specs:

- `accelerate-rs-search-postgres`
- `add-aggregate-other-rollup`
- `add-explore-merged-timeline`
- `add-explore-record-buckets`
- `add-google-maps-timeline-import`
- `add-spine-events-source-run-summary-index`
- `bound-version-stats-default-read`
- `define-collection-acquisition-coverage`
- `enforce-connection-scoped-provider-credentials`
- `ensure-required-reference-check-emits`
- `fix-run-stream-terminal-honesty`
- `gate-scheduled-auth-required-runs`
- `generalize-local-connector-bounded-reads`
- `scope-dashboard-source-evidence`
- `share-record-identity-renderer`
- `surface-dashboard-advisory-actions`
- `surface-grant-client-metadata`

Twelve completed-looking changes were deliberately retained because
`openspec archive` aborted before moving them: their deltas target spec headers
that no longer exist, or attempt to add requirements already present. They need
a spec-sync review before archiving, not a blind `--skip-specs` move:

- `accelerate-connection-summary-projection`
- `accelerate-postgres-record-list-reads`
- `accelerate-reference-spine-overview-lists`
- `accept-native-loopback-redirect-port`
- `add-console-connection-revoke-delete-controls`
- `bound-browser-detail-page-content`
- `delay-sources-read-failure-escalation`
- `fix-run-stream-connection-label`
- `fix-scheduled-run-store-credential-injection`
- `fix-source-status-actions`
- `harden-polyfill-operational-recovery`
- `surface-run-handle-resolvability`

After this update, `openspec validate --all --strict` passes. Remaining active
changes are therefore known-valid, not abandoned by default.

Operational cleanup performed from the owner checkout:

- Removed sixteen registered worktrees that were clean and either ancestors of
  `origin/main` or patch-equivalent to it.
- Deleted fourteen patch-equivalent local branches after their worktrees were
  removed.
- Deleted nine additional local branches whose upstream was gone and whose
  cherry set against `origin/main` was empty.
- Reaped nine stale waspflow lanes with harvested reports or no deliverable.
- Reaped five stale stub lanes as failed because their original required reports
  were never produced; their clean stub worktrees had already been removed or
  proven patch-equivalent/absent.

Residual cleanup that needs owner-machine sudo, not repo design work:

- Three orphan deploy directories remain because root-owned fixture-capture
  files block non-interactive removal. They are no longer registered git
  worktrees. A narrow cleanup script was written to
  `/tmp/pdpp-remove-orphan-deploy-worktrees.sh`; it refuses to remove a path if
  it is still a git worktree/repo.

Remaining gone-upstream local branches were deliberately retained when they were
checked out in another worktree or had unique cherry commits. Remaining dirty or
unknown worktrees are retained by default.

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
