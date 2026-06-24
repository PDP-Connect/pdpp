# MCP Read Evidence Client Smoke Matrix

Status: captured
Date: 2026-06-22
Related change: `openspec/changes/unify-read-evidence-surface/`

## Question

Which read/evidence behaviors are proven in this tranche, which are user-observed,
and which named-client behaviors remain inferred or residual live verification?

## Proven Locally

`@pdpp/read-evidence`:

- Bounded record summaries preserve continuation facts: `has_more`, `next_cursor`,
  `next_changes_since`, and count grade/value.
- Multi-record truncation includes a model-visible follow-up path for clients that
  hide `structuredContent`.
- Content-ladder descriptors expose stable record identity, field-window tool
  arguments, and opaque `pdpp://field-window/...` handles.
- Binary/blob fields render as metadata-only evidence, including the
  `binary_field` marker used by existing MCP tests.
- Generic evidence primitives do not infer title, actor, connector role, or field
  name semantics.

MCP adapter:

- `query_records`, `search`, and `fetch` content-ladder construction route through
  shared evidence primitives while preserving existing output tests.
- `content[]` remains bounded and readable when `structuredContent` is hidden.
- `read_record_field` and `pdpp://field-window/...` resource reads remain
  available and grant-scoped.
- Resource handles are continuation state, not bearer authorization.

CLI:

- `pdpp read field-window` forwards the RS field-window request with
  `connection-id`, `connector-instance-id`, `cursor`, `offset-chars`, `limit-chars`,
  `q`, `before-chars`, and `after-chars`.
- CLI `--format table` for field windows uses the shared field-window evidence
  summary. Default CLI output remains canonical JSON.

REST:

- Canonical envelopes remain unchanged.
- No REST evidence projection is approved in this tranche.

## User-Observed Hosted Client Evidence

ChatGPT:

- The Hyperlane investigation exposed an initial dead-end pattern: search could
  prove matches existed, but the visible response did not expose usable hit IDs,
  snippets, or readable field windows.
- A later retest exposed record handles and fetchable records, which made the
  investigation answerable, but full-record fetches materialized files and caused
  approval prompts.
- This is evidence for the product requirement, not a complete hosted-client
  compatibility test of the new shared package.

## Named-Client Matrix

| Client surface | Status | Evidence |
| --- | --- | --- |
| `@pdpp/cli` | proven locally | Unit tests cover `read field-window` request construction, selector validation, table projection, and package smoke. |
| REST API | proven locally | Existing RS route/substrate tests cover field-window behavior; canonical envelopes unchanged. |
| MCP server package | proven locally | MCP package tests cover search/fetch/query content ladder and content-only response behavior. |
| ChatGPT MCP client | user-observed, residual live smoke | User-observed Hyperlane session proves the failure mode and later improvement. The final shared-package behavior still needs a live hosted-client smoke. |
| Claude app/Desktop MCP | inferred, residual live smoke | No current live-client smoke in this tranche. |
| Claude Code MCP | inferred, residual live smoke | No current live-client smoke in this tranche. |
| Codex MCP | inferred, residual live smoke | No current live-client smoke in this tranche. |
| Gemini CLI MCP | inferred, residual live smoke | No current live-client smoke in this tranche. |
| Hermes MCP | inferred, residual live smoke | No current live-client smoke in this tranche. |
| opencode MCP | inferred, residual live smoke | No current live-client smoke in this tranche. |
| Cursor/IDE MCP clients | inferred, residual live smoke | No current live-client smoke in this tranche. |

## Measurement Status

| Metric | Status |
| --- | --- |
| Payload bounds | Proven locally by bounded-summary tests and MCP package budget-oriented tests. |
| Call count | Proven locally for the intended ladder calls: search/query/fetch discovery plus `read_record_field` or resource continuation. |
| Approval count | User-observed for ChatGPT full-record materialization. Not locally measurable without hosted-client smoke. |
| Latency | Not measured in this tranche; requires live hosted-client and live RS smoke. |
| Answer success | User-observed for the Hyperlane investigation after record fetch became reachable. Not a repeatable automated test in this tranche. |

## Decision

The implementation should not fork semantics per client. MCP, CLI, and any future
REST evidence projection should consume the same shared read/evidence primitives
for bounded evidence, continuation, binary metadata, and stable identity.

Hosted-client behavior remains a residual verification item. It must not be
represented as proven until the named clients are actually smoked against the
current MCP server.
