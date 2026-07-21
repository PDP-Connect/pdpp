# Position: Why PDPP grants are durable

**Status:** Settled (v0.1), with one acknowledged spec gap (`single_use` retention).

## Asked as

- "Why aren't PDPP consent artifacts ephemeral, like OAuth tokens often are?"
- "What use case justifies a durable, immutable grant?"
- "Are persistent audit trails the reason grants persist?"

## Short answer

Durable grants are primarily motivated by continuous access: a `continuous` grant
authorizes repeated reads over time, so the authorization must persist for the resource
server to enforce each request against it and for the user to review and revoke active
authorizations. Regulatory and audit value is secondary but real. Sharing a grant as a
credential is **not** a reason grants persist, and is not a v0.1 capability.

## Why it's true

- **Enforcement is the primary reason.** A `continuous` grant includes newly collected
  records in already-approved streams until expiry or revocation. Each request is evaluated
  against the same approved snapshot — client, streams, fields, resources, time range,
  purpose, retention commitment, expiry, pinned manifest version. That requires the grant
  to persist.
- **User management depends on it.** Across many clients and sources, the user needs a
  durable, legible record set to review and revoke. PDPP's multi-party surface makes this
  more salient than in single-institution contexts.
- **`single_use` is the ephemeral case.** "Not necessarily ephemeral" is precise:
  `single_use` grants are consumed at first token issuance; `continuous` grants persist.
- **Regulatory/audit is a yielded benefit.** A durable, legible grant lets a controller
  demonstrate consent (GDPR Art. 7(1): consent must be demonstrable) and lets the user
  inspect what they approved. This is value the durable record yields, not the reason it
  exists. The same pattern appears in FHIR (`Consent` resource, designed for indexing and
  retrieval) and Open Banking (a consent object distinct from short-lived tokens).

## What we do NOT claim

- We do **not** justify durability by claiming users will share grants as credentials.
- We do **not** describe the grant as a complete audit trail. The grant answers "what was
  authorized?"; a disclosure log answers "what was actually accessed, when, by whom?" PDPP
  core provides the identifiers, timestamps, purposes, and lifecycle states to build such
  records, but v0.1 does not standardize an audit-log schema, log retention period, or a
  user-facing access-history interface.
- We do **not** claim PDPP adds durability beyond OAuth's. OAuth already persists
  continuing-authorization state; PDPP's addition is the structure of what persists, not a
  new persistence mechanism. (See [PDPP and OAuth 2.0](pdpp-and-oauth.md).) Note: this
  concession is the answer to a "why not just OAuth / isn't this incidental complexity"
  follow-up — deploy it only if that follow-up is actually raised.

## Open spec gap

For `single_use` grants: once consumed, all issued tokens expired, and no further access
possible, enforcement no longer needs the artifact. v0.1 does not say whether the consumed
grant is deleted or retained as a record. This is where the audit-vs-minimization tradeoff
actually arises. Should be resolved in an OpenSpec change (state "post-consumption
retention is local policy," or prescribe a rule).

## References

- `apps/site/content/docs/spec-core.md` — grant fields (§6), standing authorization (L594), grant narrowing / revoke-and-reissue (L598), records from revoked grants (L602), retention (L606), auditability/transparency boundary (L1411–1417), view evolution (L872).
