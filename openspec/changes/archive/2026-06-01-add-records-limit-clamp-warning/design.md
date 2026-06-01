## Context

The records-list contract already defines one page-size boundary: default `25`,
maximum `100`. The reference contract, OpenAPI, and `spec-core.md` agree on that
boundary, but the runtime and MCP tool surface had drifted in different ways:
REST silently clamped over-large requests, while MCP advertised a larger maximum.

The design goal is not to introduce a new pagination model. It is to make the
existing boundary visible and consistent for agent clients without breaking
lenient REST callers.

## Decision

REST remains lenient and clamps `limit > 100` to the maximum, but the response
adds a structured `limit_clamped` entry to the existing `meta.warnings[]`
channel. This preserves the current successful response shape while making the
effective page size explicit.

MCP rejects `limit > 100` at input validation. MCP tools are schema-first agent
interfaces: if the tool schema says a value is accepted, the agent should be
able to trust that request shape. Rejecting over-max input at the MCP boundary is
therefore more honest than accepting it and relying on a downstream REST clamp.

SQLite and Postgres record paths share one clamp helper and one warning builder
so the boundary is not redefined in parallel code paths.

## Alternatives Considered

- Return `400` from REST for `limit > 100`. Rejected as a breaking change for
  existing direct REST callers. The clamp already existed; the missing property
  was disclosure, not strictness.
- Let MCP keep accepting up to `1000` and surface the REST warning. Rejected
  because it leaves the tool schema in conflict with the public contract and
  encourages token-inefficient calls.
- Add a new top-level response field for the effective limit. Rejected because
  `meta.warnings[]` already carries known non-fatal request adjustments.

## Boundaries

This change only affects records-list `limit` handling. It does not change grant
evaluation, cursor semantics, `has_more`, search/aggregate limits, record
envelopes, connection identity, or deprecated `connector_instance_id`
compatibility.

## Acceptance Checks

- REST calls with omitted or in-range `limit` values return the same page shape
  and no new warning.
- REST calls with `limit > 100` return a bounded page and a single structured
  `limit_clamped` warning, including fan-in reads.
- MCP `query_records` advertises `maximum: 100` and rejects over-max input before
  calling the resource server.
- SQLite and Postgres records paths both use the shared clamp primitive.
