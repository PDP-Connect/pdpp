---
title: "Auth Design"
description: "Bearer tokens at both boundaries — wire format and semantics. Identity provider and token issuance are out of scope."
---

<Callout type="info" title="Spec status">
  Status: **Informative**

  Date: 2026-03-30

  Scope: Design rationale for the two-boundary bearer-token authentication model.
</Callout>
## Decision: Bearer tokens at both boundaries, mechanism out of scope

Following the OAuth 2.0 pattern (RFC 6749 §3.1: "The way in which the authorization server authenticates the resource owner is beyond the scope of this specification"), PDPP defines the wire format and semantics for authentication, not the identity provider or token issuance mechanism.

## Two boundaries, two token types

### Owner operations (ingest, state, grant management)

```
Authorization: Bearer <owner_token>
```

- Owner tokens bypass grant enforcement — the owner has full access to their own data
- How the owner obtains this token is out of scope: device code flow, wallet signature, API key, env var for CI
- The reference CLI implements this: it stores the owner token obtained from the device code flow
- Env var override: `PDPP_OWNER_TOKEN`

### App operations (query records filtered by grant)

```
Authorization: Bearer <access_token>
```

- Access tokens are bound to a specific grant
- The resource server resolves token → grant and enforces grant constraints
- How the app obtains this token is the OAuth authorization code flow with RFC 9396 authorization_details

### User consent (approving grant creation)

Out of scope for the wire protocol. The authorization server handles user authentication and consent display. The core spec does, however, normatively constrain the semantic distinction between requester identity metadata, protocol-enforced grant terms, structured policy declarations, manifest-authored data descriptions, and client-authored claims.

## What the spec mandates

- Owner and app tokens MUST be distinct
- Owner tokens MUST be required for: ingest, state management, grant creation/revocation
- App tokens MUST be required for: record queries, stream listing, blob access
- Both use `Authorization: Bearer <token>` wire format (RFC 6750)
- The resource server MUST be able to distinguish owner tokens from app tokens
- Token format (opaque string, JWT, etc.) is implementation choice
- Token issuance mechanism is implementation choice

## What the spec leaves to implementations

- How the owner authenticates (password, passkey, wallet, SSO, API key)
- How tokens are issued (OAuth token endpoint, direct issuance, device code flow)
- Token format and validation method (opaque lookup, JWT verification, RFC 7662 introspection)
- Token lifetime and refresh mechanics
- Whether wallet-based auth is supported (optional, never required)

## How an existing deployment maps

| Existing mechanism | PDPP boundary | Notes |
|---|---|---|
| Reference CLI owner session token (device code flow) | Owner token | Already a bearer token |
| `PDPP_OWNER_TOKEN` env var | Owner token (CI/automation) | Supported by the reference CLI |
| Deployment-specific signed-header schemes | App token | Deployment-specific profiles; PDPP standardizes as bearer |
| Session relay → grant approval → GrantPayload | User consent | Maps to OAuth authorization code flow |

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
