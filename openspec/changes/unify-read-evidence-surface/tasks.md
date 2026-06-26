# Tasks

## 0. Design Gate
- [x] 0.1 Capture findings and assessment in permanent `docs/research/` corpus.
- [x] 0.2 Create OpenSpec proposal, design, tasks, and spec deltas.
- [x] 0.3 Run adversarial design review lanes for architecture, parity, and client UX.
- [x] 0.4 Resolve design HOLDs before implementation.
- [x] 0.5 Run `openspec validate unify-read-evidence-surface --strict`.

## 1. Prerequisite Baseline
- [x] 1.1 Land or import `add-mcp-content-ladder` into the active checkout before MCP migration work.
- [x] 1.2 Verify `read_record_field`, field-window resource handles, and MCP content ladders in code tests.
- [x] 1.3 Update this change if the prerequisite implementation differs from deployed assumptions.

Acceptance note: `packages/mcp-server` tests, `add-mcp-content-ladder`, and `unify-read-evidence-surface` OpenSpec validation passed after import. `reference-implementation` field-window route/substrate tests passed on SQLite; the Postgres substrate case skipped locally because `PDPP_TEST_POSTGRES_URL` is unset.

## 2. Shared Evidence Primitives
- [x] 2.1 Inventory existing MCP, CLI, Explore, and RS presentation helpers and classify what moves into shared logic.
- [x] 2.2 Implement shared evidence-card, continuation, truncation, binary metadata, and declared-role presentation primitives.
- [x] 2.3 Add tests for no-dead-end truncation, binary metadata-only behavior, manifest-authored presentation, and stable identity.
- [x] 2.4 Prove no connector-specific or field-name guessing remains in shared evidence presentation.

## 3. CLI Parity
- [x] 3.1 Add `pdpp read field-window` using the RS field-window endpoint.
- [x] 3.2 Add tests for offset, match-centered, bounds, invalid selector, out-of-grant, and malformed cursor behavior.
- [x] 3.3 Add CLI evidence/card output only if backed by shared primitives.

## 4. MCP Migration
- [x] 4.1 Migrate MCP search/fetch/query content ladder rendering to shared primitives.
- [x] 4.2 Keep visible `content[]` sufficient when `structuredContent` is hidden.
- [x] 4.3 Keep `structuredContent`, `resource_link`, and `read_record_field` continuation paths intact.
- [x] 4.4 Add regression tests for ChatGPT-style hidden structured content and resource-read fallback gaps.
- [x] 4.5 Add a content-only client simulation proving visible MCP `content[]` carries enough bounded evidence and continuation instructions without `structuredContent`.

## 5. REST Projection Decision
- [x] 5.1 Decide whether an opt-in REST evidence projection is needed.
- [x] 5.2 If approved, add spec and implementation for the projection without changing canonical envelopes by default.

Decision: no REST evidence projection is approved in this tranche. Canonical REST envelopes remain the default and CLI/MCP consume the shared evidence layer without adding a second REST semantics path.

## 6. Client and Measurement Gate
- [x] 6.1 Build a client smoke matrix for ChatGPT, Claude app/Desktop, Claude Code, Codex, Gemini CLI, Hermes, opencode, Cursor/IDEs, CLI, and REST.
- [x] 6.2 Measure token payload size, call count, approval count, latency, and answer success on representative evidence tasks.
- [x] 6.3 Record proven vs inferred behavior for each named client in permanent corpus.
- [x] 6.4 Update OpenSpec artifacts when measurement changes the design.

Measurement note: local package tests and the client matrix did not change the design; external hosted-client smokes remain residual live verification, not a reason to fork the semantics.

## 7. Closeout
- [x] 7.1 Run relevant package tests, TypeScript checks, and `git diff --check`.
- [x] 7.2 Run `pnpm workstreams:status -- --no-fail`.
- [x] 7.3 Run `clawmeter status --check` or record clawmeter status.
- [x] 7.4 Prepare final LAND/HOLD report with residual risks.

Closeout note: `packages/read-evidence`, `packages/cli`, `packages/mcp-server`,
and selected `reference-implementation` field-window tests pass locally.
`reference-implementation` typecheck, both related OpenSpec changes,
`openspec validate --all --strict`, and `git diff --check` pass. The Postgres
substrate test remains skipped locally because `PDPP_TEST_POSTGRES_URL` is not
set. `pnpm workstreams:status -- --no-fail` reports existing unrelated dirty and
stale lanes. `clawmeter status --check` exits 1 without output; `clawmeter
status --json` reports Claude 7-day all utilization at 56% and projected 94.66%,
so no additional worker lanes were spawned for closeout.
