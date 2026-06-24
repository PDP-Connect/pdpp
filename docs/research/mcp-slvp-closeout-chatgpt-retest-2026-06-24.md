# MCP SLVP closeout ChatGPT retest

Status: incorporated into `openspec/changes/complete-mcp-read-evidence-ladder`
Owner: reference implementation
Created: 2026-06-24

## Question

Does the live ChatGPT MCP client now satisfy the PDPP read-evidence ladder for
ordinary Slack message classification: compact discovery, bounded visible
evidence, callable bounded read, and no file materialization?

## Retest Summary

The ChatGPT client exposed the normal PDPP tool surface:

- `schema`
- `query_records`
- `aggregate`
- `search`
- `fetch`
- `read_record_field`

Vana Slack was discoverable as connector `slack`, connection
`cin_f565a96cb0a114b0a27e9606`, stream `messages`.

Slack-scoped lexical search for `Hyperlane` and `hyperlane` succeeded without a
host safety block. The visible search response included matched Slack message
preview text, including:

```text
...Are we going to bridging using Hyperlane or LayerZero? Layer Zero for sure....
```

`read_record_field` was callable, returned inline bounded text for
`messages.text`, and included window metadata: `total_chars`, `start_chars`,
`end_chars`, `limit_chars`, `complete`, `has_more`, match offsets, and
continuation cursors.

Projected `fetch` for `id`, `text`, `channel_id`, `user_id`, `sent_at`, and
`thread_ts` returned inline projected fields rather than a file attachment.

## Remaining Client Observation

ChatGPT still labeled "no dead-end handles" as partial because a visible
`pdpp://record/...` URI was not readable through the generic resource reader and
was not accepted as `read_record_field.id`.

This observation does not require making `pdpp://record/...` a generic MCP
resource. The SLVP invariant is that visible incomplete content has a working
model-callable continuation. The concrete compatibility gap was that the visible
record URI should be accepted directly by the bounded-read tool.

## Decision

Keep `read_record_field` as essential complexity in the normal MCP read surface.
Earlier tool-surface research preferred a five-tool default, but live ChatGPT
tests showed that a separate bounded field/window read prevents file
materialization and resource-reader dead ends during ordinary evidence
inspection.

`record_uri` is an operational handle. It is not promised to be readable through
every host's generic `resources/read` path, but it must be accepted by
model-callable read tools.

## Incorporated Fix

`packages/mcp-server/src/tools.js` now accepts `pdpp://record/<encoded-id>` in
the same parser that accepts self-contained record ids. Hostile-client coverage
proves `read_record_field(id="pdpp://record/cin_slack%2Fmessages%3Am1", ...)`
routes to the grant-scoped field-window read for `cin_slack/messages:m1`.

## Acceptance Standard

This closes the ChatGPT MVP evidence workflow only if all of the following hold:

- Search visible text includes bounded matched evidence when the backend can
  prove the matched field/window.
- Metadata-only hits do not invent body evidence.
- Visible record handles are accepted by model-callable read tools.
- `read_record_field` returns inline bounded text and truthful continuation
  metadata.
- Ordinary small projected `fetch` responses stay inline.
- File/resource materialization remains reserved for large, bulk, or binary
  content.
- Generic MCP resource-read failure is not a dead end when the visible
  model-callable continuation works.
