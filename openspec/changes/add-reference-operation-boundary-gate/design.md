## Context

`define-reference-operation-environments` and the three `mount-rs-*` changes established a pattern: AS/RS semantics live in canonical operation modules at `reference-implementation/operations/<name>/index.ts`, hosts (Fastify native, Next sandbox) wire concrete dependencies, and the operation module itself stays free of HTTP framework, sandbox UI, concrete database driver, and process-environment coupling.

Each existing operation has a hand-written boundary test that re-states the forbidden-import list:

- `reference-implementation/test/rs-streams-list-boundary.test.js`
- `reference-implementation/test/rs-streams-detail-boundary.test.js`
- `reference-implementation/test/rs-schema-get-boundary.test.js`

Three problems:

1. **Drift surface.** Three copies of the forbidden-import list mean a future operation added without a paired boundary test bypasses the gate entirely.
2. **Rule duplication.** Adding `'pg-native'` or another driver to the rule today requires a multi-file edit.
3. **No discovery.** Nothing at the test layer enforces "every operation under `operations/*/index.ts` is gated." The gate is opt-in per operation.

This change introduces a discovery-based gate that closes those gaps without changing production behavior.

## Goals / Non-Goals

Goals:

- Discover every operation module at `reference-implementation/operations/*/index.ts` and assert each one obeys the forbidden-import + no-`process.env` rule.
- Centralize the rule in one helper so the list of forbidden imports is the single source of truth.
- Keep route- and builder-demotion checks (sandbox `route.ts` not importing the old `buildLive*` symbols, `_demo/builders.ts` no longer exporting them) where they are. Those are operation-specific evidence, not a general rule.
- Fail loudly when a future operation imports concrete host/storage modules — even if the author forgot to add a per-operation test file.

Non-goals:

- No production abstraction. No new `OperationRegistry`, `ImportGuard`, or build-time linter. This is a test-only conformance gate.
- No AST-based static analysis. A grep-style scan over `from "<module>"` and `process.env` is sufficient for the static-import drift class. Dynamic `require()` / `await import()` and string concatenation are out of scope (the existing per-operation tests already document this trade-off).
- No widening of the forbidden list beyond what the three existing tests already enforce, except to add the comment-stripping rule and to fold them into one place.
- No moving of the per-operation route / builder-demotion tests. Those are not the rule under generalization.

## Decisions

### 1. Test-only gate, not a production guard

The forbidden-import rule is enforced through a Node test file. There is no production code path that imports the helper, no registry of operations, and no exported symbol that might tempt later code to depend on it. If the gate fails, it fails the test suite; if a developer wants to know the rule, they read the helper.

### 2. Discovery is filesystem-driven

The shared helper enumerates operation modules by reading `reference-implementation/operations/` and selecting subdirectories that contain `index.ts`. This matches the existing convention (`rs-streams-list/index.ts`, `rs-streams-detail/index.ts`, `rs-schema-get/index.ts`) and matches `package.json` exports. A future operation that follows the convention is automatically gated; one that does not (e.g., a folder without `index.ts`) is intentionally skipped — there is no operation to gate.

### 3. Forbidden-import list is the union of the three existing tests

The shared list consolidates what the three existing tests already assert:

- `fastify`, `express`, `next/`
- `better-sqlite3`, `pg`
- `./db`, `../db`, `../lib/db`, `../server/db`, `../server/records`, `../server/auth`, `../server/index`
- `apps/web`, `_demo/`

Plus the `process.env` rule (after stripping comments). No new entries; this is consolidation.

### 4. Grep-style match, not AST

The check looks for the literal substrings `from '<needle>` and `from "<needle>` in the source. Same approach the three existing tests use today; same trade-off — it cannot catch dynamically resolved imports, but it does catch the static-import drift class this gate is meant to prevent. AST-level scanning would add a TypeScript parser dependency for marginal coverage gain on a problem that has not surfaced.

### 5. Comments are stripped before the `process.env` check, not before the import check

Documentation in operation module headers names the rule (e.g., "SHALL NOT import Fastify, Next, SQLite, Postgres, ..."). The import-substring check runs against the raw source because a forbidden import only appears in `from '<x>'` form, which is not a phrase used in prose. The `process.env` check runs against comment-stripped source because operation-module headers explicitly mention `process.env` as part of stating the rule.

This matches the existing per-operation tests verbatim.

### 6. Existing per-operation tests are reduced, not deleted

Each existing per-operation boundary test keeps its sandbox-route and `_demo/builders.ts` demotion assertions (those are operation-specific anti-regression checks). The "operation has no host or storage concretes" assertion is migrated to consume the shared helper. Net result: the rule is asserted twice for existing operations (once in the generalized gate, once in the per-operation test that now delegates to the helper), and exactly once for any new operation that does not yet have a per-operation test.

### 7. Coverage retained, not weakened

What the per-route tests already cover continues to be covered:

- Operation modules cannot import host/storage/process concretes.
- Sandbox routes for the existing three operations cannot import the legacy `buildLive*` builders.
- `_demo/builders.ts` cannot re-introduce those builders.

What is added:

- Future operations are gated by default.
- The forbidden list moves once, not three times.

## Risks / Trade-offs

- **False negatives on dynamic imports.** Same trade-off as the existing tests; not new. Documented in the helper.
- **False positives from prose.** Mitigated by the same comment-stripping strategy the existing tests use for `process.env`. Forbidden-import strings only match the `from '<x>'` shape, which is unlikely to appear in prose.
- **Discovery bypass via unconventional layouts.** A future operation whose entry point is not `<dir>/index.ts` would not be discovered. Acceptable: the convention is established by `package.json` exports and three prior changes; a future operation that breaks the convention is its own review issue.
- **Helper coupling.** The helper exists only for tests; it is not exported from `reference-implementation/package.json`. A test importing it via relative path does not turn it into a production surface.

## Acceptance Checks

- New test file under `reference-implementation/test/` discovers all `operations/*/index.ts` and asserts the boundary rule for each one.
- Removing `index.ts` from the rule check (e.g., in a deliberately broken local edit) makes that operation's test fail.
- Adding a forbidden import (e.g., `from 'fastify'`) to any current operation module makes the new test fail.
- The three existing per-operation boundary tests still pass, with the operation-module assertion now delegated to the shared helper.
- `pnpm --filter pdpp-reference-implementation typecheck` passes.
- `pnpm --filter pdpp-reference-implementation check` passes.
- `openspec validate add-reference-operation-boundary-gate --strict` passes.
- `openspec validate --all --strict` passes.
