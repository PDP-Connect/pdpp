# Tasks

- [ ] 1. Define the neutral Core contract and examples.
  - Add the complete SourceDeclaration shape, 2020-12 schema rules, source
    kind/id semantics, per-stream instance handles, extension ownership, and
    omission and uniqueness rules.
  - Keep the change focused. Do not perform a broad cosmetic `Manifest` rename.

- [ ] 2. Define request and resolved-grant serialization.
  - Add complete shapes for request and grant, including source matching,
    stream instance IDs, concrete names, fields, frozen time constraints,
    canonical resources, the retained Core grant fields,
    `source_declaration.version`, and omission rules.
  - Require unique non-empty approved handles and fields. Prove that omitted
    request handles never authorize fan-in.
  - Emit binding-neutral `source.authorization_details_invalid` when a request
    violates the Source request or narrowing contract. Leave the OAuth response
    mapping to PR89.

- [ ] 3. Implement snapshot and mutation barriers.
  - Pass one exact snapshot through validation, display, narrowing, issuance,
    and evidence.
  - At barriers before display, narrowing, and issuance, mutate, delete, and
    same-version-replace the current catalog entry. Prove every phase still
    uses the retained snapshot and fails closed if that snapshot is lost.

- [ ] 4. Separate authorization facts from serving metadata.
  - Make RS enforcement use only the resolved authorization context.
  - Permit current metadata only to route, describe current schemas, or reject
    unsupported query capabilities. It must not reinterpret resource keys,
    widen grants, or change the time field frozen in the grant.

- [ ] 5. Migrate persisted authorization data.
  - Cover pending consent, grants, packages, current per-stream `connection_id`,
    and absent or ambiguous connection mappings.
  - Preserve original bytes as evidence and write a separate resolved
    projection. Never convert absent mappings into current fan-in.
  - Make the local legacy adapter reject streams without an unambiguous issuer,
    subject, source ID, stream, and instance mapping.

- [ ] 6. Add implementation oracles and ownership gates.
  - Add a Core-only dependency oracle that imports no Collection schema or
    runtime module and proves a connector declaration works without an
    extension.
  - Add the three-PR ownership and merge-order matrix: Source owns the neutral
    contract, PR89 owns the OAuth carrier, and discovery owns retrieval/trust.
  - Limit Collection work to reference relocation and compatibility.

- [ ] 7. Verify the change.
  - Run focused contract, snapshot, instance, migration, and RS tests.
  - Run `openspec validate define-source-declarations-and-resolved-grants
    --strict`, `git diff --check`, and stale-term sweeps for deleted live
    declaration lookups, implicit fan-in, broad renames, and excluded scope.

## Acceptance checks

- A Core-only connector declaration validates, renders consent, issues a grant,
  and supports grant-filtered reads without importing Collection code.
- Every issued stream has a concrete name, unique non-empty handles and fields;
  fan-in requires an explicit array.
- A declaration mutation, deletion, or same-version replacement between any
  barrier cannot change display, narrowing, issuance, evidence, or an existing
  grant.
- RS decisions remain stable when the current declaration is absent or changed,
  subject only to lifecycle and serving-capability rejection.
- Legacy absent or ambiguous `connection_id` mappings do not authorize reads.
