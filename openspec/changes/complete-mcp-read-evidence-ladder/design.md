# Design

## Problem

MCP clients differ in what they expose to the model. Some expose
`structuredContent`, some surface only `content[]`, some support resources, and
some show resource links but cannot read them. The current substrate assumes too
much from the client: it may put enough information in structured fields or
resource handles while visible text remains insufficient for classification.

The design target is not "inline everything." The target is a bounded ladder:
discover compact evidence, inspect a bounded text window, continue explicitly,
and escalate to full resource/export only when needed.

## Boundaries

Resource server owns:

- grant enforcement;
- search and fetch semantics;
- which field matched a search result when the backend can prove it;
- field-window cursor/offset semantics;
- binary/blob routes and canonical REST envelopes.

Shared read/evidence package owns:

- bounded evidence card vocabulary;
- truncation and continuation markers;
- field-window summary shape;
- binary metadata discipline;
- adapter-neutral record identity.

MCP owns:

- visible `content[]` rendering;
- `structuredContent` wrapper;
- resource links and resource reads;
- model-callable continuation tools.

MCP must not infer semantic roles or matched fields from connector names, stream
names, or field names.

## Hostile-Client Contract

The test harness treats `structuredContent` as hidden and treats MCP resources as
unavailable. Under that harness:

- Search results with proven text match windows must still show a bounded snippet
  in visible text.
- The visible text must include a concrete model-callable continuation: tool name
  and minimal arguments or an opaque read handle.
- A hit without a proven match window must say that only metadata is available,
  not pretend a field was matched.
- Small text inspection must return inline text with `complete`,
  `next_cursor`, or equivalent continuation.
- File/materialized output is not acceptable for ordinary small text inspection.

## Alternatives

### Resource-only ladder

Rejected. It is efficient when the host supports resources but fails in clients
that expose resource links without readable resources.

### Full inline records

Rejected. It fixes dead ends by wasting tokens and exposing more personal data
than needed.

### MCP-side field-name guessing

Rejected. It reintroduces the same trust violation fixed in Explore: client code
would decide that fields such as `text`, `body`, or `message` are the meaningful
content without server proof or manifest authorship.

## Acceptance Checks

- Content-only search result test passes for a Slack-like body match.
- Metadata-only search result test does not invent a matched body.
- Field-window resource and `read_record_field` tool resolve the same bounded
  text when both are available.
- Resource-read failure does not create a dead end because the visible tool path
  still works.
- Small text fetch/read stays inline.
- Binary/base64/blob fields stay metadata-only by default.
- `openspec validate complete-mcp-read-evidence-ladder --strict` passes.

## Residuals

- Live hosted-client smoke remains required after the merged branch is deployed. The implementation is not live-complete until a fresh ChatGPT session confirms bounded visible search evidence, callable `read_record_field`, and inline small projected fetch behavior on the deployed stack.
- The full `reference-implementation` suite currently has an unrelated `device-exporter-routes.test.js` redaction assertion failure on rewritten `origin/main` (`2cbce1a2`). MCP/read-evidence verification uses the focused resource-server, MCP, read-evidence, typecheck, and OpenSpec gates until that pre-existing failure is repaired separately.
