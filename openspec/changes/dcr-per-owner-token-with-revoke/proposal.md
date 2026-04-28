# DCR-per-token for owner self-export bearers, with revocation

## Why

The dashboard's Tokens page mints owner self-export bearers via the canonical RFC 8628 device flow against a single shared bootstrap public client (`pdpp-web-dashboard`). Two consequences make this inadequate for any deployment beyond a single-bearer demo:

1. **Operators cannot list their issued tokens.** The dashboard tracks issuance in process-local memory only; tokens disappear from the UI on every dev-server restart and were never persisted at the dashboard layer.
2. **Operators cannot revoke an individual token.** All bearers minted from the dashboard share the same `client_id`, so there is no per-token identity to disable. Revoking the shared client would invalidate every operator-issued bearer at once.

The plumbing for fixing this already exists: PDPP supports OAuth 2.0 Dynamic Client Registration (RFC 7591) on `POST /oauth/register`, the `oauth_clients` table records `client_name`, and `registration_mode` distinguishes dynamic from pre-registered clients. What's missing is per-token DCR usage from the dashboard plus the management protocol (RFC 7592) to delete a registered client and cascade-revoke its outstanding bearers.

## What Changes

- **AS — RFC 7592 client deletion.** Add `DELETE /oauth/register/{client_id}`, owner-session-gated, idempotent. Cascades to revoke every `grants` row with that `client_id` via the existing `revokeGrant` codepath and every owner self-export token row with that `client_id` via token revocation. Emits `client.deleted` and per-grant `grant.revoked` spine events.
- **AS — operator-issued client listing.** Add `GET /_ref/clients?owner=true`, owner-session-gated. Returns `oauth_clients` rows where `registration_mode = 'dynamic'` and a per-client AS-stamped `issuer_subject_id` matches the requesting owner session's subject, with `name`, `created_at`, and `active_token_count`.
- **AS — issuer-subject metadata on dynamic clients.** When `POST /oauth/register` carries a valid owner session, stamp the registered client metadata with `issuer_subject_id = <owner session subject>` so `_ref/clients?owner=true` can filter to the current operator. Ignore any caller-supplied subject value.
- **Dashboard BFF — DCR per token.** `issueOwnerTokenAction` registers a new dynamic client with `client_name = <operator-supplied name>` using the owner session cookie; the AS stamps the subject, then the dashboard runs the RFC 8628 device flow against the freshly-issued `client_id`. The shared bootstrap client (`pdpp-web-dashboard`) stays registered for backward compatibility but the dashboard no longer mints against it.
- **Dashboard — Tokens list view.** The Tokens page reads `_ref/clients?owner=true`, lists each operator-issued client with its name, issued-at, and a Revoke button. The form to issue a new token stays at the top.
- **Dashboard — Revoke action.** Server Action that calls `DELETE /oauth/register/{client_id}` with the owner session cookie.

## Capabilities

### Modified

- `reference-implementation-architecture`: extend the OAuth surface with RFC 7592 client deletion, per-operator client metadata, and a reference-only client-listing endpoint. Document that owner self-export bearers are issued against per-token DCR clients so they are individually revocable.

## Impact

- **Standards alignment.** Adopts the IETF-blessed pattern (RFC 7591 + 7592) for named, revocable, per-credential identities. Matches what GitHub Apps, Solid service accounts, MCP M2M identities, and Kinde do — every comparable system uses per-credential identity, not per-token database labels. Avoids inventing a vendor-flavored `name` column on the `grants` table.
- **Security.** Per-token revocation closes the "all-or-nothing" rotation gap. Owner-session gate on registration with `issuer_subject_id` and on deletion prevents cross-operator token enumeration or revocation in multi-operator deployments. No widening of the third-party client registration surface.
- **Compatibility.** `pdpp-web-dashboard` stays as a pre-registered client for the BFF's invisible mint helper (`mintOwnerToken`). No existing `/oauth/register`, `/oauth/token`, `/grants/*/revoke`, or `_ref/grants` contract changes; only additions.
- **Operational.** Each dashboard-issued owner token now creates one `oauth_clients` row plus one `tokens` row. For an operator who issues a few tokens this is negligible; for any deployment that issues tokens programmatically at scale, an operator should rotate via `DELETE /oauth/register/{client_id}` to clean up.
