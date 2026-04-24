# Baseline — 2026-04-24

Snapshot taken before any cleanup edits. Read-only observations only. Commands run from the repository root.

## `openspec list`

```
Changes:
  define-reference-surface-topology       0/22 tasks    8m ago
  make-semantic-retrieval-operational     0/30 tasks    17m ago
  clean-up-openspec-corpus                0/28 tasks    52m ago
  swap-sqlite-driver                      9/39 tasks    1h ago
  reference-implementation-program        26/27 tasks   1h ago
  add-polyfill-connector-system           45/81 tasks   17h ago
```

Six active changes, three of them (`define-reference-surface-topology`, `make-semantic-retrieval-operational`, `clean-up-openspec-corpus`) are brand new and have zero tasks checked. Two (`reference-implementation-program`, `add-polyfill-connector-system`) are the large programs this cleanup is explicitly trying to triage. `swap-sqlite-driver` is mid-flight.

## `openspec list --specs`

```
Specs:
  lexical-retrieval                         requirements 10
  reference-implementation-architecture     requirements 38
  reference-implementation-governance       requirements 8
  reference-implementation-identity         requirements 1
  reference-native-provider-boundary        requirements 2
  reference-web-bridge-contract             requirements 2
  semantic-retrieval                        requirements 12
```

Seven canonical specs, 73 requirements total. `reference-implementation-architecture` carries most of the weight (38), including logging, `_ref` control-plane boundaries, lexical retrieval, and semantic retrieval realization rules.

## `openspec validate --all --strict`

Passes clean:

```
- Validating...
✓ change/add-polyfill-connector-system
✓ change/clean-up-openspec-corpus
✓ change/define-reference-surface-topology
✓ spec/lexical-retrieval
✓ change/make-semantic-retrieval-operational
✓ spec/reference-implementation-architecture
✓ spec/reference-implementation-governance
✓ spec/reference-implementation-identity
✓ change/reference-implementation-program
✓ spec/reference-native-provider-boundary
✓ spec/reference-web-bridge-contract
✓ spec/semantic-retrieval
✓ change/swap-sqlite-driver
Totals: 13 passed, 0 failed (13 items)
```

Baseline strict validation passes. Any regression during cleanup is therefore a cleanup-introduced regression, not pre-existing drift.

## Active unchecked tasks per change

Counted with `grep -c "^- \[ \]" openspec/changes/<change>/tasks.md`.

| Change | Unchecked `- [ ]` tasks | Comment |
| --- | --- | --- |
| `swap-sqlite-driver` | 30 | 9 done out of 39. Dep swap already landed; query extraction + crash re-verification remain. |
| `reference-implementation-program` | 1 | Only the deferred storage-abstraction follow-up is still unchecked. Effectively finished. |
| `add-polyfill-connector-system` | 36 | Mixes shipped scope, Layer 2 coverage backlog, infra follow-ups, fixture pipeline, and ~15 unresolved open questions. |
| `define-reference-surface-topology` | 22 | Fresh proposal, zero tasks checked. Needs a worker-ready posture before starting. |
| `make-semantic-retrieval-operational` | 30 | Fresh proposal. Depends on diagnostics + local embedding backend work not yet started. |
| `clean-up-openspec-corpus` | 28 | This change. |

Total unchecked across active changes: **147**. That is the volume being reasoned about in the inventory and gap audits.

## Design-note inventory

All design-note locations found under repository root, excluding worktrees.

| Directory | Count | Notes |
| --- | --- | --- |
| `openspec/changes/reference-implementation-program/design-notes/` | 43 | Control-plane audits, dashboard hero prior art + synthesis, record-query contract dossier, lexical/semantic retrieval options, composition/owner-auth/capability-discovery investigations. |
| `openspec/changes/add-polyfill-connector-system/design-notes/` | 50 | Per-connector notes, Layer 2 coverage audits, ~15 `-open-question*.md` files, wide-build/overnight summaries, tooling playwright-hygiene + slackdump notes. |
| `design-notes/` (repo root) | 3 (2 notes + README) | `broad-storage-abstraction-2026-04-24.md`, `source-instances-and-multi-account-configurations-2026-04-24.md`, plus `README.md` defining the canonical header and statuses. |
| **Total note files** | **93** | Excludes the root `README.md` and design-note files inside `.claude/worktrees/`. |

Observations:

- Only the root `design-notes/` entries follow the canonical header in `design-notes/README.md` (`Status: … / Owner: … / Created: YYYY-MM-DD / Updated: YYYY-MM-DD / Related: …`). The two RIP/APCS directories universally use a `**Status:** open` / `**Raised:** YYYY-MM-DD` pattern inherited from before the README was introduced.
- The RIP design-notes directory is now effectively a historical research archive for phases already shipped (dashboard hero, control-plane implementation plan, record-query contract, composed-origin plan). Very little of it is active intake.
- The APCS design-notes directory mixes genuine open questions (15 `-open-question*.md` files) with per-connector background (`amazon.md`, `chase.md`, `gmail.md`, `usaa.md`, `slack*`, `ynab.md`, `claude-code-codex-connectors.md`) and overnight/wide-build historical summaries.

## Baseline git status

From the main checkout at the time of cleanup start:

- Branch `main`, HEAD `f871ea2 openspec: define reference surface topology`.
- Uncommitted working-tree edits exist in `apps/web/src/app/dashboard/*` and `apps/web/src/app/openspec/*` plus untracked `apps/web/src/components/docs/`, `apps/web/src/components/planning/`. They are unrelated to OpenSpec corpus cleanup and are left alone.
- `.claude/scheduled_tasks.json` / `.lock` drift is likewise unrelated and left alone.
