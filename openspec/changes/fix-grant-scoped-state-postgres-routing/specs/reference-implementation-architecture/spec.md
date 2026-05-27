# reference-implementation-architecture — Delta

## ADDED Requirements

### Requirement: Grant-scoped state resolution SHALL consult the active storage backend

Grant resolution for the reference's grant-scoped state operations (the `rs.connector-state.get` and `rs.connector-state.put` injection points) SHALL read the persisted grant row from the storage backend selected by `isPostgresStorageBackend()`. The downstream contract — `requirePersistedGrantState` / `requireResolvedPersistedGrantState`, the `access_mode === 'continuous'` check, the connector-id binding check, and the persisted-grant row shape — SHALL remain identical across backends.

#### Scenario: A grant is issued under the Postgres storage backend

- **WHEN** the reference is configured for the Postgres storage backend and a continuous-mode grant has been written to the Postgres `grants` table
- **THEN** the grant-scoped state grant resolver SHALL locate the grant row by reading from Postgres
- **AND** SHALL NOT return `not_found` solely because the SQLite `grants` table is empty
- **AND** SHALL surface `grant_invalid`, `invalid_request`, or `not_found` exactly as it would have for an equivalent SQLite-issued grant under the SQLite backend

#### Scenario: A grant is issued under the SQLite storage backend

- **WHEN** the reference is configured for the SQLite storage backend and a continuous-mode grant has been written to the SQLite `grants` table
- **THEN** the grant-scoped state grant resolver SHALL locate the grant row via the existing `grantsGetScopedStateById` query
- **AND** SHALL NOT issue a Postgres query

#### Scenario: A grant id is absent from the active backend

- **WHEN** the supplied `grantId` does not exist in the active storage backend's `grants` table
- **THEN** the resolver SHALL throw an error with `code = 'not_found'`
- **AND** SHALL NOT fall back to the other backend
