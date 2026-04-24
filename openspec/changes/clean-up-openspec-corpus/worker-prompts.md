# Worker Prompts

Use these prompts to spin off parallel workers. Each worker should work in its own worktree or branch, avoid runtime behavior changes, and write a report under `openspec/changes/clean-up-openspec-corpus/reports/`.

## Worker 1: Active Change Inventory And Swap SQLite Decision

Audit the active OpenSpec changes, with special focus on `swap-sqlite-driver`.

Read:

- `openspec/README.md`
- `design-notes/README.md`
- `openspec/changes/clean-up-openspec-corpus/{proposal.md,design.md,tasks.md}`
- `openspec/changes/swap-sqlite-driver/*`
- `openspec/changes/reference-implementation-program/*`
- `openspec/changes/add-polyfill-connector-system/{proposal.md,design.md,tasks.md}`

Tasks:

- Produce `reports/active-change-inventory.md`.
- For each active change, recommend keep, narrow, split, archive, or supersede.
- For `swap-sqlite-driver`, inspect current code enough to decide what is already done and what remains real.
- Do not implement query extraction or runtime code changes.
- If tasks are obviously stale, propose exact task edits but avoid large rewrites unless low-risk.

Acceptance:

- `openspec validate clean-up-openspec-corpus --strict` passes after your edits.
- Report includes concrete next actions and owner decisions needed.

## Worker 2: Reference Program Design-Note Closeout

Audit `openspec/changes/reference-implementation-program/design-notes/` and determine how to make `reference-implementation-program` archivable.

Tasks:

- Produce `reports/reference-program-note-triage.md`.
- Identify notes that are still linked from code/docs.
- Identify notes that should move to root `design-notes/`, stay in archived context, become follow-up OpenSpec changes, or be marked historical.
- Propose a safe migration plan that avoids broken links.
- Normalize headers only for the highest-value still-active notes.

Acceptance:

- No runtime code changes.
- No mass deletion.
- Report distinguishes mechanical link migration from owner design decisions.

## Worker 3: Polyfill Program Decomposition

Audit `openspec/changes/add-polyfill-connector-system/`, especially `tasks.md` and `design-notes/`.

Tasks:

- Produce `reports/polyfill-program-decomposition.md`.
- Classify remaining tasks as shipped, stale, backlog, open question, sprint-needed, or ready-to-split.
- Recommend smaller follow-up OpenSpec changes for major clusters.
- Identify design notes that should become root intake notes or connector-background notes.
- Do not implement connectors or runtime changes.

Acceptance:

- Recommendations are grouped by coherent product/runtime decision, not by filename dump.
- Report includes the minimum safe edit plan for reducing `add-polyfill-connector-system` scope.

## Worker 4: Canonical Spec Gap Audit

Audit canonical OpenSpec specs against shipped durable behavior.

Read:

- `openspec/specs/*/spec.md`
- `reference-implementation/docs/generated/reference-routes.md`
- public docs under `apps/web/content/docs/`
- high-signal tests for retrieval, control plane, logging, run interactions, owner auth, and records query behavior

Tasks:

- Produce `reports/spec-gap-audit.md`.
- Identify implemented durable behavior missing canonical OpenSpec coverage.
- Classify gaps as governance cleanup, new capability spec needed, root PDPP spec issue, or no action.
- Do not modify runtime code.

Acceptance:

- Report gives specific file/requirement recommendations.
- Any proposed spec additions are narrow and do not duplicate root PDPP protocol semantics.
