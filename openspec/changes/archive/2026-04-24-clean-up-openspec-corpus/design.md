## Goal

End with an OpenSpec corpus that is small, navigable, and truthful:

- active changes are actionable
- canonical specs cover durable implemented behavior
- design notes are marked with lifecycle status
- historical notes remain available but no longer steer execution by accident
- future agents can tell what to do without reconstructing chat history

## Current State

As of 2026-04-24, active changes are:

- `swap-sqlite-driver` — partially complete; dependency swap landed, query extraction and crash verification remain.
- `reference-implementation-program` — effectively complete except one deferred storage-abstraction item; still contains many linked design notes.
- `add-polyfill-connector-system` — broad active product/runtime program with mixed shipped work, connector backlog, and open questions.

Recently archived changes include lexical retrieval, semantic retrieval, logging, boundary hardening, rename, run interaction control, query memory pressure, and governance cleanup.

## Workstreams

### Workstream A: Active Change Inventory

Audit every active change and decide one of:

- keep active as-is
- update tasks and continue
- split into smaller changes
- archive
- retire/supersede

Output should be a committed inventory note plus direct edits to tasks/proposals where status is stale.

### Workstream B: Design-Note Triage

Audit design notes under:

- `openspec/changes/reference-implementation-program/design-notes/`
- `openspec/changes/add-polyfill-connector-system/design-notes/`
- root `design-notes/`

For each note or note cluster, choose:

- promote into an OpenSpec change
- sprint-needed
- defer
- superseded
- connector-background
- historical/archive only

Do not mechanically rewrite every note if that creates noise. Prefer a triage index first, then normalize high-value notes.

### Workstream C: Canonical Spec Gap Audit

Compare shipped durable behavior against canonical specs. Look for behavior that is:

- public or reference contract
- architecture boundary
- security/auth posture
- storage/model lifecycle
- operator/control-plane behavior
- retrieval capability behavior

If a gap exists, either add a spec delta in this change when it is pure governance/corpus cleanup, or create a new OpenSpec change when the missing spec would alter or clarify a non-governance capability substantially.

### Workstream D: Polyfill Program Decomposition

`add-polyfill-connector-system` should stop being a junk drawer. Extract:

- connector-specific backlog into smaller follow-up changes or connector-background notes
- runtime/control-plane questions into focused design notes or OpenSpec changes
- stale historical items into archived notes
- already-implemented tasks into checked status or archival plan

### Workstream E: Reference Program Closeout

Make `reference-implementation-program` archivable:

- preserve or migrate links currently pointing into its `design-notes/`
- keep high-value notes discoverable after archive
- move deferred broad storage abstraction to root design-note intake
- mark the program complete or explicitly superseded

### Workstream F: Swap SQLite Driver Decision

Decide whether `swap-sqlite-driver` remains a live implementation change:

- If query extraction is still desired, keep it active and assign implementation.
- If the crash was already resolved by dependency swap and memory-pressure fixes, narrow the change and archive completed parts.
- If query extraction is a separate inspectability feature, split it into a new change.

## Quality Criteria

Good OpenSpec content:

- states purpose clearly
- uses normative requirements only in specs
- includes scenarios for every requirement
- avoids task lists in spec files
- distinguishes proposal/design/tasks/spec delta roles
- records non-goals and follow-ups without turning them into stale unchecked tasks
- links to root PDPP specs for protocol normativity

Good design-note content:

- has status, owner, dates, and related artifacts
- addresses one question or decision cluster
- has a promotion trigger
- has a decision log
- does not claim authority over specs/code/tests

## Worker Strategy

This change is safe to parallelize because most workstreams are read-heavy and can write disjoint files:

- Worker 1: active change inventory and `swap-sqlite-driver` recommendation.
- Worker 2: `reference-implementation-program` design-note/link closeout.
- Worker 3: `add-polyfill-connector-system` design-note and backlog decomposition.
- Worker 4: canonical spec gap audit.

Each worker should write a short report file under `openspec/changes/clean-up-openspec-corpus/reports/` and make only clearly scoped edits. The owner should integrate and decide promotions/archive actions.

## Non-Goals

- No runtime behavior changes.
- No mass deletion of historical notes without an index or replacement.
- No drive-by rewrite of root PDPP protocol specs.
- No broad connector implementation work.
- No formatting-only churn across hundreds of notes unless it materially improves status/authority clarity.

## Acceptance Checks

- `openspec validate clean-up-openspec-corpus --strict`
- `openspec validate --all --strict`
- `openspec list` contains only active changes with clear next action.
- Every remaining active change has accurate tasks and status.
- Every high-value design-note cluster has a triage status.
- Missing canonical spec coverage is either filled or captured as a follow-up OpenSpec change.
