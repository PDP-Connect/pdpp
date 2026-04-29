## 1. Compose Service

- [x] 1.1 Add a `postgres` service to `docker-compose.yml` gated behind the `postgres` profile so default `docker compose up` does not start it.
- [x] 1.2 Use a pgvector-capable image (`pgvector/pgvector:pg16`) and allow override via `PDPP_POSTGRES_IMAGE`.
- [x] 1.3 Publish host port from `${PDPP_POSTGRES_PORT:-55432}` mapped to container `5432`.
- [x] 1.4 Persist data in a named volume `pdpp-postgres-data` mounted at `/var/lib/postgresql/data`.
- [x] 1.5 Add a `pg_isready` healthcheck.
- [x] 1.6 Confirm the `reference` and `web` services do not declare any `depends_on` or env wiring against `postgres`.

## 2. Environment Example

- [x] 2.1 Add `PDPP_POSTGRES_IMAGE`, `PDPP_POSTGRES_PORT`, `PDPP_POSTGRES_USER`, `PDPP_POSTGRES_PASSWORD`, and `PDPP_POSTGRES_DB` to `.env.docker.example`.
- [x] 2.2 Document the profile-gated `up` command and the matching `PDPP_TEST_POSTGRES_URL` value as comments next to the new env vars.
- [x] 2.3 State explicitly that the service is a proof/test backend only and not a runtime storage backend.

## 3. Documentation

- [x] 3.1 Add a short "Postgres proof service" subsection to the README's Docker section pointing at the env-gated conformance test and the exact start/test/stop commands.
- [x] 3.2 Cross-link to `define-reference-operation-environments` and the conformance test path so the proof origin is auditable.

## 4. Validation

- [x] 4.1 Run `docker compose --env-file .env.docker.example config` and confirm `postgres` is NOT listed.
- [x] 4.2 Run `docker compose --profile postgres --env-file .env.docker.example config` and confirm `postgres` is listed with the expected image, port, volume, and healthcheck.
- [x] 4.3 Start the service with `docker compose --profile postgres --env-file .env.docker.example up -d postgres` and run `reference-implementation/test/connector-state-scheduler-conformance-postgres.test.js` against it; tear down only the proof service afterwards.
- [x] 4.4 Run `openspec validate add-compose-postgres-proof-service --strict`.
- [x] 4.5 Run `openspec validate --all --strict`.
