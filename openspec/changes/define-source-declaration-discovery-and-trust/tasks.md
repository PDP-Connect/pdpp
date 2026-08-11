# Tasks

## Normative contract

- [x] Publish the discovery and trust requirements in the authoritative root
  companion specification and its generated public-site page.
- [x] Consume the Source schema and accepted snapshot from the Source
  Declaration contract. Do not redefine grants, consent snapshots, Core schema,
  or Collection.
- [x] Define `pdpp_source_declaration_uri` as one HTTPS URI string with no
  fragment or user information, use RFC 9728's standard well-known
  transformation, and apply the RFC 9728 returned-resource equality rule.
- [x] Require `SourceDeclaration.source.id` to equal the provider-native
  protected resource.
- [x] Require owner/operator onboarding before a new provider-native resource
  identifier can be used in authorization.
- [x] Accept connector and community sources only from an installed catalog,
  trusted registry entry, or explicit local provisioning.
- [x] Store resource authority separately from publisher attribution. Keep a
  publisher claim non-authoritative and unusable for trust decisions unless an
  accepted channel or configured mapping authenticates it.
- [x] Require fresh DNS resolution and validation of every resolved address for
  each connection attempt and redirect hop. Validate redirect targets and the
  final declaration URL against the accepted pointer and configured policy,
  while validating `source.id` separately against the protected resource.

## Public protocol contract

- [x] Add optional `pdpp_source_declaration_uri` to generic protected-resource
  metadata and a focused provider-native validator that requires the pointer
  and exact resource identity, without defining a second Source or grant schema.
- [x] Add protocol-contract tests for missing, invalid, fragment-bearing, and
  valid declaration pointers, malformed resource identifiers, RFC 9728
  well-known URI transformation including root-slash forms, and exact
  returned-resource mismatches.

## Deferred implementation

Reference-server metadata emission, retrieval, onboarding adapters,
persistence, consent integration, local blocking, and lifecycle behavior are
out of scope for this specification PR. Their implementation changes must
consume this contract and add focused runtime, SQLite, and PostgreSQL tests.

## Validation

- [x] Run the reference-contract tests, typecheck, and style check. Regenerate
  checked-in contract artifacts twice and verify stable output.
- [x] Run `pnpm spec:check`.
- [x] Run `openspec validate define-source-declaration-discovery-and-trust --strict`.
- [x] Run `openspec validate --all --strict`. The target change passes; 10
  unrelated existing changes remain invalid.
- [x] Run a target diff check and stale sweeps for removed dependencies,
  source-identity redirect checks, unauthenticated publisher trust, incomplete
  DNS/IP validation, and em dashes.
