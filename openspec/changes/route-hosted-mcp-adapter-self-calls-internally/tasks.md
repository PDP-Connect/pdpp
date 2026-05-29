## 1. Config Plumbing

- [x] 1.1 Reuse the EXISTING internal resource-server config rather than inventing a new env. Per the reconciled design (design.md §1), no new `RS_INTERNAL_URL` is introduced: the adapter's internal base is the explicitly-configured `PDPP_RS_URL` (or `startServer`/`buildRsApp` opt `rsInternalUrl`). The bare `DEFAULT_RS_INTERNAL_URL` (`http://localhost:7663`) is deliberately NOT used as an implicit internal base, because in ephemeral-port harnesses and any deployment where the default does not match the realized listener it would misroute self-calls; when no explicit base is configured the adapter falls back to the public resource. No compose change required.
- [x] 1.2 Resolve the internal base in `handleHostedMcp` (`reference-implementation/server/routes/rs-hosted-mcp.ts`) as a value distinct from the advertised public `resource` (`internalBase = ctx.internalResource ?? resource`), falling back to the public `resource` when no internal base is configured.

## 2. Adapter providerUrl Split

- [x] 2.1 Pass the resolved internal base to `createPackageRsClient` as the child fetch base (`providerUrl`) so each child `RsClient` issues self-calls against the internal address; keep `mcpServerOptions.providerUrl` and the advertised `resource` public.
- [x] 2.1b Apply the same internal-base preference to the STANDALONE (`client`-token) branch: build the single-bearer `RsClient` via the injected `ctx.createRsClient({ providerUrl: internalBase, accessToken })` (new `createRsClient` factory in `server/package-rs-client.js`, wired through `index.js`) and pass it as `mcpServerOptions.rsClient`, keeping `mcpServerOptions.providerUrl` the public `resource` (display/provenance only — all fetches go through the injected client). So a `client`-token `update_event_subscription` PATCH also avoids the public-edge 405. Falls back to the public resource when no internal base is configured.
- [x] 2.2 Confirmed the protected-resource discovery metadata (`setHostedMcpProtectedResourceMetadata`) and `mcpServerOptions.providerUrl`/`buildMcpWebRequest` still resolve via `resolvePublicUrl` to the public origin; the internal base is fetch-only and never advertised. Verified by the wiring regression test and unchanged hosted-mcp-oauth discovery assertions.
- [x] 2.3 The internal base is operator-configured (`PDPP_RS_URL` / `opts.rsInternalUrl`), never request-derived from `Host`/`X-Forwarded-*` (which only feed `resolvePublicUrl` for the advertised resource).

## 3. Regression Test

- [x] 3.1 Added regression tests proving package-token PATCH (`update_event_subscription`) succeeds via the internal base when the public edge 405s PATCH. Unit layer in `reference-implementation/test/package-rs-client.test.js` (host-aware fake `fetch`: public edge 405s PATCH, internal base method-routes it; asserts ok + no `http_405`), with a falsifiability test proving the public base yields `http_405`.
- [x] 3.2 Added a wiring regression `reference-implementation/test/rs-hosted-mcp-internal-base.test.js` driving `handleHostedMcp` via `mountRsHostedMcp` (4 cases): asserts the `providerUrl` reaching `createPackageRsClient` (package path) AND `createRsClient` (standalone `client`-token path) is the internal base while `mcpServerOptions.providerUrl` (advertised) stays the public origin, plus fallback-to-public for both paths when no internal base is configured. The package and single-grant cases each FAIL on pre-fix code and PASS post-fix (proven by fault injection).
- [x] 3.3 Asserted the fallback: with no internal base configured (null/undefined), self-calls use the public resource (current behavior preserved) — both in the unit `fallback parity` test and the wiring `fallback` test.

## 4. Validation

- [x] 4.1 Ran `openspec validate route-hosted-mcp-adapter-self-calls-internally --strict` — valid.
- [x] 4.2 Ran the hosted MCP package adapter suites — `package-rs-client.test.js` (25), the new wiring test (2), `hosted-mcp-oauth.test.js` (28), `mcp-event-subscription-e2e.test.js` (2), `hosted-mcp-selection.test.js`/`hosted-mcp-picker-canonical-collapse.test.js` (21), and `@pdpp/mcp-server` (75) — all green, no regression in child-locate forwarding, source selection, ambiguity errors, or fan-out. tsc/ultracite clean on touched files.

## Acceptance checks

- `openspec validate route-hosted-mcp-adapter-self-calls-internally --strict` passes.
- Package-token `update_event_subscription` succeeds via the internal base in a harness where the public edge blocks PATCH (no `rs_error` `http_405`).
- Advertised `resource`/discovery metadata and `mcpServerOptions.providerUrl` still resolve to the public origin.
- With the internal-base env unset, adapter self-calls fall back to the public resource (no behavior change).
- Owner-only: a live `pdpp.vivid.fish` run confirms `update_event_subscription` succeeds under a real package token post-deploy (tracked as a Residual Risk until performed).
