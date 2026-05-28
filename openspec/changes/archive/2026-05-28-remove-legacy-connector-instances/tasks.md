## 1. Spec And Migration Contract

- [x] 1.1 Capture the replacement invariant for default connector instances.
- [x] 1.2 Define the in-place migration and failure posture.
- [x] 1.3 Validate the OpenSpec change.

## 2. Store And Schema Implementation

- [x] 2.1 Replace legacy default helper names with default connection helper names.
- [x] 2.2 Remove `legacy` from valid source-kind checks and fresh SQLite/Postgres schemas.
- [x] 2.3 Add SQLite migration for existing legacy rows and direct instance references.
- [x] 2.4 Add Postgres migration for existing legacy rows and direct instance references.
- [x] 2.5 Update fallback/default materialization call sites to create default account connections.

## 3. Tests And Projections

- [x] 3.1 Update connector instance store tests for default account connections.
- [x] 3.2 Add migration tests covering legacy row/id rewrite without data loss.
- [x] 3.3 Update affected state/scheduler/search/blob helper tests to use default connection ids.
- [x] 3.4 Verify owner-facing projections do not surface `legacy` for connector instances.

## 4. Validation

- [x] 4.1 Run targeted connector-instance, migration, state, scheduler, blob, and search tests.
- [x] 4.2 Grep affected files for old connector-instance legacy helpers and creation paths.
- [x] 4.3 Run `openspec validate remove-legacy-connector-instances --strict`.
