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
- No AST-based static analysis. Cheap regexes over the two static-import shapes (`from '<x>'` and bare `import '<x>'`) plus a comment-stripped `process.env` scan are sufficient for the static-import drift class. Dynamic `require()` / `await import()` and string-concatenated specifiers are out of scope.
- No widening of the forbidden list beyond what the three existing tests already enforce, except to add the comment-stripping rule and to fold them into one place.
- No moving of the per-operation route / builder-demotion tests. Those are not the rule under generalization.

## Decisions

### 1. Test-only gate, not a production guard

The forbidden-import rule is enforced through a Node test file. There is no production code path that imports the helper, no registry of operations, and no exported symbol that might tempt later code to depend on it. If the gate fails, it fails the test suite; if a developer wants to know the rule, they read the helper.

### 2. Discovery is filesystem-driven

The shared helper enumerates operation modules by reading `reference-implementation/operations/` and selecting subdirectories that contain `index.ts`. This matches the existing convention (`rs-streams-list/index.ts`, `rs-streams-detail/index.ts`, `rs-schema-get/index.ts`) and matches `package.json` exports. A future operation that follows the convention is automatically gated; one that does not (e.g., a folder without `index.ts`) is intentionally skipped — there is no operation to gate.

### 3. Forbidden-import list consolidates the three existing tests and closes the env-indirection gap

The shared list starts from what the three existing tests already assert:

- `fastify`, `express`, `next/`
- `better-sqlite3`, `pg`
- `./db`, `../db`, `../lib/db`, `../server/db`, `../server/records`, `../server/auth`, `../server/index`
- `apps/web`, `_demo/`

Plus the `process.env` rule (applied after stripping comments).

It also adds the Node `process` module under both specifier shapes:

- `node:process`, `process`

This closes an indirection gap that the `process.env` text-scan alone cannot cover: a module could otherwise bypass the env-access rule with `import { env } from "node:process"; const x = env.FOO;` or `import process from "process"; process.env.FOO` without the source ever spelling `process.env`. The spec/design always intended the gate to ban process-environment dependencies; the matcher must therefore close the indirection path, not merely the literal `process.env` shape.

Dynamic imports of the Node `process` module (`await import("node:process")`) remain an intentional out-of-scope trade-off, consistent with how the gate handles every other forbidden specifier. The rule is precise: static process-environment dependencies fail; dynamic ones are not claimed.

### 4. Regex match against both static-import shapes, not AST

The check uses two cheap per-needle regexes against the raw source:

- `\bfrom\s*['"]<needle>` — covers `import x from`, `import type { X } from`, `import * as x from`, `import { x } from`, `export { x } from`, and `export * from`.
- `\bimport\s+['"]<needle>` — covers bare side-effect imports such as `import "fastify";` and `import "../server/db";`.

Together they catch every standard ES static-import shape that resolves a module specifier at parse time. An earlier draft of this gate used a `from '<x>'` substring check; that draft missed bare side-effect imports, which would have been a silent gate bypass. The spec/design require failure on any forbidden static import, so the matcher must cover both shapes.

The regexes require whitespace or a quote immediately after `import` / `from`, so dynamic `import("…")` is intentionally not matched here — dynamic imports remain an out-of-scope trade-off (a separate review concern that a later change may widen). AST-level scanning would add a TypeScript parser dependency for marginal coverage gain on a drift class that has not surfaced.

A unit-style falsifiability test (`reference-implementation/test/operation-boundary-helper.test.js`) pins the matcher against all seven static-import shapes (bare, default, namespace, named, type-only, named re-export, star re-export) plus the dynamic-import exemption, the comment-stripping rule, and the Node-process indirection cases (`import { env } from "node:process"`, `import process from "node:process"`, `import { env } from "process"`, and the bare-specifier variants). A future weakening of the matcher fails that test rather than silently turning the gate green.

### 5. Comments are stripped before the `process.env` text scan, not before the import check

Documentation in operation module headers names the rule (e.g., "SHALL NOT import Fastify, Next, SQLite, Postgres, ..."). The import-regex check runs against the raw source because a forbidden import only appears in literal `import …` / `from …` specifier shape, which is unlikely to occur in prose; the falsifiability test pins this assumption. The literal `process.env` text scan runs against comment-stripped source because operation-module headers explicitly mention `process.env` as part of stating the rule.

Process-environment access is enforced by two mechanisms working together: the literal `process.env` text scan catches the direct form, and the Node-process import ban catches the indirection form. Either path failing fires the gate; neither path alone is the rule.

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
