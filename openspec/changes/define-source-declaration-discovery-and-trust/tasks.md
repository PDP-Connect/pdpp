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
- [x] Require `SourceDeclaration.source.kind` to be `provider_native` and
  `SourceDeclaration.source.id` to equal the provider-native protected
  resource.
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

## Standalone reference implementation

- [x] Emit a configured provider-native declaration pointer only in native
  metadata, and reject an invalid pointer before response emission.
- [x] Add credential-free, bounded declaration retrieval with injected
  fetch/DNS/address/URL/schema-validation policy, per-hop fresh address
  validation, manual redirects, and source-ID validation.
- [x] Persist accepted revision content immutably by authority binding, source
  ID, and opaque declaration version on SQLite and PostgreSQL; reject parsed
  content equivocation without version ordering.
- [x] Add deterministic retrieval, metadata, SQLite, and real PostgreSQL
  parity coverage for this standalone boundary.

Onboarding adapters, local blocking, and lifecycle behavior remain outside
this standalone implementation slice.

## Accepted revision consent handoff

- [x] Resolve one internal source-bound accepted-revision reference from the
  accepted store and retain its exact declaration in consent without refetch.
- [x] Retain the accepted reference, resource authority, and separate
  unverified publisher attribution in immutable review and audit evidence,
  but not in resolved grant rights.
- [x] Label direct provider-native configuration as local operator
  provisioning and fail closed on missing, mismatched, stale, or tampered
  accepted-revision evidence.
- [x] Prove the HTTP PAR, review, HTML resume, approval, and audit path on
  SQLite and live PostgreSQL, including pointer drift and offline retrieval.

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
