## Context

The hosted MCP adapter is an adapter over the same REST resource-server contract. For a package token, `createPackageRsClient` builds one child `RsClient` per active member and routes each MCP tool call into the same REST endpoints under exactly one child grant's bearer (locate-owning-child for event subscriptions, source-required for record/blob reads, fan-out for schema/streams/search/list).

Today both the advertised resource and the adapter's fetch base are the single value `resource = resolvePublicUrl(req, explicitResource)`:

- `reference-implementation/server/routes/rs-hosted-mcp.ts:176` — `const resource = resolvePublicUrl(req, explicitResource)` resolves to the public origin (`RS_PUBLIC_URL`).
- `:188-192` — `createPackageRsClient({ providerUrl: resource, members, … })`. Each child `RsClient` (`packages/mcp-server/src/rs-client.js`) issues real HTTP fetches to `providerUrl + path`.
- `:194` — the same public `resource` is the advertised `providerUrl` on `mcpServerOptions`.

So a self-call from the adapter to its own resource server exits the process to the public origin and hairpins through the external reverse proxy. The proxy fronting `pdpp.vivid.fish` is host-level (Traefik/Coolify); it is not in this repo's compose, and it drops the PATCH method (measured `PATCH → 405` on every public path; GET/POST/DELETE pass). The resource server directly at `http://reference:7663` (or `127.0.0.1:7663`) method-routes the same PATCH and returns 401 (auth-gated), proving the server supports PATCH and only the edge blocks it.

This is the construction error: the advertised identity (what clients should call) and the internal fetch base (where the server reaches itself) are the same value, so a server-internal operation inherits public-edge method policy.

## Goals / Non-Goals

**Goals:**

- Make hosted MCP package-adapter self-calls use a trusted internal resource-server base, removing the public-edge hairpin from all server-internal forwarding (fixes the PATCH 405 and hardens GET/POST/DELETE/fan-out).
- Keep the advertised `resource`, discovery metadata, and `providerUrl` public so clients still discover and call the correct public endpoint.
- Keep the change behind one optional env so deployments without an internal base are unaffected.

**Non-Goals:**

- Do not change the reverse proxy. An edge that allows PATCH is an acceptable independent stopgap, not a prerequisite or a dependency of this change.
- Do not change token kinds, OAuth/discovery flows, child-locate semantics, source selection, ambiguity errors, or per-grant enforcement.
- Do not introduce internal-base routing anywhere the advertised public origin is the contract (discovery, resource metadata, issued token audiences). The standalone (`client`-token) hosted MCP path now ALSO uses the internal base for its single-bearer self-calls (same internal-base preference as the package path), but its advertised metadata likewise stays public. (Updated: an earlier revision scoped this change to the package adapter only and listed the standalone path as a Non-Goal "may be applied for consistency"; that consistency extension is now part of this change — see the standalone scenario in the spec delta and the single-grant wiring test.)

## Decisions

### 1. Prefer an internal base for adapter self-calls; fall back to public

The hosted MCP package adapter SHALL build its child `RsClient` fetch base from the **existing explicitly configured** internal resource-server base — `opts.rsInternalUrl` or the operator's `PDPP_RS_URL` — and SHALL fall back to the advertised public `resource` only when no explicit internal base is available. Concretely, `startServer` computes `explicitRsInternalUrl` from those inputs and passes it into `buildRsApp`; `handleHostedMcp` then passes that value to `createPackageRsClient` as the child fetch base, distinct from the advertised public `resource`.

**No new env is introduced.** Reuse the established `PDPP_RS_URL` → `rsInternalUrl` config when it is explicitly supplied by the operator or test harness. The bare topology default (`http://localhost:7663`) is not treated as an adapter internal base. The reference compose sets `PDPP_RS_URL: http://127.0.0.1:7663` on the `reference` service so the adapter can reach its own RS listener without the public edge; the `web` service keeps its existing `PDPP_RS_URL: http://reference:7663` BFF-to-RS hop. Inventing a parallel `RS_INTERNAL_URL` was rejected — it would duplicate `PDPP_RS_URL`/`rsInternalUrl`.

**Explicit-config only (refinement learned during implementation):** the adapter honors the internal base ONLY when it is *explicitly* configured — `opts.rsInternalUrl` (set by callers) or the operator's `PDPP_RS_URL` env. It does NOT use the bare `reference-topology` default (`http://localhost:7663`) as the adapter's internal base, because in-process test harnesses (and any deployment that does not set `PDPP_RS_URL`) bind the RS to an ephemeral port, so the bare default would not point at the live RS and self-calls would fail to connect (the design's named risk). When no explicit internal base applies, `internalResource` is `null` and the adapter falls back to the advertised public `resource` — exactly the "no internal base configured → public resource, current behavior preserved" fallback scenario. Real deployments set `PDPP_RS_URL` (the reference compose does), so they get the internal-base routing; default/test setups are unchanged.

Alternatives considered:

- Reuse the public origin for self-calls (status quo): rejected — it is the root cause of F1 and keeps adapter correctness coupled to edge method policy, TLS hairpin, and proxy latency.
- Fix only the PATCH path (rewrite just `update_event_subscription` to use an internal base): rejected — the fragility applies to every self-call; a per-method patch leaves GET/POST/DELETE/fan-out still hairpinning and invites the next edge-policy regression.
- Configure the proxy to allow PATCH instead of changing code: acceptable as an independent stopgap (Option A in F1), but it does not remove the architectural hairpin and is out of this repo's scope; this change does not depend on it.

### 2. Discovery and resource metadata remain public

The advertised `resource`, the protected-resource discovery metadata (`/.well-known/oauth-protected-resource`), and the `providerUrl` advertised on `mcpServerOptions` SHALL continue to resolve to the public origin via `resolvePublicUrl`. Clients discover and call the public endpoint; only the adapter's server-internal fetch base differs. The internal base is never advertised, never written into issued tokens' audience/resource, and never returned in discovery responses.

This keeps the public contract identical: a client cannot tell that the adapter reaches itself internally, and the internal address never leaks to untrusted callers.

### 3. Security — the internal base must be a trusted loopback/cluster address

The configured internal base SHALL be a trusted, server-controlled address: loopback (`127.0.0.1`/localhost) or an internal cluster/service-DNS name (e.g. `reference:7663`) reachable only inside the deployment's private network. It SHALL NOT be set to an attacker-influenceable or request-derived value: it is operator configuration, not derived from request headers (`Host`, `X-Forwarded-*`) the way the public origin can be. Because the adapter already attaches each child grant's bearer to the self-call, the internal base does not widen authority — every internal call is still authorized only by an active child grant and still subject to the resource server's per-grant enforcement.

## Risks / Trade-offs

- **Misconfiguration points the internal base at the public edge** → still hairpins and can still hit the PATCH 405. Mitigation: do not infer an internal base from request headers or the bare topology default; document that an explicit internal base must be a private/loopback address; the regression test asserts self-calls hit the configured internal base, not the public origin.
- **Internal base diverges from the live RS (wrong host/port)** → self-calls fail to connect. Mitigation: compose sets the reference service's explicit `PDPP_RS_URL` to its own loopback RS listener (`http://127.0.0.1:7663`) and the stack verifier fails if `PDPP_RS_URL` is absent or equal to `RS_PUBLIC_URL`; treat a connect failure as a typed RS error like any other, and keep the public fallback only for unset config.
- **Drift between advertised and internal identity confuses future readers** → Mitigation: spec and design state explicitly that advertised identity is public and the internal base is fetch-only; the two values are named distinctly at the call site.
- **Standalone (non-package) token path** → Resolved: this change now applies the same internal-base preference to the standalone (`client`-token) path's single-bearer `RsClient` as well as the package path's child clients, so a `client`-token `update_event_subscription` PATCH avoids the public-edge 405 too. Advertised metadata stays public in both paths.

## Non-Goals

- No reverse-proxy/edge configuration change is required by this change.
- No change to the public contract: discovery, resource metadata, issued-token audience, token kinds (`client`, `mcp_package`), child-locate forwarding, source-selection, and per-child enforcement are unchanged.

## Acceptance checks

- `openspec validate route-hosted-mcp-adapter-self-calls-internally --strict` passes.
- Regression tests drive hosted MCP package-token and standalone client-token self-calls against harnesses where the public edge rejects PATCH (405) but the configured internal base method-routes it; the package update call succeeds (no `rs_error` `http_405`), and both token paths observe the self-call base as internal while advertised identity remains public.
- The advertised `resource`/discovery metadata and `mcpServerOptions.providerUrl` still resolve to the public origin in the same test.
