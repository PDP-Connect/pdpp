# Unified Read Evidence Surface Design

## Intent

The goal is a single, shared read/evidence model that makes owner-controlled personal data usable through agents and developer tools without inventing competing semantics per surface.

When an agent asks a question over connected data, it should receive enough bounded, provenance-clear evidence to decide what to inspect next. If visible output omits, truncates, summarizes, or references underlying content, there must be a working, grant-preserving recovery path.

This is not an MCP-only redesign. MCP is one renderer over the read/evidence model.

## Source Material

- `docs/research/mcp-client-read-surface-findings-2026-06-22.md`
- `docs/research/mcp-read-surface-slvp-assessment-2026-06-22.md`
- `openspec/changes/add-mcp-content-ladder/`
- `openspec/specs/mcp-adapter/spec.md`
- `openspec/specs/reference-implementation-architecture/spec.md`

Findings and assessments must remain separate. New research findings go to `docs/research/`, not `tmp/workstreams/`.

## Baseline And Dependency

This checkout may not yet contain the `add-mcp-content-ladder` implementation. The content-ladder concepts (`read_record_field`, field-window resource handles, and MCP `content_ladder`) are a prerequisite, not an assumed current baseline.

Implementation order:

1. Land or import `add-mcp-content-ladder` into the active checkout.
2. Verify the model-controlled field-window path and MCP content ladder.
3. Then migrate MCP and CLI onto shared read/evidence semantics.

Any wording in this change about "migrating" MCP content ladders means "migrate after the prerequisite exists in code."

## Concept Ownership

RS / REST owns:

- grant authorization;
- stream, record, field, and connection identity;
- canonical query semantics;
- pagination and cursor validation;
- field-window reads;
- projection, filter, sort, aggregate, and count semantics;
- provenance and request tracing.
- manifest-declared field capabilities and extension metadata, including `x_pdpp_type` and any approved display-role vocabulary.

Shared read/evidence layer owns:

- evidence-card shape;
- declared-role presentation slots;
- match context metadata;
- truncation status and continuation requirements;
- binary/blob metadata-only discipline;
- self-contained record handles and optional short aliases;
- adapter-neutral field-window continuation arguments.

The shared read/evidence layer must consume existing manifest-declared capability metadata. It must not mint a competing evidence-role vocabulary when a role/type/capability already has an approved manifest home.

Adapters own rendering only:

- MCP renders visible `content[]`, validated `structuredContent`, `resource_link` blocks, and `read_record_field` calls.
- MCP visible `content[]` is a concise model-visible summary and continuation guide, not a canonical machine envelope. The canonical machine payload remains validated `structuredContent` and RS envelopes, but visible `content[]` must still be enough for clients that hide structured fields.
- CLI renders JSON, JSONL, table/card output, and direct `field-window` commands.
- REST keeps canonical envelopes by default and may expose an opt-in evidence projection.
- Explore/console may render richer UI but must not define competing core semantics.

## Invariants

1. No dead ends: if visible output omits, truncates, summarizes, or references underlying content, it must expose a working continuation path.
2. Grant preservation: every continuation path must remain inside the original grant and source/stream/field scope.
3. Manifest-authored presentation: evidence cards may use declared roles/capabilities, not connector-specific or field-name guessing.
4. Bounded default: ordinary search/query/fetch previews must stay bounded and should not dump large private bodies into model context.
5. Tool fallback: model-controlled incremental reads must exist because resources and `structuredContent` are not uniformly available across clients.
6. Resource fallback: clients that support MCP resources should get resource links/templates for the same content.
7. Honest completeness: counts, cursors, search recall, and truncation states must not imply exhaustive meaning beyond their declared scope.
8. Binary discipline: large binary/base64/blob content is metadata-only by default with explicit export/resource paths. Existing blob reads use `GET /v1/blobs/:blob_id` and any new binary continuation must preserve that grant-scoped route rather than inventing a direct source-platform or local-filesystem path.
9. Stable windows: incremental field reads must have stable selectors/cursors for the record version visible to the client.
10. Cross-surface parity: MCP, CLI, and REST evidence projections must agree on identity, provenance, truncation, continuation, and role-derived presentation.
11. No competing manifest semantics: a new display or evidence concept that belongs in connector manifests must extend the approved manifest vocabulary, not live as an MCP-only or CLI-only semantic.

## Incidental Complexity Ledger

These are client or integration facts, not core semantics:

- ChatGPT may require user approval for file/resource materialization.
- Clients differ on `structuredContent`, `resource_link`, `resources/read`, and tool-list refresh.
- Some clients expose only visible `content[]`.
- Long opaque handles can hurt model-visible ergonomics.

Design rule: keep these at adapter boundaries. Do not pollute RS authorization/query semantics with ChatGPT-specific behavior.

## Implementation Slices

### Slice 0: Design and audit gate

Create this OpenSpec change, record canonical concepts, and run adversarial reviews before implementation. No code tranche may start if the design still allows MCP-only semantics, field-name guessing, or dead-end truncation.

### Slice 1: Prerequisite baseline

Land or import `add-mcp-content-ladder` into the active checkout and verify `read_record_field`, field-window resource handles, and MCP content ladders. If the prerequisite is not present, this slice blocks the rest of the change.

### Slice 2: Shared evidence primitives

Extract a shared module for evidence cards, continuation descriptors, binary metadata descriptors, and truncation descriptors. Start with MCP and CLI inputs/outputs, but keep RS-compatible shapes.

### Slice 3: CLI parity

Add `pdpp read field-window` backed by `GET /v1/streams/{stream}/records/{id}/field-window`. Add CLI evidence-card output mode or projection if shared primitives need a human-facing renderer.

### Slice 4: MCP migration

Move MCP search/fetch/query content ladder and visible card rendering onto shared primitives. Preserve existing tool names and deployed behavior where possible.

### Slice 5: Optional REST evidence projection

If the shared shape proves useful beyond adapters, expose an opt-in REST projection such as `view=evidence` without replacing canonical envelopes.

### Slice 6: Client smoke and measurement

Measure token payload size, call count, approval count, latency, and answer success across ChatGPT, Claude app/Desktop, Claude Code, Codex, Gemini CLI, Hermes, opencode, Cursor/IDEs, CLI, and REST.

## Acceptance Checks

- OpenSpec validates with `openspec validate unify-read-evidence-surface --strict`.
- Existing MCP tests pass.
- CLI read tests cover `field-window`.
- Shared evidence tests prove no-dead-end truncation and binary metadata-only behavior.
- MCP tests include a content-only client simulation proving visible `content[]` carries enough bounded evidence and continuation instructions when `structuredContent` is unavailable.
- Cross-surface tests prove MCP and CLI render the same evidence primitives.
- Negative controls prove field-name guessing is not reintroduced.
- Client matrix distinguishes proven from inferred behavior for every named client. No unproven client behavior may be used as a normative scenario.

## Deferred

- A dedicated ChatGPT app UI for batch evidence review.
- Replacing canonical REST envelopes with evidence cards by default.
- Any new connector-specific presentation rules.
