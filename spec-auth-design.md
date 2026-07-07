# Authentication Design

Status: Informative
Date: 2026-07-07 (revised from 2026-03-30)

## Decision: Bearer tokens at both boundaries, mechanism out of scope

Following the OAuth 2.0 pattern (RFC 6749 §3.1: "The way in which the authorization server authenticates the resource owner is beyond the scope of this specification"), PDPP defines the wire format and semantics for authentication, not the identity provider or token issuance mechanism.

## Two boundaries, two token kinds

spec-core Section 10 defines two token kinds at the resource server boundary: owner tokens and client tokens. Both use the RFC 6750 bearer format on the wire; the resource server distinguishes them by `pdpp_token_kind` in the introspection response, not by token syntax. The discriminator is extensible: a deployment may introduce additional kinds under the same field (the reference implementation adds an `mcp_package` kind for hosted MCP package tokens). Extension kinds are deployment behavior, not protocol requirements.

### Owner operations (ingest, state, grant management)

```
Authorization: Bearer <owner_token>
```

- Owner tokens bypass grant enforcement; the owner has full access to their own data, scoped to a single subject's data store.
- How the owner obtains this token is out of scope: device code flow, wallet signature, API key, env var for CI.
- The reference CLI stores the owner token obtained from the device code flow. Env var override: `PDPP_OWNER_TOKEN`.

### Client operations (query records filtered by grant)

```
Authorization: Bearer <access_token>
```

- Client tokens are bound to a specific grant.
- The resource server resolves token to grant and enforces grant constraints on every request.
- The client obtains this token through the OAuth authorization code flow with RFC 9396 `authorization_details`.
- An owner may also query the standard record endpoints directly with an owner token (self-export). This is a SHOULD-level Core capability (spec-core Section 8) and does not involve a client grant.

### User consent (approving grant creation)

Out of scope for the wire protocol. The authorization server handles user authentication and consent display. The core spec does, however, normatively constrain the semantic distinction between requester identity metadata, protocol-enforced grant terms, structured policy declarations, manifest-authored data descriptions, and client-authored claims.

## What the spec mandates

- Owner and client tokens MUST be distinct, and the resource server MUST be able to tell them apart (`pdpp_token_kind`).
- Owner tokens MUST be required for: ingest, state management, grant creation and revocation.
- Grant-scoped record queries, stream listing, and blob access require a client token bound to a grant; owner self-export over the same query endpoints is the SHOULD-level exception noted above.
- Both kinds use the `Authorization: Bearer <token>` wire format (RFC 6750).
- Token format (opaque string, JWT) and issuance mechanism are implementation choices.

## What the spec leaves to implementations

- How the owner authenticates (password, passkey, wallet, SSO, API key).
- How tokens are issued (OAuth token endpoint, direct issuance, device code flow).
- Token format and validation method (opaque lookup, JWT verification, RFC 7662 introspection).
- Token lifetime and refresh mechanics.
- Whether wallet-based auth is supported (optional, never required).

## How an existing deployment maps

| Existing mechanism | PDPP boundary | Notes |
|---|---|---|
| Reference CLI owner session token (device code flow) | Owner token | Already a bearer token |
| `PDPP_OWNER_TOKEN` env var | Owner token (CI/automation) | Supported by the reference CLI |
| Deployment-specific signed-header schemes | Client token | Deployment-specific profiles; PDPP standardizes as bearer |
| Authorization request, consent, grant issuance | User consent | OAuth authorization code flow with RFC 9396 `authorization_details` |

## Industry patterns

All major platforms use the same pattern: owner/admin uses privileged credentials, apps use scoped tokens.

| Platform | Owner auth | App auth |
|---|---|---|
| Stripe | Dashboard SSO + API keys (sk_live_xxx) | Bearer token |
| Supabase | CLI login → PAT; Dashboard SSO | anon key + JWT |
| Firebase | CLI login → Google creds; Admin SDK service account | Client SDK with user auth |
| Plaid | Dashboard login | client_id + secret → access_token per item |

## Sources

- RFC 6749 §3.1: owner authentication explicitly out of scope
- RFC 6750: defines bearer token presentation, not issuance
