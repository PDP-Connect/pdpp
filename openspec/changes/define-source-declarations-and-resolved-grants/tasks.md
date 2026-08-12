# Tasks

- [x] 1. Define the neutral Core contract and examples.
  - Add the complete SourceDeclaration shape, 2020-12 schema rules, source
    kind/id semantics, per-stream instance handles, extension ownership, and
    omission and uniqueness rules.
  - Preserve existing Core stream description/display, record semantics,
    cursor, selection, views, relationships, and query capabilities for both
    source kinds. Move only connector acquisition and execution mechanics to
    the optional Collection extension.
  - Rename Core `resource_ref.connector_id` to `source_id` so record references
    use the same source-neutral identity.
  - Keep the change focused. Do not perform a broad cosmetic `Manifest` rename.

- [x] 2. Define request and resolved-grant serialization.
  - Add complete declared-source, requested-source, and approved-source shapes,
    including source matching, optional requested and required approved
    instance IDs, concrete names, fields, frozen time constraints,
    canonical resources, the retained Core grant fields,
    `source_declaration.version`, and omission rules.
  - Keep declaration and grant `source.kind` required as AS-derived provenance.
    Allow request `source.kind` only as an optional client trust expectation.
    Never use kind to select runtime.
  - Require unique non-empty approved instance IDs and fields on every grant
    stream. Prove that omitted requested instance IDs never authorize fan-in.
  - Reject duplicate stream names inside each selection preset during
    SourceDeclaration validation.
  - Emit binding-neutral `source.authorization_details_invalid` when a request
    violates the Source request or narrowing contract. Leave the OAuth response
    mapping to PR89.

- [x] 3. Implement snapshot and mutation barriers.
  - Pass one exact snapshot through validation, display, narrowing, issuance,
    and evidence.
  - At barriers before display, narrowing, and issuance, mutate, delete, and
    same-version-replace the current catalog entry. Prove every phase still
    uses the retained snapshot and fails closed if that snapshot is lost.

- [x] 4. Separate authorization facts from serving metadata.
  - Make RS enforcement use only the resolved authorization context.
  - Define separate client-token and owner/discovery metadata projections.
    Client schema, stream, search, and record metadata must be grant-projected;
    owner/discovery metadata may be current capability. Current metadata may
    route or reject unsupported resolved constraints, but must not reinterpret
    resource keys, widen grants, or change the frozen time field.

- [x] 5. Make the authorization-state break fail closed.
  - Accept only the new retained-snapshot pending shape and closed resolved
    grant shape after this change.
  - Reject pre-v0.1 pending consent, grants, and packages and require fresh
    consent. Do not add projection columns, historical reconstruction, or a
    legacy authorization adapter.
  - Prove that a legacy per-stream `connection_id` never becomes one or more
    current `instance_ids` during approval or serving.

- [x] 6. Add implementation oracles and ownership gates.
  - Add a Core-only dependency oracle that imports no Collection schema or
    runtime module and proves a connector declaration works without an
    extension.
  - Relocate POST ingest, state endpoints, grant-scoped collection state,
    concurrent collection, and Collection conformance tiers from Core into
    `spec-collection-profile.md` without changing their behavior.
  - Add and enforce the five-PR matrix: Source Contract, Source RI, PR89 Auth
    Carrier, Discovery Contract, and Discovery RI. Keep protocol contracts
    separate from reference implementation adoption. Do not make retrieval a
    grant-enforcement dependency or create a second grant shape.
  - Limit other Collection work to compatibility with the neutral contract.

- [x] 7. Verify the change.
  - Run focused contract, snapshot, instance, upgrade-boundary, and RS tests.
  - Run `openspec validate define-source-declarations-and-resolved-grants
    --strict`, `git diff --check`, and stale-term sweeps for deleted live
    declaration lookups, implicit fan-in, broad renames, and excluded scope.
  - Reviewer correction: move the client-token query-time view rule into the
    Source Contract, and require the final approval artifact/revision and
    retained consent evidence to bind rendered `client_claims` without adding
    them to grant rights.

## Acceptance checks

- A Core-only connector declaration validates, renders consent, issues a grant,
  and supports grant-filtered reads without importing Collection code.
- Every issued grant stream has a concrete name, fields, and a unique non-empty
  instance array; fan-in requires an explicit array on that stream.
- Request omission of `source.kind` is valid, but SourceDeclaration omission is
  invalid. A supplied request kind is a trust expectation, not runtime
  selection.
- Duplicate stream names inside one selection preset are rejected before grant
  resolution.
- Omitted instance IDs are resolved before the final approval surface. The
  exact resolved instances and final decision fields are bound to an immutable
  review revision or digest, and stale eligibility or revision requires a new
  review.
- A declaration mutation, deletion, or same-version replacement between any
  barrier cannot change display, narrowing, issuance, evidence, or an existing
  grant.
- RS decisions remain stable when the current declaration is absent or changed,
  subject only to lifecycle and serving-capability rejection.
- Client-token records reads reject query-time `view`; owner-token reads may
  resolve current views.
- Rendered `client_claims` are bound into the final approval artifact and
  review revision, retained consent evidence preserves that binding, and the
  claims are not part of the resolved grant or RS enforcement.
- Pre-v0.1 authorization rows and legacy `connection_id` grant shapes do not
  authorize reads.

## P1-2 client expansion closure checkpoint

- [x] Record that valid issuance materializes required relationship foreign
  keys, so the review's hidden-ungranted-field example is not reproducible.
- [x] Reject client-token `expand[]` and `expand_limit[...]` before current
  declaration or serving metadata on list, detail, aggregate, and search
  routes. Preserve owner-token current-capability expansion.
- [x] Prove SQLite and live-PostgreSQL parity with a same-name relationship
  repointed to a different granted stream and foreign key after issuance.

## PR114 corrective checkpoint

- [x] Single-source approval requires a persisted reviewed revision before
  issuance.
- [x] The reviewed artifact freezes retained declaration evidence, source,
  exact resolved instance IDs, streams, fields, resources, time, purpose,
  retention, client, subject, and grant expiry.
- [x] Single-source approval recomputes the reviewed artifact after current
  instance eligibility revalidation and rejects stale review revisions.
- [x] Single-source approval writes the pending-row CAS claim, grant, token,
  approval events, and final approved state in one SQLite or PostgreSQL
  transaction, with a typed conflict for CAS losers.
- [x] Request-time source fulfillment no longer falls back from source kind/id
  to a canonical connector key. Source fulfillment must be explicit.
- [x] Selection request `source.kind` may be omitted; when omitted, the AS
  derives provenance from the retained declaration. SourceDeclaration and
  resolved grants still require `source.kind`.
- [x] Staged batch approval uses the same reviewed-artifact and atomic
  transaction seam. The finalized batch review binds approved source indexes,
  exact resolved source/stream facts, parent linkage, member order, and the
  posted review revision before issuing the package.
