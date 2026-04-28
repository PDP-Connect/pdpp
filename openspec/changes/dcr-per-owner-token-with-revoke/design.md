# Design — dcr-per-owner-token-with-revoke

## Context

The Tokens page (`/dashboard/deployment/tokens`) currently mints owner self-export bearers through the canonical RFC 8628 device flow against a single shared bootstrap public client (`pdpp-web-dashboard`, registration_mode `pre_registered_public`). Operator-supplied token names (`name` on `OwnerBootstrapFlow`) live in the BFF process's in-memory `__pdppOwnerBootstrapFlows` map and disappear on every restart. There is no list of issued tokens and no per-token revoke.

The minimal "vendor-flavored" fix would be a `name` column on the `grants` table plus a list view on top of `_ref/grants`. This change rejects that approach in favor of the IETF-grounded one: each operator-issued bearer is bound to its own dynamically-registered client, with the human-meaningful name living on `client_name` (RFC 7591 §2) and revocation done via RFC 7592's client-deletion endpoint.

## Why per-token DCR, not a `name` column on grants

Standards corroboration:

- **RFC 7591 + RFC 7592** standardize the lifecycle of a named, addressable, individually-revocable client identity. `client_name` is the spec-blessed slot for the operator-meaningful label.
- **No IETF document defines a "personal access token" primitive.** PATs are vendor conventions (GitHub, Linear, Vercel, Stripe). Each vendor invented its own substrate. The standards-grounded analog is per-credential identity registration.
- **GitHub fine-grained PATs** are implemented as a user-facing veneer over the GitHub Apps installation model — i.e. each PAT is bound to its own installation-style record, not labeled at the token-row level.
- **Solid-OIDC** uses Service Account WebIDs (each "PAT" is its own client identity with a WebID document) for long-lived CLI auth.
- **MCP (2026 spec)** mandates per-agent M2M identity for revocation; Kinde-style "deactivate the M2M application" is the consensus revocation primitive.
- **Curity, Auth0, Duende** all draw the same line: identity-per-credential is the standards-correct way to attach metadata to bearers.

`grants` rows record delegations — they are the per-issuance log, not the per-credential record. Putting an operator-meaningful name on `grants` would conflate "name of the credential" with "metadata of one issuance event" and would not generalize to credentials that mint multiple tokens (e.g. with refresh).

## Why also add RFC 7592 (not just rely on `POST /grants/:grantId/revoke`)

`POST /grants/:grantId/revoke` revokes one bearer's grant. With per-token DCR clients, that endpoint still works fine and stays unchanged. But the operator's mental model is "delete this token" — and the IETF answer for "delete this credential identity" is RFC 7592's `DELETE /oauth/register/{client_id}`. Implementing both gives:

- **Operators see and revoke at the credential level** (Tokens page → list of clients → Revoke). Matches GitHub/Linear/Stripe UX.
- **Programmatic clients can revoke single grants without deleting their identity** (existing `/grants/:grantId/revoke` path), which is what RFC 7009-style token revocation expects.
- The cascade direction is well-defined: deleting a client revokes its grants; revoking a grant does not delete the client.

## Scope of the deletion cascade

Deleting a registered client SHALL:

1. Mark every `grants` row with that `client_id` as revoked, using the existing `revokeGrant` codepath so spine events (`grant.revoked`) fire correctly.
2. Mark every owner self-export token row with that `client_id` revoked, because those bearers have no grant row.
3. Emit a `client.deleted` spine event with the `client_id`, the deleting subject, and the count of cascaded revocations.
4. Delete the `oauth_clients` row.

Intentionally out of scope:

- **Refunds / surveys / external notifications.** Deletion is local; the AS does not call back into clients.
- **Soft-delete / tombstone.** Deleted clients are gone. Subsequent introspect on their old bearers returns `active: false` because the underlying grants are revoked.
- **Pre-registered clients.** `DELETE /oauth/register/{client_id}` MUST refuse to delete clients with `registration_mode != 'dynamic'`. That protects `pdpp-web-dashboard`, `cli_longview`, etc. from being wiped from the dashboard.

## Why owner-session-gated, not registration-access-token-gated

RFC 7592 §2.1 specifies that DELETE be authenticated by the **registration access token** issued at registration time. PDPP doesn't currently issue registration access tokens. We deliberately don't add them in this change because:

- The dashboard is the only client of this delete endpoint (operators clicking Revoke). It's already authenticated by the owner session cookie.
- A registration access token would have to be persisted, surfaced to the operator at issuance time, and copy-pasted on every revoke — bad UX for the operator and pointless ceremony for the dashboard.
- We retain the *option* to add registration access tokens later (RFC 7592 §2.1 explicitly allows the AS to choose its authentication mechanism) by adding a separate code path; this change doesn't preclude it.

The owner session is a stronger constraint than a registration access token would be in any case: it requires *the same operator who logged in* to revoke, which matches operator intent.

## Why AS-stamped `issuer_subject_id` in client metadata and not a dedicated column

This change needs one new binding: "which owner subject minted this dynamic client?" The value is not trusted input from the DCR request body. The owner-authed route stamps it from the signed owner session, then stores it in the existing client metadata JSON.

Two storage reasons:

1. `oauth_clients.metadata_json` is the existing freeform metadata slot. Using it avoids a schema migration, which keeps this change additive.
2. The field is reference-only (existing `_ref/clients?owner=true` listing depends on it). It is not part of any RFC-defined client metadata. Adding a dedicated column would commit it to the AS contract more permanently than its scope warrants.

A pre-existing `client_name` already lives in `metadata_json`; adding AS-stamped `issuer_subject_id` follows the same storage shape without letting callers choose the subject.

## Alternatives considered

- **(Rejected) Add a `name` column to the `grants` table and surface `_ref/grants` filtered to owner-bound entries.** Vendor-flavored. Conflates per-credential metadata with per-issuance log. No spec backing. Listed only for the record.
- **(Rejected) Service-account WebIDs (Solid pattern).** Heaviest by far. Useful if PDPP grew a decentralized-identity story; overkill today.
- **(Rejected) Per-token RFC 7009 token revocation only.** Solves "delete this bearer string" but not "list my tokens" — the listing has nothing to enumerate. Without per-token client identity, names live nowhere durable.
- **(Selected) DCR-per-token with RFC 7592 client deletion.** Standards-grounded, additive, leverages every primitive PDPP already has, gives operators the GitHub/Linear/Stripe-shaped Tokens UX without inventing a non-standard credential primitive.

## Acceptance checks

- `POST /oauth/register` with an owner session cookie and a body including `client_name` registers a dynamic client carrying both `client_name` and AS-stamped `issuer_subject_id`.
- `POST /oauth/register` from any caller MUST NOT accept a caller-supplied `issuer_subject_id`; anonymous requests silently drop it.
- `GET /_ref/clients?owner=true` with an owner session returns only dynamic clients whose persisted `issuer_subject_id` matches the requesting subject.
- `DELETE /oauth/register/{client_id}` with an owner session whose subject matches the client's persisted `issuer_subject_id` (a) revokes every grant tied to that client, (b) revokes owner self-export token rows tied to that client, and (c) deletes the client row.
- `DELETE /oauth/register/{client_id}` with an owner session whose subject does not match the client's `issuer_subject_id` returns 403 `forbidden`.
- `DELETE /oauth/register/{client_id}` for a `pre_registered_public` client returns 403 `forbidden` regardless of subject.
- `DELETE /oauth/register/{client_id}` is idempotent: a second call returns 404 `not_found` rather than 5xx.
- After delete, `POST /introspect` on any grant-bound bearer formerly bound to the deleted client returns `{ active: false, inactive_reason: "grant_revoked" }`; owner self-export bearers issued by the device flow return `{ active: false, inactive_reason: "token_revoked" }` because they are not grants.
- The Tokens page (`/dashboard/deployment/tokens`) lists the operator's currently-issued tokens with name + issued-at + Revoke. Issuing a new token adds a row; revoking removes it. Refresh persists state across page reloads.
- The shared bootstrap client (`pdpp-web-dashboard`) is still usable by `mintOwnerToken` (BFF's invisible self-mint, used to read `/v1/*` for the dashboard's own data fetches) and is not surfaced in the Tokens list view.
- `openspec validate dcr-per-owner-token-with-revoke --strict` passes.
- `openspec validate --all --strict` passes.
