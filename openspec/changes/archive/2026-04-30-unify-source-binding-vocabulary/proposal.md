## Why

PDPP's protocol distinction between native providers and polyfill connectors is essential complexity: who hosts the server, who signs artifacts, who is accountable. The current realization, however, expresses that distinction with **two parallel public identifier vocabularies** (`provider_id` and `connector_id`) that are not unified into a single discriminated source identity. The runtime already discriminates internally with `binding_kind: 'connector' | 'provider_native'`, but the public type, the storage schema, and the spec text continue to treat the two identifiers as sibling first-class fields. The result is incidental complexity that is paid by every reader, every caller, and every implementer:

- `spine_events` carries a top-level `provider_id` column with **no matching `connector_id` column**. Every polyfill row leaves `provider_id` null; every queryer who filters by `WHERE provider_id = ?` silently excludes the polyfill half of the world. A careful auditor reading the database has already mistaken the null for a bug.
- `AuthorizationDetailBaseSchema` and `GrantSourceSchema` declare both fields as siblings and enforce mutual exclusivity through a JSON-Schema `oneOf` constraint, rather than through a single discriminated union the code already speaks (`packages/reference-contract/src/public/index.ts:183-217`).
- `requireStructuredSourceBinding` and its grant-side twin in `reference-implementation/server/auth.js:600-787` re-check the same shape constraint **eight times** with `hasExactBindingKeys`, once per (request | grant) × (connector | provider_native) cell, because the type system cannot express the sum.
- The architecture spec's "Native and polyfill realizations stay honest" requirement (`openspec/specs/reference-implementation-architecture/spec.md:28-46`) names two parallel public identifiers and forces every downstream consumer (web bridge, owner-mode RS, tests, docs) to learn the parallel vocabulary.

The protocol-level invariant is one-of-N source identity. The current encoding is N parallel scalars with an external XOR rule. This proposal collapses the public vocabulary to a single discriminated `source = { kind, id }` shape and lets `provider_id` / `connector_id` survive only as kind-keyed aliases inside that shape, never as top-level public scalars. The spec text shrinks, the schema can express the constraint, the validator folds to one stanza, and readers stop tripping over null columns.

## What Changes

- Establish a canonical public **source object** shape — `{ kind: 'connector' | 'provider_native', id: string }` — used by every public artifact (PAR `authorization_details`, grant `source`, spine event row, well-known discovery hints, owner-mode error messages, web-bridge contract).
- **BREAKING** Public request bodies and grant artifacts SHALL use the canonical source object. Top-level public `provider_id` and `connector_id` scalars are removed from the request and grant contract; the kind-keyed `id` field carries the identity. Callers that previously sent `connector_id` or `provider_id` send `{ source: { kind, id } }` instead.
- **BREAKING** The `spine_events` table replaces top-level `provider_id` with a `source_kind` + `source_id` pair. Existing rows are migrated forward in place. Reference-only readers (`/_ref/...`) and the spine-search index update to query the unified columns.
- Collapse `requireStructuredSourceBinding`, `requireStructuredPendingRequestBindings`, and `requireStructuredGrantBindings` into a single validator that branches once on `kind` and rejects mismatched shapes via a single declarative schema rather than four `hasExactBindingKeys` arms.
- Update `openspec/specs/reference-implementation-architecture/spec.md` Requirement "Native and polyfill realizations stay honest" so each scenario names the unified source object instead of dual identifiers.
- Update `openspec/specs/reference-native-provider-boundary/spec.md` so native-provider scenarios reference `source.kind = 'provider_native'` rather than `provider_id` as a top-level scalar.
- Update `openspec/specs/reference-implementation-architecture/spec.md` Requirement "The public query surface SHALL expose a minimal connector discovery floor" so the discovery floor reports the unified source object on each item, with `connector_id` retained only as a polyfill-mode display alias.
- Internal storage in tables that always carry connector identity (`records`, `record_changes`, `connector_state`, `grant_connector_state`, `version_counter`) keeps the `connector_id` column. The native realization continues to use a registered `storage_binding.connector_id` for that internal identity, in line with the existing "Internal storage remains connector-shaped" scenario.
- Document `provider_id` and `connector_id` as kind-keyed aliases in the contract and the README so existing references to the two names remain decipherable while the canonical surface uses the unified object.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `reference-implementation-architecture`: replace dual-identifier scenarios under "Native and polyfill realizations stay honest" with unified-source-object scenarios; update the connector discovery floor requirement so item identity is the unified source object.
- `reference-native-provider-boundary`: rephrase the native-grant and native-public-artifact scenarios in terms of the unified source object with `kind = 'provider_native'`.

## Impact

- `packages/reference-contract/src/public/index.ts` — replace `AuthorizationDetailBaseSchema` and `GrantSourceSchema` dual-field shapes with a single discriminated `SourceObjectSchema`; remove the `oneOf` constraint.
- `packages/reference-contract/src/builders/index.ts` — `ParRequestInput` and `buildParRequest` accept and pass through the unified source object; old `connector_id` / `provider_id` keys are rejected at build time with a migration error.
- `reference-implementation/server/auth.js` — collapse `requireStructuredSourceBinding`, `requireStructuredPendingRequestBindings`, and `requireStructuredGrantBindings` into a single validator; remove the four `hasExactBindingKeys` arms guarding source-binding shape.
- `reference-implementation/server/db.js` — alter the `spine_events` schema: drop top-level `provider_id`, add `source_kind` and `source_id`; ship a forward-migration that derives values from existing rows' `data_json.source`.
- `reference-implementation/lib/spine.ts` — update `SpineEventRecord`, `NormalizedSpineEvent`, `SpineEventRow`, the insert SQL, the search aggregator, and the filter list to use `source_kind` / `source_id`.
- `reference-implementation/server/index.js` — update routes that produce or filter by source identity (`/_ref/...` readers, owner-mode RS surfaces, well-known discovery hints) to emit the unified source object.
- `reference-implementation/test/**` — migrate test assertions that name `provider_id` / `connector_id` as top-level fields to the unified shape. The two largest call sites (`pdpp.test.js`, `cli.test.js`) carry most of the volume.
- `apps/web/` bridge routes that currently echo `provider_id` or `connector_id` from underlying responses adopt the unified shape; the `reference-web-bridge-contract` capability document is reviewed for honesty, not modified, since it already defers to the underlying reference contract.
- `README.md` "native provider access identified publicly with `provider_id`" / "polyfill access identified publicly with `connector_id`" lines are rewritten to introduce the source object first, with the legacy names presented as kind-keyed aliases.
- `docs/agent-skills/pdpp-data-access/SKILL.md` and `docs/agent-skills/pdpp-data-access/references/grant-design.md` are rewritten to instruct callers to construct a single source object rather than to "pick one xor the other."
