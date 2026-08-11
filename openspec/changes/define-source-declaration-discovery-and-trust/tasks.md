# Tasks

## Ownership and dependencies

- [ ] Confirm the three-PR merge order: Source Declaration contract, PR89
  authorization context, then this discovery and trust change.
- [ ] Consume the Source schema and accepted snapshot from the first change.
  Do not redefine grants, consent snapshots, Core schema, or Collection.
- [ ] Record PR89's target context contract as a dependency. Do not define a
  legacy acceptance field until that contract is stable.

## P0: authority and onboarding

- [ ] Define `pdpp_source_declaration_uri` as one HTTPS URI string with no
  fragment and apply RFC 9728 decoded Unicode code-point equality without
  normalization.
- [ ] Require `SourceDeclaration.source.id` to equal the provider-native
  protected resource.
- [ ] Require owner/operator onboarding before a new provider-native resource
  identifier can be used in authorization.
- [ ] Accept connector and community sources only from an installed catalog,
  trusted registry entry, or explicit local provisioning.
- [ ] Store resource authority separately from publisher attribution. Bind
  publisher identity only through an accepted channel or configured mapping.

## P0: contract and metadata implementation

- [ ] Add `pdpp_source_declaration_uri` to protected-resource metadata in
  `packages/reference-contract/src/public/index.ts` without defining a second
  Source or grant schema.
- [ ] Extend `reference-implementation/server/metadata.ts` and
  `reference-implementation/operations/rs-protected-resource-metadata/index.ts`
  to emit the accepted pointer for the exact protected resource.
- [ ] Add contract and metadata tests for missing, invalid, fragment-bearing,
  and valid declaration pointers, plus exact resource mismatches.

## P0: retrieval and revision integrity

- [ ] Implement HTTPS, no redirects, no ambient credentials, bounded bytes, time,
  depth, exact source/revision validation, and fail-closed outcomes.
- [ ] Permit private or local endpoints only through explicit local
  provisioning or onboarding. Do not make a broad IP list universal protocol
  conformance.
- [ ] Do not automatically fetch remote schemas.
- [ ] Compare exact accepted UTF-8 JSON body bytes after HTTP content decoding,
  keyed by accepted authority binding, source ID, and opaque version. Reject
  later non-identical bytes under the same key.
- [ ] Do not add a cross-implementation digest, parsed-JSON equivalence,
  portable cache-key grammar, rollback framework, or version ordering.

## P0: authority pipeline and persistence

- [ ] Add a focused source-declaration discovery module with injected retrieval
  and storage effects. Keep retrieval, trust policy, and consent resolution out
  of `auth.ts`.
- [ ] Add owner/operator onboarding and installed-catalog, configured-registry,
  and explicit-local-provisioning adapters. Reject an unaccepted source or a
  client-selected declaration URI before network access.
- [ ] Persist accepted authority binding, source ID, opaque declaration version,
  publisher attribution, trust basis, and exact accepted body bytes. Enforce
  same-key immutability transactionally in each supported database backend.
- [ ] Retain the accepted revision through consent staging and issuance by
  consuming the snapshot contract from the Source change. Do not add a live
  declaration lookup to RS grant enforcement.

## P1: output and lifecycle boundaries

- [ ] Keep output-context escaping and whole-response/parser/display limits as
  implementation policy. Do not add fixed display `maxLength` values.
- [ ] Remove Source-owned snapshot or evolution duplication.
- [ ] Support only local blocking for new consent in this change. Defer
  quarantine records and workflow. Do not automatically revoke historical
  grants.
- [ ] Keep Collection optional and preserve the Core, Source Declaration, PR89,
  and Collection ownership boundaries.

## Validation

- [ ] Run focused metadata, identity, onboarding, retrieval, immutability,
  consent-snapshot, SQLite, and PostgreSQL tests.
- [ ] Regenerate checked-in contract and route artifacts after the schemas and
  adapters settle.
- [ ] Run `openspec validate define-source-declaration-discovery-and-trust --strict`.
- [ ] Run `openspec validate --all --strict`.
- [ ] Run a target diff check and stale sweeps for removed maxLength numbers,
  parsed-JSON comparison, redirect-following, quarantine workflow, duplicated
  snapshots/evolution, invented legacy acceptance fields, and client-selected
  authorities.
