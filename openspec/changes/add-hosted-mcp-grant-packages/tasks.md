## 1. Design And Validation

- [x] 1.1 Validate the grant-package OpenSpec change.
- [x] 1.2 Reconcile with `design-fast-broad-agent-consent` so the implementation follows the source-bounded package direction.

## 2. Storage And Auth Model

- [x] 2.1 Add grant-package and package-membership storage for SQLite and Postgres.
- [x] 2.2 Add package-bound access token issuance and introspection without weakening owner/client token boundaries.
- [x] 2.3 Extend OAuth refresh-token storage and exchange to support either a child grant or a grant package.
- [x] 2.4 Revoke package refresh tokens when the package is revoked.

## 3. Hosted MCP Consent

- [x] 3.1 Replace the one-source radio picker with a multi-source picker for hosted MCP default authorization.
- [x] 3.2 Render cumulative scope/risk copy that explains independent child grants.
- [x] 3.3 Approve selected sources by creating one child grant per source and one package-bound OAuth code.
- [x] 3.4 Preserve single-source OAuth authorization_details behavior.
- [x] 3.5 Present configured owner connections, not only connector types, and persist the selected connector_instance_id in each child grant's storage binding.

## 4. Resource Server Enforcement

- [x] 4.1 Add package-token resolution helpers that load active child grants.
- [x] 4.2 Make `/mcp` accept package-bound client tokens but continue rejecting owner tokens.
- [x] 4.3 Implement source-aware package behavior for `schema`, `list_streams`, `search`, `query_records`, `fetch`, and `fetch_blob` via the new `PackageRsClient` adapter that fans out per child or routes to a single child by `connection_id`.
- [x] 4.4 Ensure every package read routes through existing child-grant enforcement (each child request runs under its own scoped client bearer; no shared "package bearer" reaches the RS public read surface).
- [x] 4.5 Reject ambiguous connector-type source selectors when a package contains multiple connections for the same connector — typed `ambiguous_connection` (409) with `available_connections` candidate list.
- [x] 4.6 Narrow event-subscription routing for package tokens: `create_event_subscription` requires a `connection_id` selector when the package has >1 active child and binds the subscription to exactly one child grant; `list/get/update/delete/test_event` resolve the owning child via per-member probe so each call runs under that child's bearer; package never appears as a cross-source grant on persisted subscription rows.

## 5. Tests

- [x] 5.1 Test multi-source hosted MCP OAuth approval creates child grants plus a package token/refresh token. Covered end-to-end by `hosted-mcp-oauth.test.js` ("multi-source hosted MCP picker..."): drives the picker form, exchanges the resulting code at `/oauth/token` (asserts `grant_package_id` returned, no `grant_id`), refreshes the token, and confirms `/mcp` schema reads are source-tagged for both children before and after refresh.
- [x] 5.2 Test package `list_streams`/`schema` include source identity. (`package-rs-client.test.js`.)
- [x] 5.3 Test package `search` fans out and returns source-qualified results. (`package-rs-client.test.js`.)
- [x] 5.4 Test source-specific reads reject ambiguity (typed 409 with candidates) and enforce the selected child grant. (`package-rs-client.test.js`.)
- [x] 5.5 Test child-grant revocation removes only that source. Covered end-to-end by `hosted-mcp-oauth.test.js` ("revoking one child grant silently removes that source from the package /mcp fanout"): runs a baseline schema fanout with two children, calls `revokeGrant(spotifyChildGrantId)`, then asserts the post-revocation fanout drops to `member_count: 1`, surfaces only the github source in `data.package.sources`, and contains no spotify-tagged streams. The package itself remains active.
- [x] 5.6 Test package revocation invalidates package access and refresh. Covered end-to-end by `hosted-mcp-oauth.test.js` ("revoking the package invalidates /mcp access and the refresh-token exchange"): confirms the package token works before revocation, calls `revokeGrantPackage(packageId)`, then asserts `/mcp` rejects the bearer with a 401 challenge carrying the protected-resource metadata URL, and the refresh-token exchange returns `400 invalid_grant`.
- [x] 5.7 Test existing single-source hosted MCP OAuth continues to work. (`hosted-mcp-oauth.test.js` updated tool-list assertion + single-source flow unchanged.)
- [x] 5.8 Test the hosted MCP picker distinguishes duplicate connector instances and binds grants to the selected connection.
- [x] 5.9 Test structured MCP `query_records` filters serialize into the RS nested filter query shape.
- [x] 5.10 Test PackageRsClient event-subscription narrowing: create requires selector when multi-source, infers single-source, strips selector from RS body; list fans out and tags rows; get/delete locate owning child via per-member probe and forward under that child's bearer; unknown id returns typed `not_found`. (`package-rs-client.test.js`.)

## 6. Deployment

- [x] 6.1 Run targeted tests and typecheck.
- [x] 6.2 Build and deploy the reference image. (Owner-only.) `pnpm docker:reference:up` completed against `pdpp.vivid.fish` on 2026-05-28 and reported `reference-stack: ok`.
- [ ] 6.3 Smoke-test ChatGPT-compatible hosted MCP setup against `pdpp.vivid.fish`. (Owner-only.)

## 7. REST/MCP Parity Closeout

- [x] 7.1 Codify MCP-as-adapter-over-REST semantics in the design and spec.
- [x] 7.2 Route MCP search through a shared REST-read endpoint registry, including lexical, semantic, and hybrid modes.
- [x] 7.3 Forward structured MCP search filters through the same nested query serializer used by REST calls.
- [x] 7.4 Make hosted package fan-out preserve the selected REST search endpoint instead of hardcoding lexical search. The PackageRsClient now forwards each fan-out call through the path the MCP adapter selected, including `/v1/search`, `/v1/search/semantic`, and `/v1/search/hybrid`.
- [x] 7.5 Centralize legacy local connector identity equivalence outside hosted-MCP picker code.
- [x] 7.6 Add regressions for search mode routing, filter forwarding, and centralized connector identity.
- [x] 7.7 Validate OpenSpec, targeted MCP/reference tests, and reference typecheck.
- [x] 7.8 Build, deploy, and smoke-test the updated hosted MCP path. (Owner-only.) Verified `/.well-known/oauth-protected-resource/mcp` advertises `pdpp_token_kinds_supported: ["client", "mcp_package"]`, `/mcp` fails closed with `401` without a bearer, and dashboard routes load behind owner auth.
