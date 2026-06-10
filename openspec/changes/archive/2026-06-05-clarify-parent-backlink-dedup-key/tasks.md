# Tasks — clarify parent back-link dedup key

## 1. Spec delta

- [x] 1.1 MODIFY the "Operator console SHALL render manifest-declared parent links on the child record page" requirement so the dedup constraint keys on `(parent stream, parent-key field)`, not parent stream alone.
- [x] 1.2 Add a scenario: two child-declared `has_one` to the same parent stream via different fields both render to different parent records.
- [x] 1.3 Add a scenario: the same edge discovered via both manifest sources collapses to one link (metadata-derived preferred) — affirming unchanged behavior.

## 2. Reference implementation (already shipped at HEAD)

- [x] 2.1 `mergeParentBackLinks` + `parentBackLinkDedupKey` pure helpers in `apps/console/src/app/dashboard/records/lib/relationships.ts` keyed on `(parentStream, childParentKeyField)`. (commit `11b03402`)
- [x] 2.2 Record detail page `[recordKey]/page.tsx` uses the helper and the `(stream, field)` React list key. (commit `11b03402`)
- [x] 2.3 Unit tests in `relationships.test.ts` for both-render and cross-source-collapse, mutation-verified. (commit `11b03402`)

## Acceptance checks

- `openspec validate clarify-parent-backlink-dedup-key --strict` passes.
- `cd apps/console && node --test --experimental-strip-types src/app/dashboard/records/lib/relationships.test.ts` → all pass (the two-distinct-fields case fails under a parent-stream-only dedup mutation and passes after the fix).
- `cd apps/console && pnpm run types:check` is clean.
- `git diff --check` is clean.

## Residual Risks

- Owner-only live render check of a deployed YNAB transfer transaction detail page showing both account links — recorded in `proposal.md` per `AGENTS.md`, satisfied at the contract level by the mutation-verified unit tests.
