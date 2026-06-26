# Post-Owner-Journey Broader Work Ledger

Status: sprint-needed
Owner: RI owners
Created: 2026-06-18
Updated: 2026-06-18
Related: `tmp/workstreams/owner-journey-completion-audit-20260618.md`, `design-notes/owner-console-slvp-execution-plan-2026-06-16.md`, `openspec list`

## Question

What broader PDPP work must remain visible after the console owner-journey tranche was completed, so we do not mistake that tranche for completion of the overall reference implementation roadmap?

## Context

The console owner-journey goal was completed at `14449546` and verified by:

- live stack verification
- live owner-journey acceptance harness
- live browser proof
- `reference-implementation`, `docker-images`, and `semantic-release` GitHub workflows

That goal intentionally did **not** close the broader PDPP roadmap. Several important workstreams remain active, incomplete, or captured only in ignored `tmp/workstreams` reports and stale worker lanes.

## Stakes

Forgetting this broader work would create two failure modes:

- treating a verified console journey tranche as if the whole reference implementation is SLVP-complete
- losing design and implementation context that currently exists only in temporary workstream files or stale worker branches

The owner standard remains the SLVP ideal: protocol/reference behavior should be correct, honest, reusable, and verified by end-to-end evidence, not merely patched until the current UI walkthrough passes.

## Current Leaning

Use this ledger as the tracked handoff until each item is either promoted into an OpenSpec change, completed and archived, or explicitly deferred.

### 1. Search And Retrieval

Do not forget:

- `restore-postgres-bm25-topk-search` is active and incomplete.
- The search path needs production dual-backend conformance comparable to the record-window parity suite. The desired next slice is parity evidence for connector-instance scoping, multi-stream fan-in ordering and limits, snippets and marking, recall disclosure fields, pagination/snapshot cursor behavior, and authored/recency sort behavior.
- The earlier IndexPrimitives idea should not be built merely to reduce branch count. Thin dispatch is acceptable; executable parity is the higher-value convergence mechanism.
- Postgres CI coverage for search/storage remains a separate tranche. Enabling `PDPP_TEST_POSTGRES_URL` broadly in CI surfaced many latent failures and cross-suite pollution, so it needs per-suite database isolation before being turned on as a standing gate.

Promotion trigger:

- Any change to public search envelopes, recall disclosure fields, ranking semantics, or backend search contracts needs OpenSpec coverage.
- Any CI Postgres enablement should be its own tracked change, not a rider on a search-conformance patch.

### 2. Storage Convergence

Do not forget:

- Increment 1 and Increment 2 of storage convergence landed the valuable pieces: shared helpers and dual-backend conformance that caught real drift.
- Increment 3 as originally framed is not approved. Branch elimination is not enough; new abstraction must remove a real semantic seam or enable stronger proof.
- Known next-value direction is conformance first, especially where production code paths still diverge between SQLite and Postgres.
- The bugfix review showed single-pass RI review was insufficient. Substantive storage/runtime tranches need adversarial audit or equivalent red-team proof before merge/deploy readiness.

Promotion trigger:

- A new storage backend interface, new DDL contract, or CI Postgres policy change needs OpenSpec or an update to an active storage-convergence change before implementation.

### 3. Connector Summary Read Model And Performance

Do not forget:

- `maintain-connector-summary-read-model` is active and incomplete.
- The console owner journey is fast enough for the verified tranche, but the SLVP ideal for the hot source-summary path is a maintained read model, not repeated deep read-time synthesis.
- Any "shallow rows for speed" compromise should be treated as temporary unless the read model preserves the evidence needed for trust, health, collection reports, rendered verdicts, and next actions.

Promotion trigger:

- Persisting new summary fields, changing invalidation semantics, or changing the owner-visible health/next-action projection should stay under the read-model OpenSpec change.

### 4. Connector And Source Lifecycle

Do not forget:

- `add-google-maps-data-portability-connector` remains active and incomplete.
- Google Maps and WhatsApp import-style flows are honest in the completed console tranche, but the broader acquisition-coverage model still needs continued work for recurring/manual exports, same-stream historical plus current acquisition, media/no-media choices, and source identity control.
- The source lifecycle should preserve the owner model: multiple accounts or devices can be distinct connections; imports should not silently create confusing duplicates or merge unrelated accounts.
- Browser-backed source creation and repair need a clear distinction between generic connector pages and exact existing-source repair pages.

Promotion trigger:

- New acquisition semantics, stream merge rules, recurring reminder flows, or source identity rules need OpenSpec treatment before implementation.

### 5. Local Collector Reliability And Recovery

Do not forget:

- `generalize-local-connector-bounded-reads` is marked complete, but any remaining collector OOM or bounded-memory claims need current proof before being treated as closed across all collectors.
- The console now routes device-local recovery to source detail with commands, but the deeper SLVP target is less manual friction: the system should explain what is wrong, whether the owner can fix it, and the smallest safe action to recover.
- Stale worker lanes mention bounded-memory work for Twitter, Slack, iMessage, and guards. Those lanes need reaping or disposition so real fixes are not stranded.

Promotion trigger:

- Shared collector memory contracts, durable checkpoint changes, or new recovery automation should be OpenSpec-backed.

### 6. Protocol, Grants, MCP, And Agent Access

Do not forget active or nearly complete work:

- `prove-single-use-grant-consumption`
- `reduce-mcp-tool-surface-footprint`
- `define-mcp-agent-entrypoint-surface`
- `add-grant-scoped-mcp-device-authorization`
- `surface-grant-client-metadata`
- `render-three-class-consent-authorship`

The MCP surface became strong, but CLI and REST parity must stay part of the RI bar. MCP should not be a privileged implementation path with better semantics than the other read surfaces unless that difference is explicitly designed and documented.

Promotion trigger:

- Any durable grant lifecycle, client identity, introspection, dynamic client registration, device authorization, or read-surface envelope change needs spec/OpenSpec alignment across MCP, REST, and CLI.

### 7. Deployment, Release, And Self-Host Operations

Do not forget:

- `add-docker-core-deploy-target`, `publish-reference-browser-image`, `adopt-single-release-channel`, `publish-mcp-server-package`, and `republish-remote-surface-as-opendatalabs` remain active or incomplete.
- Railway/Docker/Coolify-style setup should minimize operator friction without hiding required security posture, especially credential encryption and static-secret storage.
- The live-stack mutex rule remains mandatory for deploy/restart/vacuum/container operations.
- Remote pushes should be deliberate and batched, not per-worker-branch reflex.

Promotion trigger:

- New supported deployment targets, release-channel changes, or credential/operator setup changes need OpenSpec or deployment design notes.

### 8. Console UX Beyond The Completed Journey

Do not forget:

- The completed tranche proves the walked owner journeys, not every possible state.
- Non-blocking observations remain:
  - collapsed Add Data `Other ways to add coverage` summaries have `textContent` while `innerText` is blank because they are inside collapsed import-option regions
  - Deployment reports storage backend as SQLite while the stack includes Postgres; this needs topology clarification before being called a UI bug
- Future console work should keep the process change: journey ledger first, live/browser evidence, then implementation. Unit tests and grep gates are insufficient alone.

Promotion trigger:

- Any new dashboard IA, source lifecycle, recovery flow, or owner-facing state vocabulary change needs either an OpenSpec change or a design note promoted before implementation.

### 9. Backlog Hygiene

Do not forget:

- `openspec list` currently shows many complete changes still active. Complete changes should be reviewed and archived so the active list reflects actual work.
- `pnpm workstreams:status -- --no-fail` reports stale live lanes and dirty worker worktrees. They should be reaped, preserved, merged, or explicitly abandoned after inspecting their reports and diffs.
- Pre-existing untracked screenshot/research artifacts remain in the main worktree. They should be either committed if useful, moved to the right tracked location, or intentionally cleaned after confirming they are not sole evidence.

Promotion trigger:

- Cleanup does not need OpenSpec unless it changes product behavior. It does need explicit evidence before deleting preserved worker outputs.

## Promotion Trigger

Promote a specific item from this ledger into OpenSpec when it changes:

- protocol or read-surface contracts
- reference architecture boundaries
- storage or search semantics
- connector/source lifecycle semantics
- owner-facing state vocabulary
- deployment/security posture
- multi-step implementation tranches

Keep purely procedural cleanup as a tracked workstream report unless it changes behavior.

## Decision Log

- 2026-06-18: Captured after the owner-journey completion audit so the completed console tranche is not confused with completion of the broader RI roadmap.
- 2026-06-18: Current strongest next slices are search production-code conformance, connector-summary read model completion, storage/Postgres CI convergence, and backlog/workstream hygiene.
