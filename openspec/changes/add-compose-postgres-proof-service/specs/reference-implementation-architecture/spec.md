## ADDED Requirements

### Requirement: Postgres proof service SHALL be profile-gated and runtime-independent

The repository MAY ship a Compose Postgres service to support env-gated conformance proofs (notably `reference-implementation/test/connector-state-scheduler-conformance-postgres.test.js`). Any such service SHALL be gated behind a Compose profile, SHALL NOT be started by a default `docker compose up`, and SHALL NOT be wired into the runtime storage path of any production reference service.

#### Scenario: Default Compose stack does not include the proof service

- **WHEN** an operator runs `docker compose --env-file .env.docker up`
- **THEN** the Postgres proof service SHALL NOT start
- **AND** the rendered `docker compose --env-file .env.docker config` output SHALL NOT include the proof service

#### Scenario: Proof service started explicitly

- **WHEN** an operator runs `docker compose --profile postgres --env-file .env.docker up -d postgres`
- **THEN** the Postgres proof service SHALL start with a persistent named volume and a `pg_isready` healthcheck
- **AND** the host port SHALL be configurable via an env var defaulting to a nonstandard local port to avoid colliding with operator-installed Postgres on `5432`

#### Scenario: Reference services remain SQLite-backed

- **WHEN** the Postgres proof service is started or stopped
- **THEN** the `reference` service SHALL NOT depend on it via `depends_on` or runtime env wiring
- **AND** the reference runtime SHALL continue to use its SQLite-backed storage path
- **AND** no `PDPP_STORAGE_BACKEND` or `PDPP_DATABASE_URL` runtime contract SHALL be introduced by this change

#### Scenario: Proof service is documented as proof-only

- **WHEN** the Postgres proof service is documented in `.env.docker.example` or the README
- **THEN** the documentation SHALL state that the service exists for env-gated conformance/proof use only
- **AND** the documentation SHALL NOT claim operator-facing Postgres storage support
- **AND** the documentation SHALL show the exact `PDPP_TEST_POSTGRES_URL` value that targets the proof service
