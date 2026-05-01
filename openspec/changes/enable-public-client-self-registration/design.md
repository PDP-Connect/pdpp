## Decision

The ideal reference path is public-client self-registration through `/oauth/register`.

The reference authorization server will advertise `registration_endpoint` whenever DCR is enabled. A stranger client may POST supported public-client metadata without an initial access token. The AS returns a usable public `client_id` with `token_endpoint_auth_method: "none"`.

Initial-access-token DCR remains supported for operator/bootstrap flows, but it is no longer required for the normal public-client path. If a caller sends a bearer token, the token must still be valid for that request origin; a bogus bearer token is rejected instead of silently falling back to public registration.

Registration is identity setup only. It does not grant data access, mint bearer tokens, approve scopes, or bypass owner consent. The client must still use the normal owner-approved grant flow before it can read protected resources.

## Rationale

The SLVP/open-standards bar favors a complete discoverable path over pre-provisioned demos or owner-token shortcuts. Public client identifiers are not secrets. Requiring an operator token for every third-party public client creates exactly the dead-end that discovery is supposed to remove.

The abuse surface is real, but it is bounded by strict metadata validation, public-client-only registration, no client secrets, no token issuance, owner consent for data access, spine audit events, and rate limits. That is the cleaner standards story than an extra PDPP-specific owner-mediated registration protocol.

## Required Properties

- Public registration SHALL create only public clients with `token_endpoint_auth_method: "none"`.
- Public registration SHALL NOT grant data access or mint bearer tokens.
- The AS SHALL reject unsupported metadata fields, confidential-client claims, unsupported auth methods, and malformed URI metadata.
- The AS SHALL rate-limit unauthenticated registration attempts.
- Successful and failed registrations SHALL emit auditable spine events with request and trace identifiers.
- Metadata SHALL advertise `registration_endpoint` and `dynamic` whenever public self-registration is available.
- Pre-registered public clients MAY remain advertised as examples or fallback client identities, but they are not the primary third-party path.

## Deferred

- Software statements and domain verification are deferred; initial registration accepts self-asserted display metadata only.
- Owner-mediated client registration may be added later as an enterprise policy layer, but it is not the reference default.
