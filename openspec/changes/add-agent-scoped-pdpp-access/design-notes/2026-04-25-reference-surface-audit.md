# Reference Surface Audit For Agent-Scoped Access

Status: captured
Owner: agent-scoped-pdpp-access worker
Created: 2026-04-25
Updated: 2026-04-25
Related: `openspec/changes/add-agent-scoped-pdpp-access/`

## Question

Which reference HTTP, CLI, and metadata surfaces already support an agent-scoped grant flow, which need only orchestration, and which would require new wire fields? This memo answers that so the implementation tranche can prefer reuse over invention.

## Reference HTTP Surface (already shipped)

Auth server (AS) — see `reference-implementation/server/index.js` and `server/auth.js`:

- `GET /.well-known/oauth-authorization-server` — advertises `pushedAuthorizationRequestEndpoint`, `tokenEndpoint`, `deviceAuthorizationEndpoint`, optional `registrationEndpoint`, plus `pdpp_provider_connect_capabilities`.
- `POST /oauth/register` — RFC 7591-style dynamic client registration. Returns `{ client_id, client_id_issued_at, token_endpoint_auth_method, client_name, … }`. Reference protects this with an initial-access token; a personal-deployment AS can accept the registration with no owner auth.
- `POST /oauth/par` — the agent-scoped grant request entry point. Accepts a JSON body with `client_id`, optional `client_display`, and `authorization_details[]` describing source (`connector_id` or `provider_id`), `purpose_code`, `purpose_description`, `access_mode`, and `streams[]`. Returns `{ request_uri, authorization_url, expires_in }`.
- `GET /consent?request_uri=…` — the owner-facing approval shell. Renders the staged grant request behind the owner session.
- `POST /consent/approve` and `POST /consent/deny` — owner-session-protected; on approve returns `{ grant_id, token, grant }` for JSON callers.
- `POST /grants/:grantId/revoke` — revoke an existing grant.
- `POST /introspect` — RFC 7662 introspection; returns token_kind, grant_id, scope, expiry, revocation status.
- Owner-only device flow: `POST /oauth/device_authorization` and `POST /oauth/token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`). This is the *owner-token* path, not the agent path.

Resource server (RS) — same file:

- `GET /.well-known/oauth-protected-resource` — points at AS metadata and advertises capabilities (`pdpp_self_export_supported`, `pdpp_token_kinds_supported`, etc.).
- `GET /v1/schema` — token-bound capability and stream discovery; the canonical "what can this grant see?" call. Distinguishes owner vs. client bearer in its `bearer` block.
- `GET /v1/streams`, `GET /v1/streams/:stream`, `GET /v1/streams/:stream/records[/:id]`, `GET /v1/streams/:stream/aggregate`.
- `GET /v1/search`, optional `GET /v1/search/semantic`, `GET /v1/search/hybrid`.
- `GET /v1/blobs/:blob_id`.

Reference-only:

- `GET /_ref/grants/:grantId/timeline` — used by `pdpp grant timeline`. Reference inspectability, not part of the public PDPP wire contract.

## Existing CLI Surface

`reference-implementation/cli/index.js` exposes:

- `pdpp auth login` — RFC 8628 device flow that mints an **owner** token (`pdpp_token_kind=owner`). This is the surface the change wants agents to stop using by default.
- `pdpp auth introspect --token <token>` — works for any token kind.
- `pdpp grant start <path-or-->` — POSTs a JSON body to `/oauth/par`. Returns `request_uri` and `authorization_url`. Does not poll for approval, does not cache anything, does not exchange for a token.
- `pdpp grant revoke <grant-id>`.
- `pdpp grant timeline <grant-id>` — reference-only.
- `pdpp provider register …` — dynamic client registration for clients holding an initial-access token.
- `pdpp owner …`, `pdpp query …`, `pdpp run timeline`, `pdpp inspect`, `pdpp seed`, `pdpp trace show` — orthogonal to the agent flow.

## Surface Map: Reuse Vs. New

| Concern | Existing surface | Status for this tranche |
| --- | --- | --- |
| Discover AS/RS metadata | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | Reuse. CLI already discovers via `lib/discovery.js`. |
| Register a project-local client | `POST /oauth/register` | Reuse. Personal deployments can register without an owner credential when AS allows. |
| Stage a scoped grant request | `POST /oauth/par` | Reuse. `pdpp grant start` already wraps it. |
| Communicate approval URL to owner | `request_uri` + `authorization_url` returned by PAR; consent shell at `/consent` | Reuse. CLI already prints the PAR result; the new helper just needs to format it for human + tmux relay. |
| Owner approve/deny | `/consent/approve`, `/consent/deny` | Reuse. Owner UX work is owned by a separate lane. |
| Get the issued client token | Owner approval response includes `token` and `grant_id` (JSON form). No public *poll-for-approval* endpoint exists today. | **Gap.** Reference currently expects the owner approval response to deliver the token, or the agent to introspect a token after pasting it from hosted UI. There is no agent-side polling endpoint analogous to RFC 8628 `/oauth/token` for a PAR-issued client grant. |
| Cache grant metadata + token locally | None. CLI never persists tokens. | **Gap.** This change adds `.pdpp/` cache. |
| Inspect grant scope | `POST /introspect`, `GET /v1/schema` | Reuse for runtime validation. |
| Revoke or forget | `POST /grants/:grantId/revoke` | Reuse. |

## The "Wait For Approval" Gap

The biggest reference-side gap is that an agent that calls `/oauth/par` cannot durably learn when the owner has approved. Today the only ways to get the issued client token are:

1. The owner approves in the hosted consent UI and pastes the token back (the third-party-app example does this).
2. The caller uses `approveInline` against `/consent/approve` directly, which only works when the AS has owner-auth disabled.

A safe, agent-friendly resolution would be a polling endpoint where the client presents the `request_uri` (or a derived `device_code`) and the AS returns `{ status: pending | approved | denied | expired, grant_id?, token? }` once the owner has acted. The data substrate already supports this — `getPendingConsent(deviceCode)` and `approveGrant(deviceCode, …)` know the state. Exposing that as `GET /oauth/par/:requestUri/status` (or a new `request_status_endpoint` advertised in metadata) is a reference-only first step; promoting it to PDPP normativity needs separate spec review.

This worker is **not** adding that endpoint in this slice. The skill and CLI guidance treat the gap honestly: an agent prints the approval URL, asks the owner to confirm in-channel, and either accepts a pasted token or re-introspects on the next interaction. The gap is captured here so the next worker can propose it cleanly.

## Cache Shape (proposed)

Project-local, gitignored. Default root: `<repo>/.pdpp/`.

```text
.pdpp/
  agent-access.json          # non-secret: AS/RS URLs, project label, last activity
  clients/<client-id>.json   # non-secret: client metadata returned by /oauth/register
  grants/<grant-id>.json     # non-secret: grant metadata (source, streams, fields, retention, expiry)
  tokens/<grant-id>.token    # secret: opaque client token; mode 0600
```

Rules:

- Token files are written with `mode: 0o600`. Directories are written with `mode: 0o700`.
- Status output (`pdpp agent status`, when implemented) reads `agent-access.json` and `grants/*.json`; it MUST NOT read `tokens/*.token`.
- `.gitignore` is updated only if it exists and does not already cover `.pdpp/`. The repo's existing `.gitignore` already lists `packages/polyfill-connectors/.pdpp-data/` but not a top-level `.pdpp/`; the CLI helper should append a single `.pdpp/` line guarded against duplicates.
- The cache is a *convention*, not a wire contract. Other agent harnesses are free to use a different layout as long as they keep tokens out of repo and prompts.

## Protocol-Candidate Items (do not finalize here)

- A request-status endpoint for PAR-staged client grants (gap above). Reference-only candidate.
- A "purpose context" field that carries project path and agent identity into the consent UI. The consent renderer already shows `client_display.name` from registration; carrying a richer `client_display.context` block is optional and reference-only until proposed.
- A retention/lifetime field on `authorization_details[]`. The current schema accepts `access_mode` (`single_use`, `time_bounded`, etc.); explicit `retention_days` and `renewable` would help agents request narrowly. Treat as candidate, not as part of this slice.

## Conclusion

Almost everything the agent flow needs is already in the reference. The shipped tranche is best limited to:

1. The `pdpp-data-access` skill (this worker), at `docs/agent-skills/pdpp-data-access/`.
2. A documented project-local cache shape (this memo + skill references).
3. A future `pdpp agent` CLI command group that orchestrates register → PAR → owner relay → poll/paste → cache → introspect. Out of scope for this slice; sketched only as commented helper docs if added later.

New wire fields are deferred. The owner-token escape hatch remains available but the skill discourages it.

### Skill location note

The proposal suggested `skills/pdpp-data-access/SKILL.md`. That path is a hard collision: the repo's root `.gitignore` reserves `skills/` for the upstream skills installer (see `setup.sh` and the dotfiles flow), so anything under `skills/` will not commit. Rather than carve a `!skills/pdpp-data-access/` exception (which would compete with installer state), the skill is committed at `docs/agent-skills/pdpp-data-access/`. That path:

- is tracked,
- groups with other long-form repo guidance under `docs/`,
- avoids any conflict with the upstream skills installer pipeline,
- and can still be linked from agent harnesses that load skills from arbitrary paths.

If a future tranche wants `skills/` to be a tracked path for repo-local skills, that's a separate `.gitignore` decision and not gated on this change.

## Prior-Art Checks

Before finalizing the skill or proposing CLI surfaces, this audit was cross-referenced against the following. Each item lists what we keep, what we deliberately don't keep, and any follow-up that should be promoted.

### OAuth RAR (RFC 9396 — Rich Authorization Requests)

- **Keep:** the reference `authorization_details[]` shape already follows RAR. Each entry has a `type` URI (`https://pdpp.org/data-access`) and source/scope-shaped fields. The skill's grant-design guidance — narrow `streams[]`, narrow `fields`, time-bounded `access_mode`, owner-readable `purpose_description` — is the RAR pattern in practice.
- **Don't keep:** RAR encourages including `actions[]`, `locations[]`, `datatypes[]`. The reference doesn't accept those today. The skill avoids referencing them so agents don't try to send fields the AS will drop or reject.
- **Promote candidate:** explicit `actions[]` (e.g., `["read.records", "read.aggregate"]`) as a separable scope axis. Not in this tranche; flagged as protocol-candidate.

### OAuth PAR (RFC 9126 — Pushed Authorization Requests)

- **Keep:** the reference is already PAR-native. `POST /oauth/par` returns a `request_uri` and a hosted `authorization_url`, and the consent shell only accepts requests whose body was pre-staged through PAR. The skill never tells agents to embed scope in URL query parameters.
- **Don't keep:** the RFC's optional `request` JWT form. The reference accepts plain JSON.
- **Notes:** RFC 9126 also recommends short PAR lifetimes (60–600s). The reference uses 300s. The skill warns the owner-relay step that the URL expires in ~5 minutes.

### OAuth Device Authorization Grant (RFC 8628)

- **Keep:** as the *owner-token* fallback only. `pdpp auth login` already implements RFC 8628. The skill explicitly does not recommend this path for routine agent work.
- **Don't keep:** the device-flow polling pattern (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) for client grants. The reference's PAR-staged flow does not yet expose a polling endpoint with comparable semantics.
- **Promote candidate:** a polling endpoint for PAR-staged client grants modeled on RFC 8628's polling response (`authorization_pending` / `slow_down` / token). Reference-only first; this is the biggest UX gap and is captured as a candidate above.

### Dynamic Client Registration (RFC 7591)

- **Keep:** the reference `POST /oauth/register` already implements 7591. The skill uses it directly, with `token_endpoint_auth_method: "none"` for public clients (consistent with native/CLI app registration patterns).
- **Don't keep:** RFC 7592 (client configuration management). The reference doesn't expose `registration_client_uri`, and the skill doesn't try to PUT/DELETE registrations. Project-local clients are append-only from the agent's view; the user prunes via the dashboard.

### MCP Authorization Spec — local public clients with PKCE/DCR

- **Keep:** MCP's posture for local agent clients is the right posture here: dynamic client registration on first use, public client (`token_endpoint_auth_method: "none"`), PKCE-where-applicable, ephemeral storage scoped to the project. The skill matches this.
- **Don't keep:** PKCE in the immediate flow. Today's reference flow uses PAR + hosted approval, not the authorization-code redirect that PKCE protects. **If** the reference later adds an authorization-code path for browser-based agent UIs (likely for web operator UIs), PKCE becomes mandatory. Captured as a protocol-affecting candidate, not part of this slice.
- **Notes:** MCP also pushes for short-lived tokens. The skill defaults `access_mode` to `time_bounded` partly for that reason.

### GitHub fine-grained tokens — UX

- **Keep:** the consent UI's per-resource scoping mental model. GitHub's fine-grained tokens force the user to pick *which repos* and *which permissions*; PDPP's equivalent is `connector_id` + `streams[]` + `fields[]`. The skill's "owner-readable purpose strings" section is modeled on the GitHub consent screen's "this token will be able to: …" copy.
- **Don't keep:** GitHub's expiration-required UI. The reference allows `continuous` `access_mode`. The skill discourages it by default but does not refuse to use it when the user has explicitly asked for an ongoing assistant.

### Google ADC (Application Default Credentials) — local credential cache

- **Keep:** the rough idea of a well-known local file with restrictive permissions (`~/.config/gcloud/application_default_credentials.json`, mode `0600`). The cache shape proposed here mirrors the spirit: known location, predictable shape, restricted mode, never committed.
- **Don't keep:** Google's home-directory location. Project-local is the right boundary for an agent assisting in *this* repo. ADC's home-dir model is convenient but defeats the project-scoped-consent story PDPP exists to provide. Captured as an explicit divergence.
- **Notes:** ADC also caches `quota_project_id` and metadata that the consent flow already saw. The proposed `agent-access.json` is the analogue.

### GitHub CLI — login/cache patterns

- **Keep:** browser-first auth, fall back to a paste-the-code flow when a browser isn't available, and store the resulting token in the OS keychain when present (file fallback otherwise). The skill's "relay the approval URL" step matches `gh auth login`'s behavior almost line-for-line.
- **Don't keep:** OS-keychain integration in this tranche. The reference is pre-1.0 and writing to keychains varies by platform. The skill's `0600` file is the agreed default; keychain integration is a future enhancement, not a protocol concern.

### AWS CLI v2 SSO — login/cache patterns

- **Keep:** the explicit "session token expires; re-login" model. PDPP client tokens expire and are not refreshable in the current reference; the skill's renew-or-re-grant guidance is the AWS SSO pattern.
- **Don't keep:** AWS's `~/.aws/sso/cache` location. Same reason as ADC — project-local boundary preferred for agent work.

### Anthropic Claude Skills — official docs

- **Keep:** the SKILL.md frontmatter format (`name`, `description`), top-level imperative voice, "this skill does X when Y" phrasing in the description, hard rules near the top, and a `references/` subfolder for material that's costly to load up front. The skill matches this shape.
- **Don't keep:** any platform-specific assumptions (e.g., file-system tools, Bash availability). The skill's curl examples are illustrative; the rules apply regardless of which tool the agent uses to make HTTP calls.

## Protocol Candidates Summary

The following items would change durable PDPP semantics if accepted. They are flagged here as **proposed/experimental** only; none are introduced as wire-finalized in this tranche.

| Candidate | Source of pressure | Status |
| --- | --- | --- |
| Polling endpoint for PAR-staged client grants (`GET /oauth/par/:requestUri/status` or equivalent) | RFC 8628 parity, real agent UX gap | Proposed; reference-only when implemented |
| `actions[]` axis on `authorization_details[]` | RFC 9396 RAR completeness | Proposed; not implemented |
| Authorization-code + PKCE path for browser-resident agent UIs | MCP authorization guidance | Out of scope here; future change |
| Explicit `retention_days` / `renewable` on `authorization_details[]` | Owner-readable consent + GitHub fine-grained UX | Proposed; not implemented |
| Richer `client_display.context` (project path, agent identity) for the consent screen | Approval UX work in this change | Reference-only candidate; needs companion-spec review before normativity |

If implementation work in any later tranche needs one of these, the worker that picks it up should write a separate proposal rather than expanding this change.
