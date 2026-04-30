## Context

The reference implementation supports two realizations of every PDPP grant: a **native provider** (the platform itself speaks PDPP, signs its own artifacts, hosts its own AS+RS) and a **polyfill connector** (a third party bridges an existing platform that does not speak PDPP). The two realizations differ in who hosts the server, who is accountable for misissuance, and who can rotate signing keys. This is essential complexity: it is a fact about the world the protocol must encode honestly. The architecture spec already treats both realizations as first-class, running on one engine substrate, with public artifacts identifying the source by realization (`openspec/specs/reference-implementation-architecture/spec.md:28-46`).

The current encoding of that essential complexity is what this change targets:

- **Public type, today**: `AuthorizationDetailBaseSchema` declares `connector_id` and `provider_id` as sibling top-level fields, and `AuthorizationDetailSchema` enforces "exactly one" through a JSON-Schema `oneOf` allOf-clause (`packages/reference-contract/src/public/index.ts:183-217`).
- **Storage, today**: `spine_events` has a top-level `provider_id` column and **no** matching `connector_id` column. Polyfill rows leave `provider_id` null; native rows would populate it. Records, change feeds, lexical, and semantic indices all use only `connector_id` because in native mode the registered `storage_binding.connector_id` carries the internal identity.
- **Validation, today**: `reference-implementation/server/auth.js:600-787` runs four near-identical `hasExactBindingKeys` arms — request × {connector, provider_native} and grant × {connector, provider_native} — to police the constraint that a `binding_kind` value must match exactly one of the two top-level scalars.
- **Spec text, today**: requirements in `reference-implementation-architecture/spec.md` and `reference-native-provider-boundary/spec.md` name the two identifiers in parallel ("SHALL identify that source with `provider_id` rather than with a public `connector_id`"), forcing every downstream reader to learn the dual vocabulary.
- **Docs, today**: `README.md:38-39` and the `pdpp-data-access` skill instruct callers to "pick `connector_id` *xor* `provider_id`."

The runtime, in contrast, already speaks a single discriminated union: every internal source-binding object has `binding_kind: 'connector' | 'provider_native'` plus the kind-keyed identifier. The constraint the JSON-Schema `oneOf` clause enforces externally is the same constraint the discriminator expresses internally — the two layers do not share representation. This change bridges that gap by promoting the discriminated union to the public surface.

The Hickey framing is the lens: essential complexity is "this is a sum type, exactly one of N variants holds." Incidental complexity is "we expressed the sum type as N parallel scalars at the public boundary, then taxed every consumer with the rule."

## Goals / Non-Goals

**Goals:**

- Promote the discriminated union the runtime already uses (`{ kind, id }` keyed by `binding_kind`) to the canonical public source-identity shape used by every public artifact: PAR `authorization_details`, grant `source`, spine event row, web-bridge contract, well-known discovery hints, and owner-mode error messages.
- Replace the dual-column `spine_events.provider_id` (with no matching `connector_id`) with a `source_kind` + `source_id` pair so spine queries treat polyfill and native rows symmetrically, and so a careful auditor cannot mistake a null for a bug.
- Collapse the four-arm `hasExactBindingKeys` validator in `auth.js` into one declarative schema check.
- Keep internal connector-shaped storage (`records`, `record_changes`, `connector_state`, etc.) untouched — that storage already lives behind a single `storage_binding.connector_id`, and the architecture spec's existing scenario "Internal storage remains connector-shaped" already authorizes that asymmetry. We are unifying the *public* identity vocabulary, not collapsing native and polyfill into one runtime mode.

**Non-Goals:**

- We do not change the protocol-level distinction between native and polyfill realizations. The two remain distinct trust postures with distinct accountability. The change only renames the public vocabulary the protocol uses to talk about each.
- We do not deprecate `connector_id` or `provider_id` as concepts. They become kind-keyed aliases inside the unified source object: `source.id` when `source.kind === 'connector'` is what `connector_id` used to mean, and analogously for `provider_native`. They do not survive as top-level public scalars.
- We do not unify storage tables across native and polyfill. The architecture explicitly preserves connector-shaped internal storage.
- We do not touch the `add-polyfill-connector-system` shadow-bug fix (`design-notes/connector-binding-shadow-bug-2026-04-24.md`), which is orthogonal — it is about resolution priority between fixture and polyfill manifests, not about the public identity shape.

## Decisions

### Decision 1: `source` is a discriminated union with two keys, not a tagged scalar

Two reasonable shapes were considered for the public source object:

- **Tagged scalar**: `source: "connector:https://registry.pdpp.org/connectors/github"` — one string with a kind prefix.
- **Object with `kind` + `id`**: `source: { kind: "connector", id: "https://registry.pdpp.org/connectors/github" }`.

The object form wins because:

1. The runtime already speaks `binding_kind` + a kind-keyed identifier; the object form is one rename away (`binding_kind` → `kind`, plus drop the kind-keyed scalar in favor of `id`). The tagged-scalar form would require a re-parse on every consumer.
2. The object form survives extension. If the protocol ever needs to attach more provenance ("native, signed by key X" / "polyfill, hosted at Y"), additional fields slot into the object without re-parsing the scalar.
3. JSON Schema can express the object form as a discriminated union with a single declaration; the `oneOf` allOf-clause in `AuthorizationDetailSchema` collapses to a `kind` enum + a `properties.id` rule.
4. The spine-event row maps cleanly to two columns (`source_kind`, `source_id`), which preserves index ergonomics.

### Decision 2: `kind` values are `"connector"` and `"provider_native"` — preserve the runtime's existing names

The runtime's discriminator is already `binding_kind: 'connector' | 'provider_native'`. We adopt those names verbatim as the public `kind` values rather than renaming to `"polyfill"` / `"native"`. Reasons:

- Zero internal churn: the change is a contract-shape change, not a renaming exercise.
- The names already appear in error messages (`"source_binding.binding_kind must be 'connector' or 'provider_native'"`); preserving them keeps existing operator runbooks valid.
- "Native" alone is ambiguous (native what — UI? mobile? device?); `provider_native` says exactly what it means.

### Decision 3: Storage migration alters `spine_events` in place rather than dual-writing

The breaking-change cost is paid once at the contract boundary. Alternatives considered:

- **Dual-write window**: keep `provider_id` and add `source_kind`/`source_id`, dual-populate, eventually drop the legacy column. Rejected — the reference is forkable substrate, not a hosted product with a rolling upgrade window. A single migration step in the open-source release is cleaner than a multi-release deprecation.
- **In-place ALTER**: drop `provider_id`, add `source_kind` and `source_id`, backfill from canonical or legacy `data_json.source` / `data_json.source_binding`, payload-level connector/provider fields, existing source columns, legacy `provider_id`, or runtime actor identity for old connector-run rows. **Chosen.** SQLite `ALTER TABLE` is cheap, the rows carry enough source evidence to derive the new columns, and the migration is idempotent.
- **Recreate from `data_json`**: drop and re-derive the columns at startup whenever they are missing. Rejected as too implicit — a migration is the right place to do this once.

`version_counter` is not a schema-version table; it tracks per-connector stream record versions. The migration therefore does not mutate it. SQLite records this schema transition with `PRAGMA user_version`; Postgres relies on idempotent column introspection. The "Pre-existing databases SHALL continue to open and operate" requirement (`reference-implementation-architecture/spec.md:1459`) is honored because the migration runs at startup and is idempotent.

### Decision 4: Internal `connector_id` columns stay

Tables that always carry connector identity (records, record_changes, connector_state, grant_connector_state, version_counter, lexical and semantic search indices) keep their `connector_id` columns unchanged. Even in native mode, `storage_binding.connector_id` carries that internal identity, and the architecture spec's existing scenario "Internal storage remains connector-shaped" explicitly authorizes that asymmetry. We are unifying public identity, not collapsing the storage substrate.

### Decision 5: No public aliases

The contract does not expose kind-keyed source aliases. Callers read `source.kind` and `source.id` everywhere. Keeping a single vocabulary in both wire payloads and helper types avoids a second, historically named API surface.

The README and the `pdpp-data-access` skill present the source object as canonical and mention the old names only once, in a "previously known as" footnote.

### Decision 6: One change, one slice — no deferred sub-slices

The proposal is large but coherent: every line of the migration follows from one decision (promote the discriminator to the public surface). Splitting it into "first the contract, then the storage, then the spec text" would create an awkward intermediate state where the wire format and the storage column disagree. The migration is small enough to ship atomically.

The shadow-bug note in `add-polyfill-connector-system` is orthogonal and continues on its own track.

## Risks / Trade-offs

- **[Risk] Breaking change for external clients of `apps/web` bridge routes that echo `provider_id` or `connector_id` from underlying responses.** → Mitigation: the bridge contract spec (`reference-web-bridge-contract`) already requires the bridge to "reflect the current reference contract honestly," so the bridge follows the reference shape. Any cached downstream consumer (the `/sandbox` mock dashboard, the docs explainer, the trace viewer) is part of the same monorepo and migrates in the same change.
- **[Risk] Spine-events migration could fail mid-flight on a large existing database.** → Mitigation: SQLite ALTER is transactional. The migration runs inside a single transaction; failure rolls back to the prior schema. Pre-migration row count and post-migration row count are asserted equal; mismatch aborts the migration.
- **[Risk] Test surface is large — ~1,258 references to `provider_id` or `connector_id` across 37 test files.** → Mitigation: most references are inside `event.data.source.{provider_id|connector_id}` paths that simply rename to `event.data.source.id` plus a `event.data.source.kind` assertion. The `pdpp.test.js` and `cli.test.js` migrations are mechanical and can be batched. Tasks list breaks them out so a sub-agent can drive the rename in one pass.
- **[Risk] Doc readers see the old vocabulary in archived design notes and may be confused.** → Mitigation: archived OpenSpec changes are explicitly historical (the README reserves `openspec/specs/` as the current source of truth). Active docs (README, agent skills, current spec) all migrate; archived notes stay untouched.
- **[Trade-off] We accept one small ergonomic regression: callers writing PAR requests by hand now type four extra characters (`{kind,id}` vs. a bare scalar). The simplification of the type, schema, validator, storage, and spec text is worth the cost.**

## Migration Plan

The reference implementation is an open-source forkable substrate with no hosted release pipeline; "deploy" means "ship a release tag." The migration plan is therefore:

1. Land the change behind a feature flag is **not** appropriate here — there is no flag boundary in the engine. Instead, ship the change as a single coherent commit so anyone who pulls the new release runs the migration on first startup.
2. The startup migration alters `spine_events` in place, records the SQLite schema transition via `PRAGMA user_version`, and leaves `version_counter` untouched because it is a record-version allocator, not a schema-version table. It is idempotent.
3. Forks running on an older release continue to work; pulling the new release upgrades on first boot.
4. Rollback: reverting the release reverts the schema. The migration explicitly does NOT delete row data — it only renames a column and adds one — so a roll-back release sees a `source_kind` and `source_id` column it does not understand and ignores them. Spine reads from older rows continue to work because the source object is also embedded inside `data_json`.

## Open Questions

- Should the contract surface `connector_id` and `provider_id` as deprecated aliases on the wire format for one release, with a structured `Deprecation` warning, before removing them? The proposal currently rejects this in favor of a clean break, citing the no-rolling-upgrade-window argument. If a fork operator surfaces a real upgrade-coordination concern in review, we revisit.
- Do we want to take the same opportunity to rename `binding_kind` to `kind` everywhere internal, or keep `binding_kind` internal and `kind` public? The proposal currently keeps both names — public uses `kind`, internal continues to use `binding_kind` to avoid mass-renaming a field that already appears in many test assertions. If review prefers a full rename, the task list grows by one mechanical step.
- The `reference-web-bridge-contract` capability is currently a small spec that says the bridge "SHALL allow either `connector_id` or `provider_id` according to the current reference contract." It auto-follows because of that wording, so we propose **not** to modify it. Reviewer should confirm the wording is still honest after the rename — if the bridge needs an explicit scenario for the unified source object, we add a Modified Capabilities entry in a follow-up.
