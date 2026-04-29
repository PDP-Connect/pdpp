## 1. Shared Helper

- [x] 1.1 Add `reference-implementation/test/helpers/operation-boundary.js` exporting `forbiddenOperationImports`, `discoverOperationModules(repoRoot)`, `assertOperationBoundary(source, label)`, and `assertOperationBoundaryAtPath(absPath, label)`.
- [x] 1.2 Document the static-import / comment-stripping trade-off in the helper header so future readers see the same caveat the per-operation tests already document.

## 2. Generalized Gate

- [x] 2.1 Add `reference-implementation/test/operations-boundary.test.js` that discovers every `operations/<name>/index.ts` and asserts the boundary rule via the shared helper.
- [x] 2.2 Assert the discovery itself: the test SHALL fail if zero operations were discovered (catches a refactor that moves the directory and silently neuters the gate).

## 3. Migrate Per-Operation Tests

- [x] 3.1 Update `rs-streams-list-boundary.test.js` to consume the shared helper for the operation-module boundary assertion. Sandbox-route and `_demo/builders.ts` assertions retained.
- [x] 3.2 Update `rs-streams-detail-boundary.test.js` the same way.
- [x] 3.3 Update `rs-schema-get-boundary.test.js` the same way.

## 4. Spec Delta

- [x] 4.1 Add `## ADDED Requirements` under `reference-implementation-architecture` capturing the discovery-based gate, the forbidden-import set, the comment-stripped `process.env` rule, and the empty-discovery failure mode.

## 5. Validation

- [x] 5.1 Run the three existing per-operation boundary tests and the new generalized gate. 13/13 pass.
- [x] 5.2 Manually verify the gate fails by introducing `import type { FastifyInstance } from 'fastify';` in `operations/rs-streams-list/index.ts`, running the test (both `operations-boundary.test.js` and `rs-streams-list-boundary.test.js` failed with "operation module must not import \"fastify\""), then reverting. Confirmed clean revert via `git diff`.
- [x] 5.3 Run `pnpm --filter pdpp-reference-implementation typecheck`. (Pass.)
- [x] 5.4 Run `pnpm --filter pdpp-reference-implementation check`. (`Checked 20 files in 48ms. No fixes applied.` — operations dir is currently outside biome's include list; this is pre-existing and out of scope.)
- [x] 5.5 Run `openspec validate add-reference-operation-boundary-gate --strict`. (Valid.)
- [x] 5.6 Run `openspec validate --all --strict`. (53 passed / 0 failed.)
- [x] 5.7 Run `pnpm workstreams:status -- --no-fail` before owner review.

## 6. Owner-review follow-up: cover bare side-effect imports

- [x] 6.1 Tighten `assertOperationBoundary` to fail on bare side-effect imports (`import "fastify";`, `import "../server/db";`) in addition to `from`-style imports. Implementation uses two per-needle regexes (`\bfrom\s*['"]<x>` and `\bimport\s+['"]<x>`) so every standard ES static-import shape — bare, default, namespace, named, type-only, named re-export, star re-export — is caught.
- [x] 6.2 Add `reference-implementation/test/operation-boundary-helper.test.js` as a permanent falsifiability harness for the matcher (12 cases: seven import shapes, the dynamic-import exemption, comment-only mentions, and the `process.env` rule). A future weakening of the matcher fails this test rather than silently turning the gate green.
- [x] 6.3 Manually verify the new shape: introduced `import "fastify";` and `import "../server/db";` (bare) into `operations/rs-streams-list/index.ts`. Both `operations-boundary.test.js` and `rs-streams-list-boundary.test.js` failed with the named-needle assertion. Reverted; `git diff` clean.
- [x] 6.4 Update design and spec wording so the rule explicitly enumerates bare side-effect imports and the falsifiability harness.
- [x] 6.5 Re-run targeted tests (25/25), typecheck, check, `openspec validate add-reference-operation-boundary-gate --strict`, `openspec validate --all --strict`, and `pnpm workstreams:status -- --no-fail`.
