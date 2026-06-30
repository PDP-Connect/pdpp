# Tasks

## 1. Spec And Contract

- [x] 1.1 Add a reference-only requirement for optional grant and trace client metadata.
- [x] 1.2 Validate `openspec validate surface-grant-client-metadata --strict`.

## 2. Reference Surface

- [x] 2.1 Batch-enrich grant and trace correlation summaries with registered client metadata for SQLite and Postgres.
- [x] 2.2 Project the optional `client` object on `grant_summary` and `trace_summary` entries only.
- [x] 2.3 Add operation-level tests for the optional projection and missing-metadata fallback.

## 3. Console Consumer

- [x] 3.1 Extend the console `GrantSummary` type with optional `client` metadata.
- [x] 3.2 Prefer `grant.client.client_name` for relationship labels while preserving `client_id`.
- [x] 3.3 Keep the owner-issued-client fallback for already-loaded metadata.
- [x] 3.4 Prefer `trace.client.client_name` for recent-read labels.
- [x] 3.5 Prefer client metadata in shared grant/trace list-row labels.
- [x] 3.6 Avoid bolding raw technical client IDs in the calm recent-read fallback.

## 4. Verification

- [x] 4.1 Run focused reference and console tests.
- [x] 4.2 Run console typecheck and `git diff --check`.
- [x] 4.3 Deploy under the live-stack mutex and verify the live Standing relationship rows no longer render only raw `cli_...` when client metadata exists.
- [x] 4.4 Deploy the trace/list-label extension under the live-stack mutex and verify live recent-read rows no longer render raw `cli_...` as primary labels when metadata exists.
