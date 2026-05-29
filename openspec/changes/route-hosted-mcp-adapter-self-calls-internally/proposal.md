## Why

The hosted MCP package adapter forwards every child-grant self-call back out to the public origin. `handleHostedMcp` builds the package RS client with `providerUrl = resolvePublicUrl(req, …)` (`RS_PUBLIC_URL`, e.g. `https://pdpp.vivid.fish`), and `createPackageRsClient` constructs each child `RsClient` against that public base. So a server-internal self-call leaves the process, hairpins through the external reverse proxy, and re-enters the same resource server.

That edge fronting the public origin blocks the PATCH method (PATCH returns 405 on every public path). The resource server itself supports PATCH — directly at the internal address (`http://reference:7663`) the same PATCH is method-routed and auth-gated (401). The result is finding F1: under a hosted MCP package token, `update_event_subscription` (→ `PATCH /v1/event-subscriptions/:id`) returns a typed `rs_error` `http_405`, while create/list/get/delete (GET/POST/DELETE) succeed because the edge allows those methods.

Routing server-internal self-calls out through the public edge is also architecturally fragile beyond this one method: it couples the adapter to edge method/policy decisions, adds a TLS hairpin and proxy latency, and makes the adapter's correctness depend on a proxy that is not in this repo. The adapter has no internal-RS-URL option today, even though an internal address already exists and is used by the web app (`PDPP_RS_URL: http://reference:7663`).

The archived `2026-05-28-add-hosted-mcp-grant-packages` change specs child-locate forwarding but says nothing about internal-vs-public URL routing for adapter self-calls, so this fix needs an OpenSpec change before implementation.

## What Changes

- The hosted MCP package adapter SHALL prefer a configured internal resource-server base URL for its child-grant self-calls (locate/get/list/create/update/delete/test-event and record/blob/stream/search/schema fan-out), falling back to the advertised public resource when no internal base is configured.
- The advertised `resource`, protected-resource discovery metadata, and the MCP server's advertised `providerUrl` SHALL continue to use the public origin. Only the adapter's internal fetch base changes.
- No change to token kinds, OAuth/discovery flows, child-locate semantics, source selection, ambiguity errors, or the per-child enforcement model.

## Capabilities

### Modified

- `agent-consent-bundling`: the hosted MCP package adapter SHALL forward child-grant self-calls to a configured internal resource-server base URL when present, falling back to the advertised public resource; advertised resource/discovery metadata remains the public origin.

## Impact

- Config: **no new env.** Reuses the existing explicit `PDPP_RS_URL` → `referenceTopology.rsInternalUrl` (and `opts.rsInternalUrl`) internal resource-server address the web app already targets. The internal base is honored only when explicitly configured; when it is not (e.g. default/test setups that bind the RS to an ephemeral port), the adapter falls back to the public resource and behavior is unchanged. See design Decision 1.
- Code: `handleHostedMcp` / `createPackageRsClient` split the advertised public `resource` from the adapter's internal fetch base. The advertised `providerUrl` on `mcpServerOptions` stays public.
- No change to the public contract: discovery metadata, token kinds (`client`, `mcp_package`), child-locate forwarding, and per-child enforcement are unchanged.
- No reverse-proxy change is required by this change (an edge that allows PATCH is an acceptable independent stopgap, not a dependency).
- Requires a regression test proving package-token `update_event_subscription` succeeds via the internal base even when the public edge blocks PATCH.

## Residual Risks

- End-to-end validation against the live `pdpp.vivid.fish` deployment (real hosted MCP package token issuing `update_event_subscription` and observing success post-fix) is an owner-only live run. The protocol-side guarantee — adapter self-calls use the internal base, advertised metadata stays public, and a PATCH that the public edge would 405 succeeds internally — is covered by the regression test in this change.
