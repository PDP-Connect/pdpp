# MCP Content Ladder For PDPP Records And Fields

Status: research recommendation, not a protocol change
Created: 2026-06-22
Scope: arbitrary PDPP records and fields exposed through MCP tools/resources

## Question

What is the simplest lossless verifiable path for returning arbitrary PDPP record and field content through MCP without spending model context on bytes the agent has not asked to inspect, while still making every visible item fully navigable?

## Sources

- MCP Tools specification, 2025-06-18: `content[]`, `structuredContent`, resource links, embedded resources, output schemas, and tool-result error handling. <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- MCP Resources specification, 2025-06-18: resource URIs, `resources/list`, `resources/read`, templates, resource metadata, annotations, and URI-scheme guidance. <https://modelcontextprotocol.io/specification/2025-06-18/server/resources>
- MCP Pagination utility, 2025-06-18: opaque cursors, server-selected page size, `nextCursor`, and client cursor constraints. <https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination>
- MCP Schema Reference, 2025-06-18: `ResourceLink`, `EmbeddedResource`, `TextResourceContents`, `BlobResourceContents`, `Result._meta`, and JSON-RPC error shape. <https://modelcontextprotocol.io/specification/2025-06-18/schema>
- OpenAI Apps SDK MCP server guide and examples: structured tool payloads paired with resource-backed UI/files, plus downloadable MCP `resource_link` support. <https://developers.openai.com/apps-sdk/build/mcp-server>, <https://github.com/openai/openai-apps-sdk-examples>
- Local PDPP notes: `design-notes/prior-art/mcp-data-surface-prior-art-2026-06-09.md`, `design-notes/mcp-tool-surface-token-footprint-2026-06-08.md`, `design-notes/mcp-tool-surface-prior-art-2026-06-08.md`, and `openspec/changes/define-mcp-agent-entrypoint-surface/design.md`.
- Local MCP adapter shape: `packages/mcp-server/src/tools.js` currently exposes five normal read tools (`schema`, `query_records`, `aggregate`, `search`, `fetch`), compact schema discovery, canonical `structuredContent.data`, flattened `structuredContent.results` for search, and document-only `fetch`.

## Recommendation

Use a four-rung content ladder:

1. **Discovery and list responses return compact structured summaries plus stable navigation handles.**
   `schema`, `query_records`, and `search` should keep bounded text summaries in `content[]` and canonical machine envelopes in `structuredContent`. Every row, hit, field, expansion, attachment, or large scalar that is visible in a summary should carry a stable handle: either an MCP `resource_link` or a PDPP document/field handle accepted by an explicit read tool.

2. **Default record payloads include previews, not arbitrary full bodies.**
   For text-like fields, include a bounded window with byte/character offsets, total size, MIME type, digest or revision marker, and truncation metadata. For structured fields, include a compact JSON preview with a path handle. For binary fields, include metadata and a `resource_link`, not base64 bytes in default tool results.

3. **Full content is reachable by explicit read, not hidden behind the default result.**
   Add or generalize a read primitive that can fetch one record field or one bounded window by handle. It should support `offset`/`limit` or cursor-like windows for text, path projection for JSON, and a resource-read/export path for full documents or binary values. Existing `fetch` can remain document-shaped for OpenAI-compatible search results; arbitrary PDPP fields need a sibling "read field/window" shape rather than overloading search-document fetch.

4. **Bulk/full extraction uses export, not chat transcript payloads.**
   When the user or agent truly needs a complete record set, large field, blob, or replayable artifact, return an export job/result with metadata and `resource_link` entries. The model sees the manifest and selected previews; the client or user can download/read the artifact through MCP resources or a scoped URL.

This is the SLVP shape because it preserves the important properties at the same time: low default token cost, deterministic navigation from every summary item to full content, MCP-native compatibility, and testable evidence that no visible data is a dead end.

## Recommended Envelope Shape

For list/search/query tools:

```json
{
  "content": [
    {
      "type": "text",
      "text": "query_records: 25 item(s), has_more=true. Previews are bounded; full fields are available via handles in structuredContent.data."
    }
  ],
  "structuredContent": {
    "data": {
      "stream": "messages",
      "records": [
        {
          "id": "rec_123",
          "record_handle": "pdpp://record/<connection_id>/messages/rec_123",
          "fields": {
            "subject": {
              "kind": "scalar",
              "value": "Quarterly planning"
            },
            "body": {
              "kind": "text_preview",
              "mime_type": "text/plain",
              "size_bytes": 84231,
              "window": {
                "start": 0,
                "end": 2048,
                "truncated": true,
                "next": "pdpp://field/<connection_id>/messages/rec_123/body?start=2048"
              },
              "preview": "bounded text...",
              "resource": {
                "type": "resource_link",
                "uri": "pdpp://field/<connection_id>/messages/rec_123/body",
                "name": "messages/rec_123/body",
                "mimeType": "text/plain",
                "size": 84231
              }
            }
          }
        }
      ],
      "nextCursor": "opaque"
    }
  }
}
```

For field reads:

```json
{
  "content": [
    {
      "type": "text",
      "text": "messages/rec_123/body bytes 2048-4095 of 84231; next window available."
    }
  ],
  "structuredContent": {
    "uri": "pdpp://field/<connection_id>/messages/rec_123/body",
    "mime_type": "text/plain",
    "size_bytes": 84231,
    "window": {
      "start": 2048,
      "end": 4096,
      "truncated": true,
      "next": "pdpp://field/<connection_id>/messages/rec_123/body?start=4096"
    },
    "text": "bounded text window..."
  }
}
```

The exact handle grammar should be settled in a change proposal. The important shape is stable identity plus explicit window coordinates. Cursors are appropriate for unstable result sets; offsets are better for immutable field snapshots. If records can mutate between reads, handles need a revision/digest parameter and stale-handle errors.

## Option Comparison

| Option | Where it fits | Strength | Cost / risk | Recommendation |
| --- | --- | --- | --- | --- |
| Inline full | Small scalar fields, tiny records, aggregate answers | Simplest for the model; no follow-up call | Unbounded token cost; accidental disclosure of irrelevant bytes; binary/base64 blowups; partial truncation can look complete | Allow only below strict size thresholds with explicit `truncated=false` metadata |
| Snippets only | Search hits, list previews, field previews | Very cheap; good ranking/browsing surface | Loses evidence unless every snippet has a full-content path; can bias model toward excerpt-only reasoning | Use by default, but never without handles and total-size/truncation metadata |
| Opaque handles | Search result IDs, record IDs, field handles, cursors | Compact; avoids leaking structure into token budget; supports stable APIs | Dead-end risk if handles are not accepted everywhere needed; poor model ergonomics if handle meaning is invisible | Use for identity and continuation, with human-readable labels and typed handle fields |
| Resource links | Full documents, field bodies, binary blobs, downloads, exports | MCP-native; clients can fetch/read/subscribe; good for large or non-text content | Some clients may expose resources differently; resource links returned by tools are not guaranteed to appear in `resources/list` | Use for navigable full content and exports; pair with tool-read fallback |
| Bounded text windows | Long text fields, logs, transcripts, email/message bodies | Lossless by iteration; easy to test; avoids accidental full-body dumps | Requires snapshot/revision semantics; mid-document navigation and search-inside need design | Preferred default full-read primitive for text |
| Chunked full read | Explicit "read all chunks" workflows and deterministic local clients | Lossless and model-readable over several turns | Expensive; error-prone in hosted clients; can crowd out reasoning context | Support, but require explicit iteration and visible progress/total metadata |
| Export | Large records, record sets, binaries, archives, audit packets | Keeps chat lean; good for reproducibility and user downloads | Requires lifecycle, retention, access checks, and clear manifest | Use for bulk/full extraction beyond per-field windows |

## Failure Modes

- **Preview-only dead ends.** A search/list response shows a snippet or field name but no handle can recover the full field.
- **Silent truncation.** Text is shortened in `content[]` or `structuredContent` without `truncated`, total size, and continuation metadata.
- **Duplicate canonical bodies.** The same large payload appears in both `content[]` and `structuredContent`, or under two structured keys, multiplying context cost and creating divergence.
- **Handle drift.** A handle points to a moving record without a revision/digest, so a later window belongs to different content than the preview.
- **Client capability mismatch.** Some clients may not surface MCP resources uniformly. Tool-level read fallbacks should exist for any resource link needed by the model.
- **Ambiguous source identity.** Shared stream names across connections can make `stream:record_id` handles ambiguous. Handles should encode `connection_id` or force typed ambiguity recovery.
- **Unauthorized escalation by handle.** A handle must not bypass the grant. Every read/export path needs the same stream/field/action/time checks as the original query.
- **Binary in the transcript.** Base64 blobs in default tool results can burn context and produce unusable model input. Binary fields should default to metadata/resource links.
- **Window boundary corruption.** Byte offsets can split Unicode text; character offsets can be expensive or ambiguous across encodings. The API should define whether coordinates are bytes, UTF-8 code points, or lines and return the actual range served.
- **Export as an authorization side channel.** Export manifests and files must not include records or fields outside the grant, even when created from a broad query.

## Testable Invariants

1. **Bounded default invariant.** No default `query_records`, `search`, `schema(compact)`, or aggregate response can exceed a configured serialized byte/token budget for a fixed `limit`, excluding explicit full-read/export calls.
2. **No dead-end invariant.** Every truncated field, snippet, result hit, resource, expansion summary, and binary placeholder includes a handle accepted by `fetch`, a field-read tool, `resources/read`, or export.
3. **Truncation honesty invariant.** Any shortened text includes `truncated=true`, full size when known, served range, and either `next` or a terminal reason.
4. **Canonical location invariant.** A tool result has one canonical machine payload location. Compatibility text summarizes or mirrors only compact JSON where required; it does not carry a second divergent full body.
5. **Grant preservation invariant.** Reading a handle under the same token cannot return fields, records, streams, time ranges, or blobs that the originating grant could not query directly.
6. **Stable snapshot invariant.** Multi-window reads either return all windows from the same content revision/digest or fail with a typed stale-handle error.
7. **Opaque cursor invariant.** Result-set cursors and continuation cursors are not parseable API contracts, are not required to be stable across sessions, and fail with typed invalid-cursor errors.
8. **Resource fallback invariant.** Any MCP `resource_link` that the model must reason over has an equivalent tool-call read path for clients that do not expose resource reads to the model.
9. **Binary default invariant.** Default list/search/query responses never include base64 field bodies above a tiny threshold; they return MIME type, size, digest, and resource/export handles.
10. **Round-trip invariant.** Given a visible preview item, an automated test can follow its handle and recover the preview bytes as a prefix/window/subsequence of the full content according to declared coordinates.

## Implementation Notes For A Future Change

- Keep the existing five-tool normal read surface. Add content navigation as a shape within `query_records`/`search` outputs and a narrow read primitive, rather than adding many content-type-specific tools.
- Keep `fetch` document-compatible for search hits. Add a separate generic field/window reader if arbitrary record fields need navigation; this avoids weakening the current OpenAI-compatible document contract.
- Use MCP resources for addressable full content and export artifacts. MCP resources are application-driven and URI-addressed; tool results may return `resource_link` blocks for additional context.
- Use MCP pagination principles for list-like operations and opaque continuations. Do not expose parseable page numbers as a durable contract.
- Use output schemas for tool results that agents depend on. The MCP spec says clients should validate structured results when an output schema is present; this gives the invariants a concrete test surface.
- Treat OpenAI Apps SDK patterns as evidence for the split between model-visible structured data and resource-backed UI/files, not as product authority over PDPP.

## Current Leaning

The generalized SLVP ladder is:

`compact summary -> typed preview with handle -> bounded read window -> resource read/export`

Inline full content remains a size-limited optimization, not the default. Snippets are acceptable only when every snippet is navigable. Opaque handles are necessary but insufficient alone; they need typed metadata and a guaranteed read path. Resource links are the MCP-native way to expose full content, but PDPP should also keep a tool-level read fallback because client resource UX is not uniform.

## Promotion Trigger

Promote this into an OpenSpec change before implementation if PDPP adds or modifies any durable MCP contract: handle URI grammar, field-read tool shape, resource templates, export resources, truncation metadata, or output schemas.
