# MCP Host Output Prior Art

Status: researched
Date: 2026-06-09
Source report: `tmp/workstreams/mcp-host-output-prior-art-2026-06-09-report.md`

## Findings

- `content[]` is the only portable model-visible channel. `structuredContent`
  is host-dependent: some clients expose it to the model, some hide it, and
  `_meta` is UI-only.
- `outputSchema` is useful for programmatic consumers, but does not change
  model-visibility rules. Any handle needed for the next model step belongs in
  `content[]`.
- Tool annotations are advisory, not security boundaries. The normal PDPP MCP
  tools should advertise `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, and `openWorldHint: false`, while the RS grant remains
  the actual authority boundary.
- Compact index plus scoped detail is consistent with current MCP/server prior
  art. Global schema discovery should be an index; field-level detail belongs
  behind scoped `schema(stream, connection_id?)`.
- PDPP's `t=`, `r=`, `a=` compact field-capability grammar has no direct
  shipping MCP-server prior art. It can remain only if each scoped response
  carries a visible legend or the grammar is replaced with explicit compact
  fields.
- Per-result source provenance is not standardized across major MCP servers.
  PDPP's `connection_id` + `connector_key` construction is the right answer to
  "which configured connection produced this record?" without profiles.

## Design Consequences

- Global `schema()` SHALL remain a bounded index as a whole tool result, not
  only as bounded prose.
- `schema(stream, connection_id?)` is the SLVP detail path for common stream
  names shared across connectors or connections.
- `search(limit: N)` SHALL return at most N merged hits across a package fan-in,
  and each hit SHALL carry source identity plus a compact source mix in text.
- `query_records(fields)` SHALL narrow canonical record payloads and preserve
  only operational source/addressing handles outside the requested payload.
- `fetch(fields)` SHALL project the source record before rendering the
  OpenAI-compatible document and SHALL NOT expose a second canonical record
  payload under `structuredContent.data`.
- No next cursor, bookmark, source selector, record id, or setup instruction may
  live only in `structuredContent`.

## Residual Host Unknowns

- ChatGPT-specific pre-dispatch blocks on particular `messages` sort/count calls
  appear to be host-side false positives when raw MCP, Claude, Claude Code, and
  Codex paths pass. The server-side gate is to verify hosted `tools/list`
  annotations and request-not-reached evidence, not to infer private classifier
  rules.
- Whether each host counts hidden `structuredContent` toward context remains
  host-specific. The safe PDPP posture is to keep broad discovery and duplicated
  hit arrays small even when hidden.
