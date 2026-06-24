# MCP SLVP closeout audit

Status: incorporated into closeout branch
Owner: reference implementation
Created: 2026-06-24

## Scope

Two isolated Codex audit lanes reviewed the MCP read-evidence ladder after the
ChatGPT retest:

- tool topology: whether `read_record_field` is essential SLVP complexity or an
  incidental sixth tool;
- read-surface parity: where MCP, REST, CLI, and shared read-evidence primitives
  align or drift.

## Tool Topology Verdict

Keep `read_record_field` as the sixth normal MCP read tool.

The worker audit agreed this is essential complexity, not an incidental
workaround. `fetch` returns a record/document and `query_records` returns a
stream/list envelope. Neither is the same user journey as continuing from a
bounded search preview to one bounded text field window with truthful
truncation, match context, and inline output.

Folding field windows into `fetch` would either make `fetch` return two
different semantic result shapes or force a field window into a document-shaped
wrapper. Folding it into `query_records` would make a list/read operation also
own "continue this exact text evidence" behavior. Both increase cognitive load
and weaken the OpenAI-style search-to-fetch contract.

## Record URI Decision

`record_uri` is an operational handle. It is not guaranteed to be readable by a
generic MCP resource reader in every host. It must, however, be consumable by
model-callable read tools. The closeout branch adds coverage proving
`read_record_field(id="pdpp://record/<encoded-id>", ...)` routes to the same
grant-scoped field-window read as the self-contained result id.

## Parity Findings

MCP now has the strongest coverage:

- content-only search evidence;
- metadata-only negative control;
- bounded `read_record_field`;
- inline small projected `fetch`;
- hidden/bonus field-window resources for capable hosts;
- visible record URI compatibility.

Shared `packages/read-evidence` already emits `read_record_field` continuation
arguments and remains the common primitive for content ladders.

REST and CLI parity are not equally complete. REST search still exposes legacy
`snippet` / `matched_fields`-style search evidence below the MCP adapter, and
CLI lacks an explicit search and field-window read command even though record
reads already support field projection. Those are real follow-on read-surface
parity items, but they are broader than the MCP ChatGPT client closeout and need
their own OpenSpec change because they alter public REST/CLI contracts.

## Incorporated Closeout Changes

- Accept visible `pdpp://record/...` handles in `read_record_field.id`.
- Add hostile-client regression coverage for visible record URI bounded reads.
- Document `read_record_field` as essential complexity in the OpenSpec design.
- Correct the older MCP tool-surface prior-art note so the five-tool default is
  no longer read as current canon.
- Add README and server-instruction wording that resource reads are optional for
  ordinary evidence inspection; model-callable continuations are the required
  path.

## Residual Follow-On

Open a separate read-surface parity change if the next goal is to make REST and
CLI first-class peers of the MCP evidence ladder. That change should add
first-class REST match-window evidence and explicit CLI search/field-window
commands rather than hiding those contract changes inside the MCP closeout.
