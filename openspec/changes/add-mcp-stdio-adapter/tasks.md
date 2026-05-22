## 1. Package Scaffold

- [x] 1.1 Add `packages/mcp-server/` as private/beta package `@pdpp/mcp-server` with package metadata, bin entry, TypeScript config, README, and workspace registration.
- [x] 1.2 Add the MCP TypeScript SDK dependency scoped to `packages/mcp-server` and update the lockfile.
- [x] 1.3 Decide and implement credential-cache reuse: import an existing stable helper or extract a small shared cache reader without coupling to CLI command internals.

## 2. Stdio Server

- [x] 2.1 Implement a stdio MCP server entrypoint that keeps stdout protocol-clean and sends logs/errors to stderr.
- [x] 2.2 Load provider URL, grant/token cache key, and optional server name from CLI flags/env without accepting owner tokens by default.
- [x] 2.3 Fail closed with actionable `pdpp connect <provider-url>` guidance when no scoped client token is available.

## 3. Read-Only Tools And Resources

- [x] 3.1 Implement a static schema/capabilities tool that describes the adapter and available RS-backed operations.
- [x] 3.2 Implement `list_streams` by calling `GET /v1/streams` with the scoped token.
- [x] 3.3 Implement `query_records` by forwarding supported RS query parameters without inventing new query semantics.
- [x] 3.4 Implement `search` over the existing lexical/semantic/hybrid RS search endpoints when configured, with clear unavailable errors when unsupported.
- [x] 3.5 Implement `fetch_blob` through existing RS blob URLs/endpoints using the same scoped token.
- [x] 3.6 Implement `pdpp://stream/{name}` resource template backed by RS stream metadata and/or records as appropriate for MCP clients.

## 4. Error And Security Semantics

- [x] 4.1 Map RS authentication, authorization, invalid cursor, expired cursor, unsupported query, and needs-broader-grant errors into MCP `isError` results without broadening credentials.
- [x] 4.2 Ensure tool descriptions are static and manifest/record content is returned as data, not interpolated into tool instructions.
- [x] 4.3 Add tests proving `PDPP_OWNER_TOKEN` is ignored/refused by default.

## 5. Validation And Documentation

- [x] 5.1 Add unit tests for cache loading, request construction, error mapping, and stdout/stderr separation.
- [x] 5.2 Add an integration test against a reference server fixture proving MCP results match direct RS results under the same token.
- [x] 5.3 Run `openspec validate add-mcp-stdio-adapter --strict` and `openspec validate --all --strict`.
- [x] 5.4 Run `pnpm --filter @pdpp/mcp-server run test` and any package build/typecheck scripts.
- [x] 5.5 Run a manual MCP Inspector or equivalent stdio smoke and record concise evidence under `tmp/workstreams/`.
- [ ] 5.6 Update PDPP agent-skill or README guidance to mention the MCP adapter as an alternative to raw HTTP after it is validated. *(Deferred to a follow-up — README in the new package documents usage; promoting it into the wider agent-skill docs should happen alongside published-beta release per the design's promotion-trigger guidance.)*
