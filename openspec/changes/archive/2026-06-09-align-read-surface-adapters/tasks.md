## 1. Architecture Audit

- [x] 1.1 Audit REST route handlers, hosted package helpers, MCP tools, and CLI
  read commands for duplicated read semantics.
- [x] 1.2 Record the audit in a short workstream note that separates canonical
  semantics from allowed adapter presentation.
- [x] 1.3 Identify the canonical operation or shared transform that owns each
  behavior in the parity matrix: schema scoping, source disambiguation,
  projection, fan-in limits, pagination, counts, warnings, and typed errors.
- [x] 1.4 Flag any behavior currently implemented only in MCP that should move
  into REST operations or shared transforms.

## 2. Canonical Read Substrate

- [x] 2.1 Add or expose `connection_id` source scoping for canonical REST schema
  discovery so `schema(stream, connection_id)` is not MCP-only.
- [x] 2.2 Move shared schema ambiguity and full-detail bounding behavior into a
  canonical schema helper or operation-level transform.
- [x] 2.3 Ensure package-level broad-grant reads use shared source-resolution and
  ambiguity helpers instead of adapter-local fan-out probes.
- [x] 2.4 Ensure fan-in search global-limit and source-mix behavior is owned by a
  shared search/read helper consumed by hosted MCP and REST package paths.
- [x] 2.5 Ensure projection behavior for record list and record detail is owned by
  canonical record operations rather than MCP/CLI result shaping.

## 3. MCP Adapter Alignment

- [x] 3.1 Remove or isolate any MCP adapter code that implements canonical read
  semantics after the shared substrate exists.
- [x] 3.2 Keep MCP-only presentation wrappers explicit: tool input schemas,
  read-only annotations, `content[]` summaries, and document-shaped `fetch`.
- [x] 3.3 Ensure MCP `fetch` renders from canonical record/search data and does
  not introduce a second record-detail semantic contract.
- [x] 3.4 Update MCP tests so canonical behavior regressions are asserted against
  shared results, while MCP-only presentation is tested separately.

## 4. CLI Adapter Parity

- [x] 4.1 Add CLI schema flags for compact view, stream scoping, and
  `connection_id` source scoping.
- [x] 4.2 Update CLI help so recommended grant-scoped read examples use
  `--connection-id` and do not present `--connector-instance-id` as ordinary
  setup.
- [x] 4.3 Keep any deprecated selector alias as compatibility-only behavior where
  REST still accepts it.
- [x] 4.4 Add CLI unit tests for schema scoping, query serialization, projection,
  search mode, aggregate arguments, and owner-token exclusion.

## 5. Cross-Surface Verification

- [x] 5.1 Extend `scripts/read-surface-smoke.mjs` so REST, MCP, and CLI each
  verify compact schema, `schema(stream, connection_id)`, strict projection,
  search fan-in limit, source identity, pagination/count handles, and typed
  ambiguity.
- [x] 5.2 Keep transport-specific smoke assertions isolated: MCP `tools/list` and
  `content[]`, CLI credential-cache behavior, and REST `links`/warning
  envelopes.
- [x] 5.3 Add regression coverage proving a shared behavior failure in only one
  adapter fails the parity matrix.
- [x] 5.4 Update `docs/agent-skills/pdpp-data-access/` so raw HTTP, CLI, and MCP
  are described as adapters over the same scoped read surface, with MCP called
  out only for host ergonomics.

## 6. Acceptance Checks

- [x] 6.1 Run focused reference-implementation read/search/schema tests.
- [x] 6.2 Run focused MCP server tests.
- [x] 6.3 Run focused CLI tests.
- [x] 6.4 Run the read-surface smoke with REST, MCP, and CLI enabled when a
  suitable grant token is available.
- [x] 6.5 Run `openspec validate align-read-surface-adapters --strict`.
- [x] 6.6 Run `openspec validate --all --strict`.
- [x] 6.7 Run `git diff --check`.
