## 1. Contract and state boundary

- [x] 1.1 Add the architecture requirement delta for presentation screen lifecycle and restore-before-resume.
- [x] 1.2 Persist a captured baseline/restore obligation keyed to the managed presentation surface and expose startup recovery candidates.

## 2. Presentation lifecycle implementation

- [x] 2.1 Add capture-once and epoch-serialized screen apply/restore behavior to the n.eko companion.
- [x] 2.2 Establish a reconnect-stable controlling attachment at SSE attach and reject observer viewport mutations.
- [x] 2.3 Make interaction response, cancellation, timeout, stream invalidation, and startup reconciliation restore or safely retire before reuse/resume.
- [x] 2.4 Retain presentation terminalization identity past bearer expiry and route expiry or supersession through the same terminal barrier.

## 3. Verification

- [x] 3.1 Add deterministic adapter and route tests for capture-once, ordered epoch mutation, stale-epoch discard, and observer resize rejection.
- [x] 3.2 Add controller/route tests proving restore-before-resume, restore-failure retirement/terminal behavior, and every terminal/recovery path.
- [x] 3.3 Add injected-clock regressions for late response, cancellation, run cancellation, timeout, expiry, and restore failure after bearer expiry.
- [x] 3.4 Run focused streaming/controller suites, repository checks required by touched packages, and strict OpenSpec validation.

## Acceptance checks

- [x] `node --test --test-force-exit test/run-interaction-stream-neko-adapter.test.js test/run-interaction-stream-routes.test.js`
- [x] `node --test --test-force-exit test/run-interaction-control.test.js test/controller-browser-surface-leases.test.js test/controller-midwait-browser-surface-loss.test.js`
- [x] `pnpm exec tsc --noEmit --pretty false`
- [x] `openspec validate add-presentation-screen-lifecycle-restore-barrier --strict`
- [x] `openspec validate --all --strict`
