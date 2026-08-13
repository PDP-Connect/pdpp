## Why

The separated resource-server path needs a complete approved authorization and
binding context from authenticated RFC 7662 introspection. The existing
planning material also leaves authorization-code reuse, refresh-token replay,
and the pre-v0.1 persisted-state boundary too open for an executable
implementation.

## What Changes

- Execute the seven-case OAuth/RAR seam spike plus one durable-handoff case,
  the implementation they exercise, and the deterministic receipt checker.
- Define `ApprovedAuthorization` as the Source contract: `source_id`,
  `access_mode`, and streams with unique nonempty `name`, `instance_ids`, and
  `fields`, optional frozen-field bounds, and optional canonical resources.
  `source.kind` is provenance outside authorization equality.
- Require authenticated HTTP introspection with fixed local confidential-RS
  credentials for the spike. Long-term registration and discovery belong to
  the separate discovery and trust change.
- Make authorization-code one-use and test same-valid-PKCE races. Report token
  revocation after detected reuse separately at RFC 6749 SHOULD strength unless
  exact token linkage is implemented and tested.
- Implement refresh rotation, superseded-generation reuse, family revocation,
  lost-response retry handling, and exact store state following RFC 9700.
  Link every family-derived bearer to its family, give it a short persisted
  expiry, and atomically deactivate every linked bearer when replay is
  detected. Limit refresh to continuous grants and all-continuous packages.
  Report truthful token lifetimes and omit absent expiry fields. Report these
  controls separately from the seven-case seam result. Revoke legacy refresh
  families and their bound bearers when family linkage is absent rather than
  reconstructing or guessing the relationship.
- Prevent intermediary caching of every successful token-bearing response
  with RFC 6749's `Cache-Control: no-store` and `Pragma: no-cache` headers,
  including package variants and device-code responses.
- Replace the process-local HTML consent handoff with a durable exchange-code
  record. HTML carries a proofless, single-use code; a separate out-of-band
  proof-bound code supports response-loss retry by the same proof holder until
  expiry, returning the same persisted token result.
- Treat pre-v0.1 persisted authorization state as disposable. Reject its bytes
  before introspection or route handling with
  `authorization_state.unsupported_legacy_shape` and require fresh consent.
- Defer keyless recovery, the security-profile floor, DPoP implementation,
  timestamp and duration value canonicalization, and persisted-state inventory.
- Keep the GNAP map non-gating and record the five-change ownership and merge
  order across Source contract, discovery contract, Source implementation,
  discovery implementation and accepted-revision bridge, then this OAuth/RAR
  hardening change.

## Capabilities

### New Capabilities

- `pdpp-authorization-hardening`: executable seam, authorization-context
  implementation, and deterministic evidence.

### Modified Capabilities

- `pdpp-authorization-hardening` is modified by the delta in this change.

### Removed Capabilities

- Remove the proposed alternate client-registration design, keyless-recovery
  rules, security-profile floor, timestamp/duration canonicalization profile,
  persisted-state inventory, compatibility adapter, and public compatibility
  discovery requirements from PR89 scope.

## Impact

This PR executes the spike and implements the binding, lifecycle, and durable
post-approval handoff behavior needed to pass it. It updates root protocol text
where the implemented OAuth contract requires it. It does not implement a GNAP
binding, DPoP, long-term registration, or public discovery.
The authoritative case, fixture, failure-code, receipt, PostgreSQL, and CI
requirements are in `design-notes/seam-spike/corpus.md`.
