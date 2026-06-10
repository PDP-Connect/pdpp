# reference-implementation-architecture (delta)

## ADDED Requirements

### Requirement: Docker Core deploy target SHALL run self-contained from the public Core image

The standalone Core image SHALL boot a complete node from a single
`docker run` with only a published port and a named data volume (Dockerfile
targets `railway-core`/`platform-core`): `PDPP_REFERENCE_ORIGIN` SHALL default to
`http://localhost:3000` and `PDPP_DB_PATH` SHALL default to
`/var/lib/pdpp/pdpp.sqlite` so SQLite storage and generated credentials land
on the mounted data volume. Managed platforms override both per deploy.

#### Scenario: Zero-flag quickstart boots and persists

- **WHEN** an operator runs
  `docker run -d -p 3000:3000 -v pdpp_data:/var/lib/pdpp ghcr.io/vana-com/pdpp/railway-core:<tag>`
  with no `-e` flags
- **THEN** the console SHALL serve `http://localhost:3000` and the AS/RS SHALL
  stay on loopback inside the container
- **AND** records SHALL persist in SQLite on the `pdpp_data` volume across a
  container replacement

#### Scenario: A database URL still selects Postgres

- **WHEN** `PDPP_DATABASE_URL` or `DATABASE_URL` is set on the same image
- **THEN** the runtime SHALL select Postgres and SHALL NOT open the default
  persistent SQLite path

### Requirement: Standalone Core image SHALL gate owner data by default via a first-boot owner credential

When `PDPP_OWNER_PASSWORD` is not supplied, the Core supervisor SHALL generate
an owner password, persist it on the data volume, and print a one-time
first-boot banner carrying the dashboard URL, the password, and how to change
it. The supervisor SHALL NOT boot with owner auth disabled, SHALL NOT reprint
the password on subsequent boots, and SHALL NOT emit it through any other log
surface. A supplied `PDPP_OWNER_PASSWORD` environment variable SHALL always
win over the persisted file.

#### Scenario: First boot generates, persists, and banners once

- **WHEN** the image boots with `PDPP_OWNER_PASSWORD` unset and no persisted
  password on the data volume
- **THEN** the supervisor SHALL generate a password, write it mode-0600 to the
  data volume, and print the first-boot banner with the dashboard URL

#### Scenario: Restart reuses the persisted password silently

- **WHEN** the same container or a replacement boots again with the same data
  volume
- **THEN** owner auth SHALL use the persisted password
- **AND** the banner and the password SHALL NOT be printed again

#### Scenario: The environment variable always wins

- **WHEN** `PDPP_OWNER_PASSWORD` is set on a deploy that previously persisted
  a generated password
- **THEN** the supplied value SHALL gate owner auth and the persisted file
  SHALL be left untouched

#### Scenario: SQLite boots provision a sealed-credential key

- **WHEN** storage resolves to SQLite and no credential key provider is
  configured
- **THEN** the supervisor SHALL provision a persisted credential encryption
  key file on the data volume and SHALL NOT print the key
- **AND** Postgres boots SHALL keep the explicit fail-closed key contract

### Requirement: Docker deploy surface SHALL present exactly two canonical operator paths

The committed Docker deploy artifacts SHALL present one zero-flag `docker run`
quickstart (SQLite on a named volume) and one minimal production Docker
Compose stack (reference + console + Postgres with pgvector, healthchecks,
named volumes) at `deploy/docker/`, downloadable without a repository clone.
The production compose SHALL fail fast when the owner password or credential
encryption key is missing. The repository-root compose remains the
development/owner stack and SHALL NOT be presented as the self-host entry
point.

#### Scenario: Production compose refuses to boot ungated

- **WHEN** `docker compose up` runs against `deploy/docker/docker-compose.yml`
  without `PDPP_OWNER_PASSWORD` or `PDPP_CREDENTIAL_ENCRYPTION_KEY` in the
  environment
- **THEN** compose SHALL refuse to start with a message pointing at the
  runbook

#### Scenario: Deploy docs disclose progressively

- **WHEN** the reference page deploy section is updated from the committed
  site-copy proposal
- **THEN** the Railway button and the Docker quickstart SHALL lead, with
  production compose and other platforms (Fly) collapsed beneath them
