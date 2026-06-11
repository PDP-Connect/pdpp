# Tasks: gate-hosted-owner-exposure

## 1. Owner-exposure posture (pure module)

- [x] 1.1 Add `server/owner-exposure-posture.ts` — a pure function deriving the
  posture from env + start options (no `process.env` reads inside, no server
  imports). Classify hosted via non-loopback `PDPP_REFERENCE_ORIGIN` /
  `AS_PUBLIC_URL` / `asPublicUrl`, `NODE_ENV=production`, or explicit
  non-loopback `bindHost`. Honor `PDPP_HOSTED=1/0` and
  `PDPP_ALLOW_UNAUTHENTICATED_OWNER=1`. Ignore ambient hosting env under the
  Node test runner (`isTestContext`) so the suite stays hermetic.
- [x] 1.2 Unit tests pin the classification matrix and fail-closed decisions
  (`test/owner-exposure-posture.test.js`).

## 2. S-1 — close the owner-session bypass

- [x] 2.1 `server/owner-auth.ts`: add `allowUnauthenticatedWhenDisabled` option
  (default `true` for direct fixtures). When auth is disabled, fall through only
  if allowed; otherwise fail closed (401 JSON / `/owner/login` redirect).
- [x] 2.2 `server/index.js`: compute the posture in `startServer` and THROW
  before any listener binds when hosted + no password + no override. Log a loud
  warning when a local-dev posture still binds a non-loopback interface without
  a password.
- [x] 2.3 Wire the posture's `allowUnauthenticatedOwnerWhenDisabled` into
  `createOwnerAuthPlaceholder` via `buildAsApp`.
- [x] 2.4 Unit tests for the fail-closed branch
  (`test/owner-auth-fail-closed.test.js`).

## 3. S-2 — gate the connector registry

- [x] 3.1 `server/routes/as-polyfill-connectors.ts`: accept an optional
  `requireOwnerSessionForRegister` middleware and insert it before the
  `POST /connectors` handler when supplied. Leave `GET /connectors/:id` open.
- [x] 3.2 `server/index.js`: supply `ownerAuth.requireOwnerSession` for the
  register route only when the posture's `lockConnectorRegistry` is true
  (hosted or `PDPP_LOCK_CONNECTOR_REGISTRY=1`).

## 4. End-to-end proof

- [x] 4.1 Integration test (`test/owner-hosted-exposure.test.js`): hosted + no
  password → `startServer` rejects; hosted + password → unauthenticated
  `POST /connectors` is 401 and authenticated is 201; `GET /connectors/:id`
  stays open; local-dev `POST /connectors` stays open; override boots.

## 5. Gates

- [x] 5.1 New + existing owner-auth / owner-session / security / connector-route
  suites green.
- [x] 5.2 `tsc --noEmit` clean; biome check clean on changed files.
- [x] 5.3 `openspec validate gate-hosted-owner-exposure --strict` passes.

## 6. Out of scope (tracked separately)

- [ ] 6.1 S-3 owner-session KDF (scrypt + per-server salt) — lane A3.
- [ ] 6.2 S-4 / S-6 stderr-tail + connector-error redaction — lane A2.
- [ ] 6.3 S-5 CIMD IP-guard hex-mapped/6to4 — lane A2.
- [ ] 6.4 S-7 credential fingerprint width — lane A3.
