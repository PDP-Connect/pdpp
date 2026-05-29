## 1. Config Plumbing

- [ ] 1.1 Add an optional internal resource-server base env (e.g. `RS_INTERNAL_URL`), defaulting to the loopback/service-DNS RS address already used by the web app (`http://reference:7663`); document it in the reference compose/config alongside `RS_PUBLIC_URL` and `PDPP_RS_URL`.
- [ ] 1.2 Resolve the internal base in `handleHostedMcp` (`reference-implementation/server/routes/rs-hosted-mcp.ts`) as a value distinct from the advertised public `resource`, falling back to the public `resource` when the env is unset.

## 2. Adapter providerUrl Split

- [ ] 2.1 Pass the resolved internal base to `createPackageRsClient` as the child fetch base (`providerUrl`) so each child `RsClient` issues self-calls against the internal address; keep `mcpServerOptions.providerUrl` and the advertised `resource` public.
- [ ] 2.2 Confirm the protected-resource discovery metadata (`setHostedMcpProtectedResourceMetadata`) and any issued-token audience/resource still resolve via `resolvePublicUrl` to the public origin; the internal base is fetch-only and never advertised.
- [ ] 2.3 Guard the internal base so it is operator-configured (loopback/cluster address), never request-derived from `Host`/`X-Forwarded-*`.

## 3. Regression Test

- [ ] 3.1 Add a regression test that issues a hosted MCP package token and calls `update_event_subscription` (PATCH) against a harness where the public edge returns 405 for PATCH but the internal base method-routes PATCH; assert the call succeeds and returns no `rs_error` `http_405`.
- [ ] 3.2 In the same test, assert the adapter self-call targets the internal base (not the public origin) while the advertised `resource`/discovery metadata and `mcpServerOptions.providerUrl` remain the public origin.
- [ ] 3.3 Assert the fallback: with the internal-base env unset, self-calls use the public resource (current behavior preserved).

## 4. Validation

- [ ] 4.1 Run `openspec validate route-hosted-mcp-adapter-self-calls-internally --strict`.
- [ ] 4.2 Run the hosted MCP package adapter test suite (`reference-implementation/test/package-rs-client.test.js` and the hosted-MCP route/oauth tests) and confirm no regression in child-locate forwarding, source selection, ambiguity errors, or fan-out.

## Acceptance checks

- `openspec validate route-hosted-mcp-adapter-self-calls-internally --strict` passes.
- Package-token `update_event_subscription` succeeds via the internal base in a harness where the public edge blocks PATCH (no `rs_error` `http_405`).
- Advertised `resource`/discovery metadata and `mcpServerOptions.providerUrl` still resolve to the public origin.
- With the internal-base env unset, adapter self-calls fall back to the public resource (no behavior change).
- Owner-only: a live `pdpp.vivid.fish` run confirms `update_event_subscription` succeeds under a real package token post-deploy (tracked as a Residual Risk until performed).
