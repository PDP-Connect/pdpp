# Tasks: detect-midwait-browser-surface-loss

## 1. OpenSpec artifacts

- [x] Write `proposal.md`
- [x] Write `design.md`
- [x] Write `tasks.md`
- [x] Write `specs/reference-run-assistance/spec.md` delta
- [x] Write `specs/reference-implementation-runtime/spec.md` delta
- [x] `openspec validate detect-midwait-browser-surface-loss --strict` passes

## 2. Implementation

- [x] Add `createMidWaitSurfaceLossDetector` to `browser-surface-readiness.ts`
- [x] Wire detector into `brokerInteraction` in `controller.ts` (race against owner-response promise)
- [x] Emit `run.browser_surface_lost` spine event on detector firing
- [x] Clear pending interaction entry before emitting so stale-response guard is active

## 3. Test

- [x] Add `reference-implementation/test/controller-midwait-browser-surface-loss.test.js`
  - [x] Surface passes preflight, dies during interaction wait -> `run.browser_surface_lost` emitted
  - [x] Interaction resolves `cancelled`, no re-prompt possible
  - [x] Surface-backed `otp` interaction is monitored and cancelled on surface loss
  - [x] Non-browser interactions are unaffected
  - [x] Surface that stays alive: no spurious loss event, owner response still works

## 4. Validation

- [x] `pnpm --dir reference-implementation test` (scoped to new + affected tests)
- [x] `pnpm --dir reference-implementation run typecheck`
- [x] `pnpm --dir reference-implementation run check`
- [x] `openspec validate detect-midwait-browser-surface-loss --strict`
- [x] `openspec validate --all --strict`
- [x] `git diff --check`

## Acceptance checks

1. New test suite green: surface-dies-during-wait -> `run.browser_surface_lost` emitted, interaction cancelled, no re-prompt.
2. Existing `controller-browser-surface-readiness.test.js` and `browser-surface-readiness.test.js` remain green.
3. TypeScript compiles clean.
4. Linter passes.
5. `openspec validate` passes for this change and `--all`.
