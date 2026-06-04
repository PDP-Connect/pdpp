## MODIFIED Requirements

### Requirement: Polyfill connector authoring layer SHALL provide a reusable per-record fingerprint cursor

The reference polyfill-connectors package SHALL expose a shared primitive that connector authors can adopt to suppress no-op record emits on streams whose source re-derives the full record each run (archive rebuilds, full-collection refetches, file-mtime triggers, aggregate re-derivation). The primitive SHALL:

- compute a stable per-record fingerprint over the emitted record fields with a caller-declared exclusion list for run-clock fields;
- accept the prior STATE cursor and tolerantly decode the prior fingerprint map (legacy cursor shapes, missing fields, malformed entries SHALL NOT throw and SHALL produce an empty map for those entries);
- answer whether a given record's fingerprint has moved relative to the prior cursor;
- always carry forward the fingerprint of skipped records so the next STATE write does not silently drop them;
- track ids observed in the current run so that, on full-scan streams, fingerprints for ids absent from the current run can be pruned at run boundary;
- expose the prior fingerprint value so a connector with derived-field-preservation policy can read it without breaking the encapsulation.

The derived-field-preservation surface (the prior fingerprint value exposed for read) SHALL support a fingerprint carrier that retains connector-chosen prior body fields, not only an opaque change-detection hash, so a connector that does not re-derive a field this run can carry the prior value forward rather than overwriting it with null. This is the same construction the Codex `sessions` cursor already uses to carry prior `message_count`/`function_call_count` forward when a run does not re-parse the rollout file; it is realized through the shared carry-forward cursor lifecycle and SHALL NOT require a per-connector parallel lifecycle.

Adoption SHALL be opt-in. Connectors whose source provides a strong incremental cursor SHALL NOT be forced to use the primitive. The primitive SHALL NOT modify the public RECORD or STATE wire shape; the fingerprint map is carried inside the connector's STATE cursor, which is already opaque to the runtime.

The runtime byte-equivalence no-op check at the storage layer SHALL remain in force as a backstop. The authoring-layer primitive SHALL NOT be relied on as the sole churn-prevention layer.

#### Scenario: Identical second run emits no records

- **WHEN** a connector adopts the primitive on a stream and the source state has not moved between runs
- **THEN** the second run SHALL emit zero RECORD messages for that stream
- **AND** the STATE cursor for that stream SHALL still carry the full per-record fingerprint map forward

#### Scenario: Run-clock field does not cause a re-emit

- **WHEN** a record's fingerprint excludes a run-clock field (e.g. `fetched_at`) and only that field advances between runs
- **THEN** `shouldEmit` SHALL return `false`
- **AND** the prior fingerprint SHALL be preserved in the next STATE write

#### Scenario: Source mutation re-emits exactly that record

- **WHEN** the source value of a single record changes between runs
- **THEN** `shouldEmit` SHALL return `true` for that record and `false` for unchanged records
- **AND** only the changed record SHALL appear in the run's RECORD output

#### Scenario: Source deletion is pruned at run boundary

- **WHEN** a record present in the prior cursor is not observed on a requested full-scan stream this run
- **THEN** the prune operation SHALL remove that id from the next STATE cursor
- **AND** a later re-add of the same id SHALL re-emit the record rather than be silently skipped as a no-op

#### Scenario: Legacy or malformed prior state is tolerated

- **WHEN** the prior STATE cursor has no `fingerprints` field, has a malformed shape, or contains entries with the wrong value type
- **THEN** the primitive SHALL produce an empty prior map for the malformed portion
- **AND** the run SHALL proceed without throwing and re-emit every record as new

#### Scenario: A non-re-derived field is carried forward, not nulled

- **WHEN** a connector with a derived-field-preservation policy does not re-derive a body field this run (the run did not re-parse or re-fetch the source for that record)
- **THEN** the connector SHALL be able to read the prior fingerprint carrier's value for that field and carry it forward
- **AND** the field SHALL NOT be overwritten with null solely because this run did not re-derive it
- **AND** when the carried-forward body is otherwise byte-identical modulo run-clock fields, `shouldEmit` SHALL return `false`

## ADDED Requirements

### Requirement: Statement connectors SHALL carry forward prior hydrated PDF pointers on a hydration failure

The reference statement connectors (`chase/statements` and `usaa/statements`) emit one `statements` record per index row, with content-addressed hydrated pointers (`document_url`, `pdf_path`, `pdf_sha256`, whose path embeds the sha256) populated on a successful PDF download and absent otherwise. When a run fails to hydrate a statement's PDF, the connector SHALL distinguish two cases by the statement's prior STATE cursor, keyed by the immutable statement `id`:

- **Previously hydrated.** If the prior cursor shows the statement was hydrated on an earlier run, the connector SHALL re-emit the prior `document_url`/`pdf_path`/`pdf_sha256` (carry-forward) rather than emitting them as null. Because the pointers are content-addressed, the carried-forward body asserts the artifact's last known content-addressed location — which remains valid (the bytes never move) — and SHALL NOT assert that this run re-verified the artifact.
- **Never hydrated.** If the prior cursor has no hydrated pointers for the statement, the connector SHALL emit the index-only body with all three pointer fields null, exactly as today, so the client still learns the statement exists.

In both cases the connector SHALL still emit a per-run `SKIP_RESULT` (reason `pdf_download_failed`, or the connector's failed-hydration reason) recording that this run did not download the PDF. The `SKIP_RESULT` remains the authoritative run-level record that this run did not re-fetch the bytes; the carried-forward record body is not a claim of fresh verification. This mirrors the first-party blob-hydration honesty rule that a connector "SHALL NOT fabricate a `blob_ref` for bytes it did not store" — carry-forward of a content-addressed pointer to bytes a prior run did store is permitted; fabricating a pointer to bytes no prior run stored is not.

A first hydration (`null -> value`: a statement that was index-only and is hydrated on a later run) SHALL remain a real version boundary and SHALL version exactly once. A genuine change to a statement's immutable identity fields SHALL still re-version. Carry-forward SHALL key on statement `id` and SHALL NOT mask a real change.

The carry-forward source SHALL be the connectors' existing per-statement STATE cursor, extended to retain the prior hydrated pointers keyed by statement `id`, realized through the shared per-record fingerprint cursor's derived-field-preservation surface. This SHALL NOT add a new stream, a new manifest field, or any change to the public RECORD or STATE wire shape; the retained pointer map lives inside the connector's opaque STATE cursor. Legacy cursors that retained only a change-detection hash (or no map) SHALL decode tolerantly to an empty prior-pointer map, so the first post-deploy run re-emits each statement at most once and rebuilds the map.

This requirement supersedes the connectors' prior contract that a failed hydration always emitted an all-null index-only body; the all-null body is retained only for the never-hydrated case.

#### Scenario: A previously hydrated statement that fails re-hydration carries its pointers forward

- **WHEN** run A hydrates statement `id` (body carries `pdf_path`/`pdf_sha256`/`document_url`) and a later run B fails to download the same statement's PDF
- **THEN** run B SHALL re-emit the prior `pdf_path`/`pdf_sha256`/`document_url` for `id` rather than null
- **AND** the carried-forward body SHALL be byte-identical modulo the run-clock `fetched_at`, so the per-statement fingerprint gate emits NO new version for `id`
- **AND** run B SHALL still emit a `pdf_download_failed` `SKIP_RESULT` for the statement

#### Scenario: A never-hydrated statement that fails hydration stays index-only

- **WHEN** a run fails to download the PDF for a statement `id` that the prior cursor never hydrated
- **THEN** the connector SHALL emit an index-only body with `pdf_path`, `pdf_sha256`, and `document_url` all null
- **AND** the statement's identity fields (`id`, `account_id`, `title`, `date_delivered`) SHALL survive on the index-only record

#### Scenario: First hydration still versions exactly once

- **WHEN** run A emits a statement index-only (never hydrated) and run B successfully hydrates the same `id`
- **THEN** run B SHALL emit exactly one new version carrying the populated `pdf_path`/`pdf_sha256`/`document_url`
- **AND** the `null -> value` first hydration SHALL NOT be suppressed by carry-forward

#### Scenario: Flap-back across three runs yields one version, not three

- **WHEN** run A hydrates statement `id`, run B fails (carry-forward), and run C re-downloads the identical PDF
- **THEN** the statement `id` SHALL have exactly one retained version across the three runs, not three
- **AND** each failed run SHALL still record its own `SKIP_RESULT`

#### Scenario: A genuine identity change still re-versions under carry-forward

- **WHEN** a statement's immutable identity (for example its `title`) changes between runs
- **THEN** the connector SHALL emit a new version for that statement regardless of carry-forward
- **AND** carry-forward SHALL NOT mask the identity change as a no-op

#### Scenario: Carry-forward needs no compaction-policy change

- **WHEN** the `chase/statements` and `usaa/statements` carry-forward gates are in force
- **THEN** the registered `fetched_at`-only compaction policies for those streams SHALL be unchanged
- **AND** the historical-compaction tool SHALL still never collapse a real `null -> value` first hydration into the prior index-only version
