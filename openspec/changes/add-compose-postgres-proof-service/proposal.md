## Why

`define-reference-operation-environments` landed an env-gated Postgres adapter spike (`reference-implementation/test/connector-state-scheduler-conformance-postgres.test.js`) that requires a real Postgres instance. Today every contributor wires up their own Postgres to run the proof, which makes the proof harder to reproduce and easier to skip. A profile-gated Compose service makes the proof one-command reproducible without changing the reference runtime, which remains SQLite-backed.

## What Changes

- Add a `postgres` Compose service gated behind the `postgres` profile so default `docker compose up` is unaffected.
- Use a pgvector-capable Postgres image (`pgvector/pgvector:pg16`) so future semantic/vector proof slices can reuse the same service without an image swap. The current connector-state/scheduler conformance test does not use the `vector` extension.
- Expose the host port via `PDPP_POSTGRES_PORT`, defaulting to `55432` to avoid colliding with operator-installed Postgres on `5432`.
- Persist data in a named volume (`pdpp-postgres-data`) so a proof run survives an intentional container recreate.
- Add a `pg_isready` healthcheck so `docker compose --profile postgres up -d --wait postgres` is reliable.
- Document that this is a proof/test backend only, not a runtime backend, and that the `reference` service does not depend on it.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- `docker-compose.yml` — adds the profile-gated `postgres` service and the `pdpp-postgres-data` volume.
- `.env.docker.example` — adds the Postgres image/port/credentials env vars and proof-only usage notes.
- `README.md` — adds a short Postgres proof-service section under the Docker docs.
- Does not add `PDPP_STORAGE_BACKEND`, `PDPP_DATABASE_URL`, or any other runtime-storage env contract.
- Does not change the `reference`, `web`, or `dev` Compose services or their dependencies.
- Does not introduce a production Postgres adapter.
