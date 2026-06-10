## Context

The post-battery MCP work fixed real read-journey defects: bounded schema
discovery, source-scoped full schema, strict projection, global fan-in search
limits, document-shaped MCP `fetch`, authored timestamp titles, bounded
ambiguity errors, and model-visible handles. Some fixes landed in canonical
resource-server operations and search helpers; others landed in MCP adapter
result shaping.

The current construction is directionally right but not yet proven SLVP-ideal
across implementations:

- REST remains the canonical public read contract and already routes many reads
  through `operations/rs-*`.
- MCP is a host adapter over REST, but it now has the most polished discovery
  and presentation behavior because it received the full ChatGPT/Claude/Codex
  battery.
- CLI has grant-scoped `pdpp read` commands, but its schema command does not
  yet expose the same source-scoped discovery loop and its recommended surface
  still tolerates deprecated selector vocabulary.
- The smoke harness checks REST and MCP deeply enough to catch major read
  regressions, while CLI coverage is still basic.

SLVP ideal means MCP is not allowed to become the privileged implementation of
PDPP reads. MCP may be better adapted to model hosts, but the underlying
semantics must be transport-invariant.

## Goals / Non-Goals

**Goals:**

- Make REST/resource-server operations the single source of truth for public
  read semantics.
- Keep MCP, CLI, and REST aligned on schema discovery, source identity,
  projection, fan-in search limits, pagination, counts, warnings, and typed
  errors.
- Make adapter-owned code small and explicit: authentication/cache lookup,
  transport argument serialization, schema/input validation, and presentation.
- Bring CLI to the same discovery loop used by MCP and REST, including common
  stream names that require `connection_id`.
- Expand verification so a future MCP-only fix that leaves CLI/REST behind is
  caught before deployment.

**Non-Goals:**

- Do not force every transport to expose identical response envelopes.
- Do not remove REST's deprecated `connector_instance_id` compatibility alias in
  this change.
- Do not add MCP profiles, event tools, or owner/control-plane setup to the
  normal read surface.
- Do not solve search relevance or aggregate latency in this architecture
  change; track those as quality/performance follow-ups surfaced by the same
  parity harness.

## Decisions

### 1. Canonical read semantics live below adapters

REST route handlers, hosted package helpers, MCP tools, and CLI commands SHALL
not each implement their own versions of filtering, projection, source
resolution, fan-in limiting, cursor generation, or warning construction. Those
behaviors live in canonical operations or shared pure transforms.

Adapters may still parse flags, encode URL query parameters, validate an MCP
input schema before dispatch, read a token cache, or render model-visible text.
Those are transport concerns, not read semantics.

Alternative considered: keep MCP-specific fixes in `packages/mcp-server` and
patch CLI/REST only when bugs appear. That recreates the exact failure mode this
change is intended to prevent.

### 2. Schema discovery is a shared read primitive

The transport-invariant discovery loop is:

1. `schema()` returns a compact grant index.
2. `schema(stream)` narrows by stream name and may still return multiple
   sources because stream names are not globally unique.
3. `schema(stream, connection_id)` narrows to one configured source.
4. Full schema detail is reachable only after stream and source are resolved.

REST should expose the primitive first because `/v1/schema` is the canonical
capability document. MCP and CLI should forward to that primitive rather than
reconstructing schema scoping locally.

Alternative considered: keep `connection_id` scoping MCP-only because it was
discovered through hosted-client failures. That would make MCP stronger than
REST and would make CLI users pay a token/cognitive tax that MCP users avoid.

### 3. MCP `fetch` remains presentation-specific, not semantic-specific

MCP `fetch` follows the OpenAI/MCP search-fetch document shape
(`id`, `title`, `text`, `url`, `metadata`). That shape is allowed because it is
host presentation. It must be built from canonical record/search primitives and
must not define a second record-detail contract.

REST record detail remains the canonical structured record fetch. CLI may expose
REST record detail directly. Agents that need canonical records use
`query_records` or REST/CLI record detail, not MCP document fetch.

### 4. CLI is a first-class adapter

The CLI is not merely token plumbing. It is the ordinary local-agent path when a
host does not support MCP or when raw HTTP is impractical. CLI help and commands
should present `connection_id` as the canonical selector, expose the same
schema-scoping flags, and avoid making deprecated aliases part of the
recommended path.

The CLI can keep compatibility flags where REST still accepts them, but those
flags must be documented as compatibility-only and covered by warnings or tests
where applicable.

### 5. Verification is a parity matrix

The read-surface smoke should exercise REST, MCP, and CLI against the same grant
and stream. It should prove, at minimum:

- compact schema discovery works;
- `schema(stream, connection_id)` reaches one source;
- strict projection works;
- global fan-in search limits are honored;
- canonical source identity is present;
- cursor/count handles are visible through each transport's expected channel;
- typed errors and ambiguity errors are bounded;
- owner/control-plane bearer setup remains excluded from ordinary reads.

Adapter-specific assertions remain separate. For example, MCP `tools/list`
membership and `content[]` handles are MCP-only, while CLI cache-file hygiene is
CLI-only.

## Risks / Trade-offs

- Over-abstracting adapters could make simple transport code harder to follow.
  Mitigation: share pure transforms and operation calls, not a generic
  all-purpose adapter framework.
- MCP and REST cannot share response envelopes exactly because MCP needs
  model-visible `content[]` and document-shaped `fetch`. Mitigation: define
  semantic parity separately from presentation parity.
- REST's current full-schema default exists for compatibility and can remain
  larger than the MCP default. Mitigation: add the same scoped compact/detail
  selectors to REST and CLI while leaving default compatibility intact.
- CLI broad parity tests may be slower than unit tests. Mitigation: keep the
  full parity matrix in the smoke harness and add focused unit tests for flag
  mapping and deprecated-alias handling.

## Migration Plan

1. Audit REST, MCP, package fan-in, and CLI read code for duplicated semantics.
2. Move any duplicated read behavior into `operations/rs-*` or shared pure
   read-surface transforms.
3. Add REST schema `connection_id` scoping where missing.
4. Expose the same schema-scoping selectors in CLI.
5. Keep MCP presentation wrappers but make them consume canonical results.
6. Expand parity tests and live smoke checks.
7. Update docs/skills so MCP is described as a host adapter over the same
   scoped read surface, not a stronger path.

## Open Questions

None for the architecture boundary. Search relevance, semantic-search latency,
aggregate `group_by_time` latency, and ambiguity-error latency remain SLVP-ideal
quality follow-ups, but they do not change where read semantics should live.
