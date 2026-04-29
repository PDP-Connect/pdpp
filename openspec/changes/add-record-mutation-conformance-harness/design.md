## Context

The records/search/Postgres success plan makes conformance harnesses the next gate after fixing SQLite record mutation atomicity. The goal is not to invent interfaces first. The goal is to extract the semantic tests from the now-proven SQLite behavior so future adapters can be tested against the same obligations.

This change covers only durable record mutation semantics:

- upsert/change versioning
- no-op re-ingest
- ingest delete
- direct delete
- absent/already-deleted no-op delete
- rollback/fault behavior
- contiguous `record_changes`

It does not cover record list/read cursor semantics, `changes_since`, projection, range filters, `expand[]`, lexical, semantic, hybrid, or disclosure spine conformance.

## Goals / Non-Goals

**Goals:**

- Define a test-only record mutation conformance driver shape.
- Run the conformance suite against the current SQLite reference implementation.
- Retain or improve the evidence from `records-ingest-atomicity.test.js` and `records-delete-atomicity.test.js`.
- Include a falsifiability check that proves the harness catches a broken implementation.

**Non-Goals:**

- Do not create production `RecordStore`.
- Do not move runtime code into a new architecture layout.
- Do not add Postgres.
- Do not require a memory adapter unless it is a deliberately small broken fixture for harness falsifiability.
- Do not generalize record read/list/query/search behavior.

## Decisions

### 1. Driver shape is test-only

The conformance harness should accept a small driver object. It should not be exported from production code and should not become a de facto `RecordStore` contract.

Candidate driver obligations:

- reset/teardown storage
- ingest an upsert/delete envelope
- direct-delete a record
- read live row for assertions
- read `record_changes`
- read per-stream `version_counter`
- optionally install/clear fault hooks for rollback tests

Rationale: this describes the evidence a conformance test needs without prematurely freezing a production interface.

### 2. SQLite driver wraps existing reference helpers

The first real driver should call the current `ingestRecord` and `deleteRecord` helpers and use direct test-only DB reads for assertions, matching existing atomicity tests.

Rationale: the first objective is to make current semantics executable in a reusable shape without altering runtime code.

### 3. Falsifiability is required

The harness must include a negative proof. Acceptable forms:

- a deliberately broken in-memory driver run through the harness where the meta-test asserts failure, or
- a small harness-level unit that proves a core assertion fails when versions/change rows drift.

Rationale: conformance tests that merely wrap current green paths can become theater. The suite must prove it detects at least one relevant broken implementation.

### 4. Keep existing atomicity files only if they still add evidence

If the harness covers the current atomicity tests, the worker may replace the two focused files with one harness-backed test file plus any small direct tests that remain necessary. If replacement is too risky, leave the focused files and add the harness in parallel.

Rationale: avoid duplicate coverage if the harness cleanly supersedes it, but do not create churn for its own sake.

## Risks / Trade-offs

- A test-only driver shape can accidentally become a production contract -> keep it under test/conformance and name it accordingly.
- A bad harness can duplicate `records.js` semantics instead of testing them -> assertions should be outcome-focused, not implementation-shaped.
- Falsifiability can be brittle -> keep the negative fixture tiny and focused on one known bad behavior.

## Migration Plan

1. Extract or copy the current ingest/delete atomicity scenarios into a reusable conformance helper.
2. Add a SQLite-backed test driver over current reference helpers.
3. Add a negative/falsifiability test.
4. Run the harness plus existing targeted suites.
5. Do not delete existing focused atomicity tests unless the harness demonstrably covers all their assertions.

Rollback is straightforward: remove the new test helpers/tests. Runtime code should not change.
