## Context

`pdpp_registration_modes_supported` currently distinguishes dynamic registration from pre-registered public clients, but the public metadata only exposes an endpoint for the dynamic path. When dynamic registration is disabled for a public origin, a standards reviewer or coding agent can discover that a pre-registered public path exists but cannot discover a working `client_id`.

## Decision

The reference authorization-server metadata will include a PDPP extension named `pdpp_pre_registered_public_clients`.

Each advertised client entry contains:

- `client_id`
- `client_name`
- `token_endpoint_auth_method`

The list is populated only from the configured pre-registered public client registry. It does not include dynamically registered clients, owner-specific clients, secrets, access tokens, redirect URIs, or private registration state.

## Rationale

The field is intentionally explicit rather than hidden in prose because agents need machine-readable setup data. Listing public client IDs is consistent with the semantics of public clients: the identifier is not a secret, and the user grant remains the authorization boundary.

Public self-registration is the primary third-party path when DCR is enabled. Pre-registered public clients remain useful as examples, compatibility fallbacks, and deliberately configured public identities when an operator disables dynamic registration.

## Acceptance Checks

- Public forwarded metadata with DCR disabled omits `registration_endpoint`, advertises `pre_registered_public`, and lists usable public clients.
- Public forwarded metadata with DCR enabled advertises both `dynamic` and `pre_registered_public`, and still lists usable public clients.
- The public contract schema accepts the new extension and rejects malformed entries.
