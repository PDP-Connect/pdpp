# w1-strroutes report

## Baseline tally

Command (from `reference-implementation/`):

```sh
PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@127.0.0.1:55432/postgres \
  node --test --test-force-exit \
  test/run-interaction-stream-routes.test.js \
  test/remote-surface-reference-boundary.test.js
```

Result: **red** — 4 tests, 2 passed, 2 failed.

- `test/run-interaction-stream-routes.test.js` could not load
  `better-sqlite3`, imported by `server/db.js` (`ERR_MODULE_NOT_FOUND`).
- `test/remote-surface-reference-boundary.test.js` expected the removed
  in-repo file `packages/remote-surface/README.md` (`ENOENT`). The current
  architecture instead exposes remote-surface as an external optional
  dependency through
  `runtime/browser-surface/remote-surface-optional.ts`.

Per the lane protocol, the red baseline stopped work before any production or
test changes.

## Decomposition map

Not produced: decomposition and implementation were not started because the
covering baseline was red.

## Cognitive-complexity mass

- Before: 236 excess (orchestrator-provided starting measurement).
- After: not measured; no production changes were made.

## Gates

- Covering baseline: **failed**.
- Typecheck: not run after the failed baseline.
- Post-refactor covering suite: not run; no refactor occurred.
- Post-refactor complexity lint: not run; no refactor occurred.
- Test expectations: unchanged.
- Production files: unchanged.
