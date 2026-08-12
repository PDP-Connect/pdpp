## 1. Context and Source contract

- [x] 1.1 Implement the Source-defined `ApprovedAuthorization` parser with
      `source_id`, `access_mode`, stream names, unique nonempty `instance_ids`,
      unique nonempty `fields`, optional frozen-field bounds, and optional
      canonical resources.
- [x] 1.2 Keep `source.kind` outside authorization equality and reject every
      metadata mismatch before projection, plus every stable invalid-input
      code listed in the execution document.
- [x] 1.3 Add instance and temporal-field rows to Cases 1, 3, and 4.

## 2. OAuth/RAR and introspection

- [x] 2.1 Run the real authorization-code and PKCE path with partial approval
      and assert the granted `authorization_details`, including approved
      purpose, retention, and selection provenance.
      Assert that Source-neutral `source.authorization_details_invalid` maps
      to RFC 9396 `invalid_authorization_details` at the OAuth boundary.
- [x] 2.2 Use authenticated RFC 7662 HTTP introspection with operator-provided
      or per-process generated confidential-RS credentials. Keep fixed
      credentials in test helpers only, and keep long-term registration out of
      PR89.
- [x] 2.3 Test expiration, issuer, audience, identity, source, context-kind,
      approved-rights, instance, and field mismatches before route handling.
- [x] 2.4 Assert response-only RS enforcement with no in-process fallback or
      second AS lookup. Keep DPoP text conditional to the RFC 9449 AS versus RS
      duty split without adding nonce or `jti` policy.

## 3. One-use and refresh lifecycle

- [x] 3.1 Test authorization-code one-use and same-valid-PKCE concurrent races
      against PostgreSQL. Report post-reuse token revocation separately at RFC
      6749 SHOULD strength unless exact linkage is proven.
- [x] 3.2 Test `single_use` issuance races against PostgreSQL.
- [x] 3.3 Implement and test refresh rotation, family state,
      superseded-generation reuse, family revocation, lost-response retry,
      `invalid_grant`, and fresh authorization per RFC 9700. Record these
      results separately from the seven seam decisions.

## 4. Breaking persisted-state boundary

- [x] 4.1 Load pre-v0.1 authorization-state bytes through the current
      persisted-grant reader and reject them with
      `authorization_state.unsupported_legacy_shape`.
- [x] 4.2 Assert rejection occurs before introspection and route handling and
      requires fresh consent.
- [x] 4.3 Assert the reader does not reconstruct `instance_ids`, issuer,
      audience, source identity, or any other missing fact from current
      configuration.
- [x] 4.4 Do not add an acceptance flag, compatibility adapter, alternate
      context kind, persisted-state inventory, discovery, or sunset
      requirements.

## 5. GNAP map

- [x] 5.1 Implement only the pure rights round-trip and narrowed approval map.
- [x] 5.2 Reject unknown mandatory members and mark unimplemented controls
      `not demonstrated`. GNAP remains non-gating.

## 6. Receipt and CI

- [x] 6.1 Generate the exact receipt JSON schema from the seven-case target.
- [x] 6.2 Compute a relevant-file tree digest that excludes the receipt and
      generated artifacts. Do not use a self-referential commit or source
      revision field.
- [ ] 6.3 Run the receipt checker in CI and fail on missing cases, stale
      digests, duplicated rights, fallback markers, or invented passes.

## 7. Deferred questions

- [x] 7.1 Record keyless recovery and the security-profile floor as explicit
      deferred questions with their nonblocking reason and future unlock.
- [x] 7.2 Remove timestamp and duration canonicalization requirements and all
      seam prerequisite references. Defer value canonicalization until a digest
      algorithm and temporal/duration semantics are designed together.

## 8. Ownership and validation

- [x] 8.1 Record the shared three-change ownership and merge-order matrix:
      Source Declaration and resolved grant contract; existing PR89 OAuth/RAR
      authorization carrier and seam; Source Declaration discovery and trust.
- [x] 8.2 Make PR89 consume the Source-defined resolved contract without a
      second grant schema; discovery consumes both.
- [x] 8.3 Run `openspec validate harden-pdpp-authorization-and-0-1-migration
      --strict`.
- [ ] 8.4 Run `openspec validate --all --strict`.
- [ ] 8.5 Run the existing targeted tests, the PostgreSQL seam target, the
      receipt checker, `git diff --check`, and stale sweeps.
- [x] 8.6 Write the required Waspflow checkpoint to
      `/home/tnunamak/.tmp/pdpp-spec-program-0811.xkarws/research/pr89-wasp-checkpoint.md`.
