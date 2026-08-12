## Context

PR89 is the executable seam spike and implementation work that tests whether
Source-defined authorization semantics can cross the OAuth/RAR binding and
arrive at a separated resource server as a complete enforcement context. The
sole case definition is `design-notes/seam-spike/corpus.md`.

The current task is deliberately narrower than the earlier planning draft. It
must test the real database-backed authorization path, authenticated HTTP
introspection, response-only enforcement, exact-once races, and the breaking
persisted-state boundary. It must not turn deferred policy questions into seam
passes.

## Goals

- Execute seven deterministic cases with exact fixtures, stable failure codes,
  receipt JSON, and machine-checkable oracles.
- Consume the Source contract without creating a second grant schema.
- Prove PostgreSQL atomicity for authorization-code and `single_use` races.
- Test token expiry, instance mismatches, field mismatches, and temporal
  bounds in the context and enforcement paths.
- Reject pre-v0.1 persisted authorization state before introspection or route
  handling and require fresh consent.

## Non-goals

- Long-term confidential-client registration or discovery. That belongs to
  the separate discovery and trust change.
- Alternate client-registration design.
- DPoP implementation, nonce policy, `jti` policy, or a DPoP mandatory floor.
- Keyless recovery or a minimum credential-security-profile floor.
- Timestamp or duration value canonicalization. JSON Schema dialect ownership
  belongs to Source, and value canonicalization waits for a jointly designed
  digest algorithm and temporal/duration semantics.
- Persisted-state inventory, device or package token rules, public
  compatibility metadata, or a large sunset profile.
- A normative GNAP binding.

## Key decisions

### Source owns the resolved authorization shape

`ApprovedAuthorization` has exactly `source_id`, `access_mode`, and the Source
stream rows. A row requires a unique nonempty `name`, unique nonempty
`instance_ids`, and unique nonempty `fields`. It may contain a frozen temporal
field with optional lower and upper bounds and optional canonical resources.
`source.kind` records provenance only and is outside equality. Binding facts
remain in the resolved context. This prevents an OAuth-shaped grant schema
from becoming a second authority.
The binding maps the Source-neutral
`source.authorization_details_invalid` failure to RFC 9396
`invalid_authorization_details`.

### Introspection is real and authenticated

The spike uses authenticated RFC 7662 HTTP introspection with fixed local
confidential-RS credentials. The RS enforces only from the captured response.
The AS response carries the approved rights once. Supplementary context does
not duplicate them. Registration and discovery are intentionally owned by the
separate discovery and trust change.

### Lifecycle behavior is concrete

Authorization codes are one-use with no same-key idempotency exception. A
second redemption returns `invalid_grant`. Whether the already-issued token is
revoked after detected reuse is reported separately at RFC 6749 SHOULD
strength unless exact linkage is implemented and tested.

Refresh state is a family row keyed by family and generation, with token hash,
active or superseded status, parent generation, and timestamps. Rotation
atomically supersedes the presented generation and creates one successor.
Any superseded-generation reuse, including indistinguishable lost-response
retry, revokes the family and returns `invalid_grant`; fresh authorization is
required. These results have separate tests and receipt fields and do not
expand the seven-case seam decision.

### Pre-v0.1 authorization state is disposable

PR89 defines a breaking persisted-state boundary, not a compatibility path.
The current persisted-grant reader rejects pre-v0.1 bytes with
`authorization_state.unsupported_legacy_shape` before introspection or route
handling. It does not reconstruct missing authorization or binding facts from
current configuration. There is no acceptance flag, compatibility adapter, or
alternate context kind. Users must complete fresh consent.

### Deferred questions remain visible

Keyless recovery and the security-profile floor remain in the deferred section
of the execution document because this PR has neither a recovery authority
model nor a profile vocabulary. A future decision on those inputs unlocks the
work. They are not seam prerequisites and cannot count as passes. Temporal and
duration canonicalization is similarly deferred until digest and semantics are
designed together.

## Acceptance evidence

The implementation report must show:

- the exact required commands in the execution document;
- the strict OpenSpec validations;
- all seven case results and their stable oracles;
- PostgreSQL race evidence;
- receipt-checker output from CI-compatible execution;
- a relevant-file tree digest that excludes the receipt itself;
- stale sweeps for removed registration, canonicalization, floor, recovery,
  and compatibility language.

## Ownership and merge order

| Change | Ownership | Order |
| --- | --- | --- |
| Source Declaration and resolved grant contract | neutral declaration, request, snapshot, and resolved grant contracts | 1 |
| existing PR89 OAuth/RAR authorization carrier and seam | OAuth/RAR spike, consumption of the Source-defined contract, breaking persisted-state gate, receipt and CI checker | 2 |
| Source Declaration discovery and trust | long-term registration, retrieval, onboarding, and trust boundaries | 3 |

PR89 consumes the Source-defined contract and must not define a second grant
schema. Discovery consumes both the Source Declaration contract and the
existing PR89 OAuth/RAR authorization carrier and seam. GNAP and DPoP future
work is not a numbered PR in this program.
