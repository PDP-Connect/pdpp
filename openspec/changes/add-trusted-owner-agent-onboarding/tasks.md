## 1. Boundary Audit

- [x] 1.1 Audit the current deployment-token/device-approval flow, root pointer, protected-resource metadata, `/mcp` owner-bearer rejection, and `/v1/*` owner-bearer reads; record any gaps in `design.md`.
- [x] 1.2 Inspect `~/applications/daisy` for existing credential/config conventions without printing secrets, then decide the first supported local credential target.
- [x] 1.3 Update `design.md` with the final owner-agent vocabulary and any Daisy-specific constraints found during the audit.

## 2. Discovery Metadata

- [x] 2.1 Extend the reference-contract metadata schemas to allow a `pdpp_owner_agent_onboarding` advisory block with owner-agent profile, approval, token, schema, query, revocation, and event-subscription links.
- [x] 2.2 Emit the owner-agent advisory block from `GET /` and `GET /.well-known/oauth-protected-resource` only when owner-agent onboarding is safely configured.
- [x] 2.3 Preserve forwarded-origin safety: owner-agent metadata must use the caller-visible public origin and omit the block rather than advertising an untrusted host.
- [x] 2.4 Add metadata tests covering present, omitted, and forwarded-origin cases.

## 3. Approval And Credential Handoff

- [x] 3.1 Add a first-class owner-agent bootstrap path that uses browser/dashboard owner approval and does not require pasting bearer material into chat or terminal transcripts.
- [x] 3.2 Write the issued owner-agent credential to the chosen local credential target with restrictive file permissions and non-secret status output.
- [ ] 3.3 Update the dashboard deployment-token surface so the smooth owner-agent path is prominent and the bearer-copy/debug path is clearly secondary.
- [x] 3.4 Preserve introspection and RFC 7592 client-delete revocation for owner-agent credentials, with tests proving revoked credentials stop working.

## 4. Route Boundary And REST Semantics

- [x] 4.1 Add or refresh tests proving valid owner-agent bearers can read owner-visible `/v1/schema`, `/v1/streams`, and representative record/search/blob metadata routes.
- [x] 4.2 Add or refresh tests proving `/mcp` rejects owner-agent bearers with a clear recovery hint toward grant-scoped MCP or owner-agent REST onboarding.
- [x] 4.3 Verify owner-agent credentials do not expand `/_ref/*` bearer behavior beyond the routes that already support owner bearer auth or owner-session auth.

## 5. Token-Efficient Local Agent Guidance

- [x] 5.1 Add owner-agent guidance separate from `pdpp-data-access` that teaches metadata-first discovery, schema/stream inspection, `connection_id`, cursors, `changes_since`, pagination, declared filters, field projection, and blob-by-reference reads.
- [x] 5.2 Add a Daisy-focused runbook that starts from an entrypoint URL, completes approval, stores the local credential, performs initial sync, then performs incremental sync.
- [x] 5.3 Document the callback decision: use event subscriptions only with a durable valid-TLS HTTPS receiver; otherwise use cursor polling with backoff.
- [x] 5.4 Add a guard or doc check that ordinary grant-scoped agent guidance still does not recommend owner bearers as the default path.

## 6. Acceptance Checks

- [ ] 6.1 `openspec validate add-trusted-owner-agent-onboarding --strict`
- [ ] 6.2 `openspec validate --all --strict`
- [ ] 6.3 Run a local reference-stack smoke proving metadata discovery, owner-agent credential issuance, introspection, `/v1` owner reads, `/mcp` rejection, and revocation.
- [ ] 6.4 Run a Daisy or Daisy-equivalent local-agent smoke that starts from the entrypoint URL and reaches schema/stream discovery without manual route guessing.
- [ ] 6.5 Record any owner/live-only residuals in `design.md` before closeout instead of leaving pseudo-open implementation tasks.
