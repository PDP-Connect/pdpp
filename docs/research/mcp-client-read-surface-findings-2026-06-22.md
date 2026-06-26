# MCP Client Read Surface Findings

Status: captured
Date: 2026-06-22
Owner: Codex

## Question

What did the MCP/ChatGPT investigation and prior-art pass actually show about token-efficient, navigable read surfaces for PDPP?

This note is the findings corpus entry. It records observed behavior and sourced prior art. The companion assessment in `docs/research/mcp-read-surface-slvp-assessment-2026-06-22.md` interprets these findings into a candidate design direction.

## ChatGPT Session Findings

The Hyperlane investigation exposed three distinct client states:

1. Search could prove matches existed, but the client-visible response exposed mostly envelope metadata, source mix, pagination links, or compact content-resource markers. This was insufficient to classify whether Hyperlane was depended on or merely mentioned.
2. Later search responses exposed record and field-window handles, but the ChatGPT path could not read `pdpp://field-window/...` resources through the generic resource reader. The affordance existed but was not practically usable in that client path.
3. Full `fetch` eventually made record bodies inspectable, but at least some bodies were delivered through file/materialization behavior that required user approval. That is acceptable for bulk export, but too interaction-heavy as the normal path for inspecting several small evidence records.

Observed requirement:

> Give the model enough bounded evidence to decide what to inspect, and guarantee that anything incomplete can be followed to the underlying content without an accidental dead end.

Observed cost dimensions:

- model-visible tokens;
- serialized tool payload size;
- number of calls;
- latency;
- host/user approvals;
- context occupancy;
- citation/provenance ergonomics.

## Behavioral Requirements Supported By The Session

High-confidence requirements:

- Search hits need bounded, visible match context, not only counts or pagination.
- If the visible representation omits, truncates, summarizes, or references underlying content, it must provide a working route to recover that content.
- Fully inlined tiny scalar values do not need their own handles; indiscriminate handles can become token overhead.
- Truncation must be explicit and paired with deterministic continuation.
- Full export/file delivery is appropriate for bulk or very large content, not ordinary small-record inspection.
- Counts and pagination prove reachability/volume; they do not prove semantic meaning.
- A tool-level incremental read fallback is required because resource handling is not uniformly model-visible across clients.

Provisional requirements:

- A four-rung ladder is a strong conceptual model: compact discovery -> bounded preview -> incremental read -> full resource/export.
- Exact envelope shape, URI grammar, short-id aliasing, and tool decomposition need measurement and client-matrix testing before being treated as final.

## MCP Specification Findings

Official MCP tools specification:

- Tools are model-controlled. If the model must automatically use a read path, the path should be a tool.
- Tool results include `content[]` for unstructured/model-visible content.
- Tool results may include `structuredContent`; output schemas let clients validate structured results.
- Tool results may include `resource_link` blocks pointing to resources.
- A resource linked from a tool is not guaranteed to appear in `resources/list`.
- Tool execution errors can be returned as `isError: true` with model-visible recovery information.

Official MCP resources specification:

- Resources are application-driven. The host decides how and when to incorporate them.
- `resources/read` can return text or binary resource contents.
- Resource templates can expose parameterized resources.

Implication:

- PDPP should not rely on resources or `structuredContent` as the only path to evidence. The model-visible `content[]` and model-callable tools must be sufficient for basic navigation.

## OpenAI / ChatGPT App Findings

OpenAI Apps SDK guidance says:

- The MCP server defines tools, enforces auth, returns data, and optionally points to UI resources.
- ChatGPT's model chooses when to call tools based on metadata.
- Server instructions should be concise; the first 512 characters should be self-contained for ChatGPT/Codex.
- Tool descriptors should include schemas; structured data should be tight and idempotent.
- UI/widget resources are useful, but the core server/data/tool boundaries should stay clean.

Observed ChatGPT implication:

- Returning full content as a file/resource can introduce a host approval boundary. That is not a PDPP write or authorization change, but it is a user-visible workflow cost.

## Successful MCP Server Patterns

GitHub MCP:

- Uses toolsets and individual tool allowlists to control exposed surface area.
- Documents read-only mode and toolset selection as ways to keep the model's tool choice set scoped.
- Provides CLI utilities for debugging/exploring the MCP server.

Sentry MCP:

- Explicitly targets human-in-the-loop debugging/coding workflows rather than exposing every upstream API operation.
- Optimizes the MCP surface for the actual job-to-be-done.

Cloudflare MCP / MCP portals:

- Treats endpoint-per-tool expansion as a token/context problem.
- Uses progressive disclosure/code-mode patterns to reduce exposed tool definitions.
- Emphasizes centralized policy, audit, and controlled tool exposure.

Implication for PDPP:

- Keep the normal MCP tool set small and intent-shaped.
- Prefer progressive disclosure through schema/search/fetch/read-window over one tool per low-level operation.
- Keep read-only default posture and avoid broad, over-described tool schemas.

## PDPP Surface Findings

Resource-server / REST is the canonical read authority:

- `GET /v1/schema`
- `GET /v1/streams`
- `GET /v1/streams/{stream}/records`
- `GET /v1/streams/{stream}/records/{id}`
- `GET /v1/search`, `/v1/search/semantic`, `/v1/search/hybrid`
- `GET /v1/streams/{stream}/aggregate`
- `GET /v1/streams/{stream}/records/{id}/field-window`

CLI currently exposes:

- `schema`
- `streams`
- `query-records`
- `fetch`
- `search`
- `aggregate`

MCP currently exposes:

- `schema`
- `query_records`
- `aggregate`
- `search`
- `fetch`
- `read_record_field`
- `pdpp://record/{handle}` and `pdpp://field-window/{handle}` resources.

Parity findings:

- MCP has field-window navigation that CLI does not expose directly.
- CLI/REST expose canonical read envelopes but not the same evidence-card/content-ladder affordance MCP now provides.
- MCP has adapter-local logic for content ladders, handle encoding, filter/query encoding, result normalization, and title fallback. These are drift risks if CLI, Explore, SDKs, and MCP each maintain their own versions.
- Explore uses manifest presentation roles more deeply than MCP search/fetch cards currently do.

## Confidence From Findings

- Bounded previews with truthful truncation: 97%.
- No preview/search hit should be a dead end: 97%.
- Explicit incremental reads for additional content: 95%.
- Export/file delivery for genuinely large or bulk content: 92%.
- Four-rung ladder as the right conceptual model: 88%.
- Exact envelope and handle structure: 75%.
- Separate field/window tool as the best implementation: 70%.
- Demonstrably simplest or most token-efficient design: 60% until measured.

## Sources

- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- https://developers.openai.com/apps-sdk/build/mcp-server
- https://github.com/github/github-mcp-server
- https://github.com/getsentry/sentry-mcp
- https://blog.cloudflare.com/enterprise-mcp/
