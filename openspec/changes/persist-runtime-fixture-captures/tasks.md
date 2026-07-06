## 1. Runtime capture root

- [x] Add `PDPP_CAPTURE_ROOT_DIR` support to `createCaptureSession()`.
- [x] Add a unit test proving a custom root is honored.

## 2. Reference stack

- [x] Default composed deployments to a persistent runtime capture root.
- [x] Remove the checkout bind mount for live capture artifacts.

## 3. Validation

- [x] `openspec validate persist-runtime-fixture-captures --strict`
- [x] `node --test --import tsx src/fixture-capture.test.ts`
- [x] `docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.neko.yml --profile neko-dynamic config`
