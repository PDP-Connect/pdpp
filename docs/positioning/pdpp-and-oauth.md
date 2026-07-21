# Position: PDPP and OAuth 2.0

**Status:** Settled (v0.1).

## Asked as

- "What are the primary technical differences between OAuth2 and PDPP?"
- "Why not just use OAuth / refresh tokens?"
- "Isn't a durable, structured grant just incidental complexity over OAuth?" (the Hickey framing)
- "Does PDPP replace OAuth?"

## Short answer

PDPP is a domain profile on top of OAuth 2.0, in the same lineage as SMART on FHIR and
Open Banking. OAuth (with RFC 9396, Rich Authorization Requests) carries the
authorization; PDPP defines what an authorized request *means* for personal data — the
record model, field-level selection, purpose, and the server-side enforcement rules.
PDPP does not replace OAuth and does not add a new persistence or durability mechanism;
it adds a standardized, fine-grained authorization *object* to the authorization state
OAuth already keeps.

## Why it's true

- **OAuth is the carrier; PDPP is the content.** Default OAuth authorization is a coarse,
  opaque, provider-private scope string (`photos.read`). RFC 9396 provides a structured
  `authorization_details` envelope but deliberately leaves the *contents* to domain
  profiles. PDPP fills that slot for personal data. So PDPP completes OAuth at the layer
  OAuth left open — it does not duplicate it.
- **Same standards pattern as the respected analogs.** SMART on FHIR and UK Open Banking
  both use OAuth for the handshake and then define a domain-specific data model, consent
  semantics, and access rules so independent clients and servers interoperate around a
  class of data. Both also maintain a durable, standardized consent object distinct from
  the access token (the FHIR `Consent` resource; Open Banking's `account-access-consent`).
  PDPP is the general-purpose-personal-data instance of the same move.
- **Token vs. grant.** PDPP clients present an ordinary RFC 6750 bearer access token (not
  the raw grant); the resource server resolves that token to a client-bound grant and
  enforces the grant's constraints. The grant is closer to OAuth's durable
  authorization-server state than to an access token. For `continuous` access the spec
  recommends short-lived access tokens with refresh tokens (`spec-core.md` L1379).
- **It adds structure, not durability.** OAuth already persists continuing authorization
  state (refresh token + AS state, read via introspection RFC 7662). PDPP's only addition
  is the *shape* of what is persisted — field/stream/purpose-level, manifest-pinned,
  enforceable, legible. This is essential, not incidental, complexity: cross-provider
  interoperability of personal-data authorization is the actual problem, and an opaque
  per-provider scope cannot express it by construction.

## What we do NOT claim

- We do **not** claim OAuth "cannot persist or enforce" standing authorization — it can,
  and PDPP reuses that. The distinction is resolution and interoperability, not
  persistence or enforcement capability.
- We do **not** claim PDPP adds a separate durability/persistence system. (Claiming this
  is what invites the "incidental complexity" objection.)
- We do **not** claim the grant is cryptographically bound today. The spec says the grant
  is "designed to be signable"; signing is deferred to a future version (`spec-core.md`
  L1383). External-facing material that says "cryptographically bound" overstates v0.1.

## Primary source — the owner's framing (Slack, the origin of this position)

Stated in a DM to a person a month or two after the core spec was drafted, in response to a
similar question. This is the cleanest first-principles articulation and predates the
later analysis:

> - PDPP sits above OAuth and Rich Authorization Requests: OAuth authorizes the client,
>   Rich Authorization Requests let the client include structured authorization details,
>   and PDPP defines what those details mean for personal data: data categories, field
>   selection, time ranges, resources, grants, record format, and enforcement rules.
>
> - SMART on FHIR and Open Banking are useful analogs because they show the same standards
>   pattern: use OAuth for authorization, then define the domain-specific data model,
>   consent semantics, and access rules needed for independent clients and servers to
>   interoperate around a class of data.
>
> - Native PDPP support for a platform like Instagram would mean using its OAuth
>   authorization flow to accept PDPP-formatted access requests, issuing scoped
>   user-approved grants, and enforcing those grants when returning records from declared
>   personal-data streams and fields.
>
> - The platform burden is bounded because Instagram can keep its internal data model and
>   map selected surfaces into PDPP's common stream, field, and record structure, while
>   clients get consistent consent, scoping, revocation, sync, and disclosure semantics
>   across platforms.

## References

- `apps/site/content/docs/spec-core.md` — grant fields (§6), grant integrity / "signable" (L1383), continuous-access token guidance (L1379), retention parallel to OAuth scope compliance (L606), GNAP/RFC 9396 comparison.
- RFC 9396 (Rich Authorization Requests); RFC 6749 (OAuth 2.0); RFC 7662 (Token Introspection); RFC 6750 (Bearer Token Usage).
