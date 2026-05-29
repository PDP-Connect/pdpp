## Context

The current reference implementation has converged on the right connection model: `connection_id` is the owner/client-facing configured source identity, and `connector_instance_id` is no longer the public noun. The remaining construction gap is one level higher. The same codebase still uses URL-shaped `connector_id` values as operational connector type ids, as manifest registry identifiers, as storage binding keys, as consent form values, and as route/query parameters.

That overload creates incidental complexity:

- URL-shaped values are unsafe in home-grown delimiter formats such as `connection:<connector_id>:<connection_id>`.
- Owner-facing surfaces can leak registry URLs where the owner expects a connector type name.
- Stale local-collector aliases and compatibility connector ids look like real sources.
- Migration and dedupe rules have to understand several names for the same connector type.
- MCP and REST clients see a mixed identity model even though grants and reads now need a stable `connection_id`.

The SLVP construction is to separate the essential facts:

- `connector_key`: the canonical operational connector type key, such as `gmail`, `slack`, `claude-code`, or `codex`.
- `manifest_uri`: a registry/document URI for the manifest, such as `https://registry.pdpp.org/connectors/gmail`.
- `connection_id`: the configured owner source/account/device/profile identity.
- `display_name`: owner-facing connection label.

## Goals / Non-Goals

**Goals:**

- Make `connector_key` the only active connector type key in the reference implementation.
- Preserve manifest/registry URIs as metadata, not primary keys.
- Migrate existing deployments without data loss.
- Remove active compatibility aliases rather than hiding them.
- Make consent, MCP package, dashboard, and local-collector selection delimiter-safe and connection-scoped.
- Keep the Core/Collection/reference boundary honest: this is a reference implementation identity cleanup unless later root protocol work promotes a corresponding protocol rename.

**Non-Goals:**

- Do not change `connection_id` semantics or re-open the fan-in/default grant-package design.
- Do not make one cross-source PDPP grant. Grant packages still issue source-bounded child grants.
- Do not keep a long-lived URL alias compatibility path.
- Do not redesign connector manifests beyond the identity fields needed here.
- Do not solve connector-green work in this change.

## Decisions

### 1. Canonical operational identity is `connector_key`

Use a short, slug-like key for active connector type identity. It is the value used in storage bindings, source bindings for connector-backed sources, route parameters, local collector config, manifest registration rows, and owner/client surfaces.

Alternatives considered:

- Keep URL-shaped `connector_id`: rejected because it already produced parser bugs and keeps registry/document identity complected with runtime identity.
- Keep field name `connector_id` but change the value to a short key: rejected as the final target because it preserves the ambiguity that caused this drift. It may be used internally during migration only when a broad rename would create unnecessary churn in one commit.
- Use `manifest_uri` everywhere: rejected because it makes runtime keys depend on registry URL policy.

### 2. `manifest_uri` is metadata

First-party manifests declare both `connector_key` and `manifest_uri`. The manifest URI may be shown as provenance or registry metadata, but it is not used as the operational key, not parsed out of form values, and not required in grant-scoped client calls.

### 3. Migration is one-time and data-preserving

The migration maps every known URL-shaped first-party connector id and stale local alias to exactly one canonical key. It rewrites all persisted operational references in one audited pass. Unknown third-party URL identifiers are not silently accepted as canonical first-party keys; they are either rejected with an explicit migration error or mapped by an operator-supplied custom manifest that declares a canonical key.

Rollback strategy is database backup restore. This is a breaking cleanup, not a reversible runtime toggle.

### 4. Selection values are structured or opaque

Hosted MCP consent and dashboard forms SHALL not encode `connector_key` and `connection_id` by concatenating user-controlled or manifest-controlled strings with delimiters. They should use an opaque connection id when possible, or a JSON/base64url payload validated server-side when multiple fields are unavoidable.

### 5. No user-visible `legacy` as compatibility posture

Legacy rows are migrated, quarantined for owner review only if they cannot be mapped without risking data loss, or deleted when data-free and provably stale. The final operator and client surfaces do not display `legacy`, `legacy_default`, registry URLs, or stale aliases as selectable sources.

### 6. Documentation follows implementation

Reference docs and examples should teach `connector_key` for the reference implementation. Root protocol docs that still use URI-shaped `connector_id` examples are audited and either updated in the same tranche if the change is reference-only wording, or captured as a separate protocol-spec change if the root PDPP contract itself needs renaming.

### 7. Local-device records use the bare `connector_key`; the `local-device:` storage prefix is legacy

Local-device exporter records, sync state, record changes, version counters, and blob bindings SHALL be stored under the bare canonical `connector_key` (e.g. `codex`, `claude-code`), the same operational key used by API- and browser-collected records for the same connector type. Connection-level disambiguation between a local-device connection and an account connection for the same connector type is carried entirely by `connector_instance_id`, not by a storage-key namespace prefix.

The historical `local-device:<connector_key>[:<source_instance_id>]` storage prefix is migration-only. It is not a first-class storage form: the canonical-key migration writer (`scripts/canonical-connector-keys/`) already collapses `local-device:claude_code` and `local-device:claude_code:cin_…` to the bare canonical key `claude-code`, and Decision 1 requires the bare key for "storage bindings, source bindings for connector-backed sources, …".

Why `connector_instance_id` is sufficient and the prefix is redundant:

- The owner-dashboard record projection (`ref-control.ts::getConnectorRecordProjection`) and the public read path scope record reads by `connector_instance_id` when one is available, which is always true for an enrolled local-device connection. The storage-key argument is not consulted on that branch, so the prefix never participates in read isolation.
- A local-device connection and an account connection for the same connector type already mint distinct `connector_instance_id` values, so device records cannot collide with owner-auth `/v1/state` or `/v1/records` rows for the same connector type. The prefix was a second, redundant isolation mechanism for an isolation that `connector_instance_id` already provides.

Alternatives considered:

- Keep `local-device:<connector_key>` as the durable storage form: rejected. It contradicts the migration writer's already-shipped collapse behavior and Decision 1, reintroduces a per-source storage namespace the connector-instance model replaced, and keeps two competing keys for the same records (the exact drift this change exists to remove).
- Revert the bare-key ingest write path (commit `4f59323b`) back to the prefix: rejected for the same reasons; it would re-complect record-storage identity with a legacy marker.

Active-path consequences (this is the slice that closes task 4.3 for local-device storage):

- The device-exporter enroll path canonicalizes the owner-supplied `connector_id` once, at the boundary, so the catalog `connectors` row, the `connector_instances` row, the `device_source_instances` row, and the record storage target all agree on one canonical key. This removes the `claude_code`→`claude-code` foreign-key failure where the catalog was registered canonically while the instance referenced the raw alias.
- The live read path (`recordStorageConnectorIdForConnection`) and the device-scoped state read/write paths use the bare canonical key.
- The legacy startup migration `local_device_connector_instances` relocates legacy `local-device:<id>:<source>` rows to the bare canonical key (canonicalizing the inner alias), not to a still-prefixed `local-device:<id>` form, so post-migration reads resolve under the same key the live ingest path writes.

### 8. Read/admission resolves through the same canonical construction as ingest

The write path already canonicalizes: the owner ingest route (`resolveOwnerConnectorNamespace`) and the device-exporter enroll path collapse a URL-shaped or legacy-alias `connector_id` to its `connector_key`, so `connector_instances`, `records`, and blob bindings are all keyed canonically. The read/admission path had not been made symmetric — a stale grant or owner read scope could still carry a URL-shaped `connector_id`, and admission enumerated active connections under that literal value. Because no instance is keyed by the URL, admission returned an empty binding set and the read failed `connection_not_found` (observed across `assistant-readiness-smoke`, `query-contract`, `connector-instance-admission-routes`, and grant-scoped blob reads).

Decision: canonicalize the connector key at the read/admission construction boundaries, accepting a legacy URL alias at the edge and immediately resolving it to the canonical key — the same pattern `getConnectorManifestRow` already uses for manifest lookup. Concretely:

- `resolveReadRequestBindings` (the shared admission resolver for owner reads, grant-scoped client reads, and search fan-in) canonicalizes `storageBinding.connector_id` before calling `listActiveByConnector`. This is the single boundary that fixes owner, client, and search admission at once.
- `resolveOwnerReadScope` canonicalizes the owner-supplied `connector_id` once, so the owner read storage binding, source descriptor, and `connector_instances` namespace resolution all agree on the canonical key (the same fix the ingest path already had).
- The `GET /v1/blobs/:blob_id` route canonicalizes the actor connector id before matching canonically-keyed blob bindings.
- The reference-only `/_ref/connections` and `/_ref/connector-instances` list routes canonicalize the `connector_id` query filter before comparing against canonically-keyed instance rows.

The canonicalization is conservative by construction: `canonicalConnectorKey` returns `null` for unknown/third-party URL shapes, and every call site uses `canonicalConnectorKey(x) ?? x`, so custom/third-party connector keys pass through unchanged and remain internally consistent (catalog, instance, and admission all apply the same identity function). Legacy aliases are accepted only at these boundaries and never become a parallel first-class path.

Alternatives considered:

- Canonicalize when the grant is minted (rewrite `grant_storage_binding.connector_id` at issue time): rejected for this slice because it would also require rewriting `grant.source.id` to keep the `grant.source.id === grant_storage_binding.connector_id` validator satisfied, changing durable grant storage shape. The admission-boundary canonicalization fixes the read symptom without re-opening grant storage semantics; a future grant-mint canonicalization can subsume it without contradicting this decision.
- Fix each read route independently: rejected in favor of the shared `resolveReadRequestBindings` boundary, with the owner-scope, blob-route, and `/_ref` list canonicalizations added only where a route compares connector ids outside that resolver.

## Risks / Trade-offs

- **Protocol/reference terminology drift** -> Mitigation: keep this OpenSpec scoped to reference capabilities and explicitly audit root spec docs before changing protocol language.
- **Data loss during migration** -> Mitigation: require backup, dry-run summary, row counts by table before/after, and idempotent mapping tests.
- **Third-party/custom connector breakage** -> Mitigation: require custom manifests to declare a canonical key and manifest URI; fail closed on ambiguous URL-only rows.
- **Large rename churn** -> Mitigation: allow internal helper names to lag only inside a bounded compatibility section, but prohibit URL-shaped values and user-facing alias support from remaining.
- **Workers over-fit to the observed `https` parser bug** -> Mitigation: acceptance checks grep for URL-shaped connector ids across active contracts, fixtures, docs examples, and UI strings.

## Migration Plan

1. Add identity normalization helpers and mapping fixtures from current first-party URL ids and local aliases to canonical keys.
2. Add dry-run migration that reports affected rows and unmapped identifiers without writing.
3. Add write migration that rewrites connector manifests, storage bindings, grants, package members, record metadata, search indexes, blob bindings, schedules, runs, state, coverage/gap tables, event subscriptions, and dashboard summaries.
4. Update runtime readers to require canonical keys and fail on URL-shaped active keys after migration.
5. Update forms and routes to use structured/opaque selections.
6. Update docs and tests.
7. Run the migration against a backup of the current deployment, verify row counts and owner dashboard state, then deploy.

## Open Questions

- Whether the root PDPP Core spec should rename `connector_id` to `connector_key` or retain URI-shaped protocol identifiers while the reference implementation uses canonical keys internally. This change must not silently change root protocol semantics without a root-spec decision.
- Whether third-party custom connector keys need a namespace rule beyond slug uniqueness in one owner deployment. The first tranche can require local uniqueness and leave global registry policy to a later protocol/spec change.
