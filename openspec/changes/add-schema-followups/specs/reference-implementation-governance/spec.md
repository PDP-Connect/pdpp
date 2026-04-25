## ADDED Requirements

### Requirement: Schema-bearing connectors enrolled in pilot-fixture coverage SHALL ship a committed pilot fixture and replay test
Every connector enrolled in pilot-fixture coverage SHALL ship:
1. A `fixtures/<connector>/scrubbed/pilot-real-shape/records/<stream>.jsonl` file for each stream in `SCHEMAS`, containing 1+ synthetic-but-shape-real record(s) that pass `validateRecord(stream, record)`.
2. A `connectors/<connector>/pilot-fixture.test.ts` that registers per-stream replay tests via `src/pilot-fixture-test-helper.ts`.

The fixtures lock the connector's emitted-record shape against schema drift. Without them, a `schemas.ts` change that rejects real production records can pass review and land silently, since the schema is internally self-consistent.

Schema-bearing connectors not yet enrolled remain visible as follow-up work; enrolling the remaining first-party connectors is a separate connector-by-connector rollout, not a blocker for this pattern change.

#### Scenario: A schema edit becomes too strict for a real shape
- **WHEN** a connector's `schemas.ts` is modified to require a field that the connector never actually populates
- **THEN** the per-connector `pilot-fixture.test.ts` SHALL fail because at least one fixture record will lack the field
- **AND** the failure SHALL surface the offending row's id and zod issue list

#### Scenario: A pilot fixture is missing
- **WHEN** a connector is enrolled in pilot-fixture coverage but has no committed fixture under `fixtures/<connector>/scrubbed/pilot-real-shape/records/`
- **THEN** the connector's `pilot-fixture.test.ts` SHALL fail with a "fixture missing" message pointing at the expected path
- **UNLESS** the test was registered with `expectMissing: true` (used only for connectors that legitimately cannot produce a fixture, e.g. interactive-only flows)

### Requirement: Pilot fixtures SHALL be synthetic-but-shape-real, not real owner data
Records committed under `fixtures/<connector>/scrubbed/pilot-real-shape/` SHALL contain only synthetic content with `[REDACTED_*]` placeholders for any field that would normally hold identifying data (names, emails, IDs derived from real accounts, free-form text bodies). Real owner data SHALL NOT be committed even when it has been deterministically scrubbed.

The fixtures' purpose is to lock record shape, not to test against real data. Real-data validation is the job of `bin/replay-schemas.ts` against the local owner database, which is gitignored by design.

#### Scenario: A worker considers committing scrubbed real data as a pilot fixture
- **WHEN** a worker has a real owner-database scrubbed run and wants to commit it as a pilot fixture
- **THEN** the worker SHALL author synthetic records from `schemas.ts` + `parsers.ts` instead
- **AND** SHALL NOT commit scrubbed real data into `pilot-real-shape/`
- **AND** raw-data scrubbed fixtures (which may exist for real-shape DOM/HTTP captures) SHALL live under `fixtures/<connector>/scrubbed/<runId>/` and follow the LLM-redaction pipeline tracked in `add-reddit-pilot-real-shape-fixture`
