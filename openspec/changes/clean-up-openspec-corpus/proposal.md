## Why

The first OpenSpec cleanup pass established governance rules and archived obvious completed changes, but the corpus still needs an intentional full pass:

- `openspec list` still contains broad program changes rather than only sharply actionable changes.
- `add-polyfill-connector-system` mixes shipped work, connector backlog, design questions, implementation notes, and stale tasks.
- `reference-implementation-program` is effectively complete but still owns many active `design-notes/` links.
- `swap-sqlite-driver` is partially complete and needs a decision on whether query extraction remains in scope.
- Supplemental design notes are valuable, but many lack the status header and promotion/defer/supersede lifecycle now required by governance.
- Canonical specs may still be missing durable requirements for behavior that now exists in code.

This change turns that broad cleanup into an explicit, delegable OpenSpec program so it does not live only in chat memory.

## What Changes

- Audit the full OpenSpec corpus: active changes, archived changes, canonical specs, and design notes.
- Produce a statused inventory that classifies every active change and design-note cluster.
- Split, retire, archive, or promote active work so `openspec list` contains only genuinely actionable changes.
- Normalize design notes under the new intake lifecycle.
- Identify and fill missing canonical specs where implemented durable behavior lacks OpenSpec coverage.
- Preserve useful historical notes without letting them remain execution truth.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: backfills the shipped `GET /_ref/dataset/summary` reference-only read route into the bounded `_ref` surface.
- `reference-implementation-governance`: adds corpus-hygiene requirements for periodic audit, active-change inventory, design-note triage, and missing-spec backfill.

## Impact

- `openspec/changes/*`
- `openspec/specs/*`
- `openspec/changes/*/design-notes/*`
- `design-notes/*`
- `AGENTS.md` or `openspec/README.md` only if the audit discovers missing process rules

No runtime behavior changes are intended. Any runtime/code change discovered during the audit must be split into its own OpenSpec change or ordinary code task before implementation.
