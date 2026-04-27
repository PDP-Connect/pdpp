## 1. OpenSpec

- [x] Promote the `_ref` read-auth posture note into this OpenSpec change.
- [x] Validate `openspec validate gate-ref-reads-when-owner-auth-enabled --strict`.
- [x] Validate `openspec validate --all --strict`.

## 2. Route Gating

- [x] Inventory all current `GET /_ref/*` routes in `reference-implementation/server/index.js`.
- [x] Apply owner-session gating to every `_ref` read when `PDPP_OWNER_PASSWORD` is configured.
- [x] Preserve open local-dev behavior when owner auth is disabled.
- [x] Keep existing `_ref` mutation behavior unchanged.

## 3. Consumers

- [x] Verify dashboard `_ref` fetches forward the owner-session cookie and still work when owner auth is enabled.
- [x] Audit CLI `_ref` readers (`grant`, `run`, `trace`, `seed`, and any summary commands).
- [x] Add owner-credential support to CLI `_ref` reads if needed for password-enabled operation.

## 4. Tests

- [x] Add black-box tests showing password-enabled `_ref` reads reject unauthenticated callers.
- [x] Add black-box tests showing password-enabled `_ref` reads accept an owner session or owner bearer.
- [x] Add a regression test showing password-disabled local-dev `_ref` reads remain open.
- [x] Add or update dashboard/CLI tests for the affected consumers.

## 5. Documentation

- [x] Update operator/Docker docs to state that deployed reference instances must set `PDPP_OWNER_PASSWORD` and that it gates `_ref` reads and mutations.
- [x] Update any CLI docs that mention unauthenticated `_ref` reads.

## 6. Validation

- [x] Run relevant reference auth/security tests.
- [x] Run relevant CLI tests.
- [x] Run reference typecheck/lint if touched.
- [x] Run `openspec validate gate-ref-reads-when-owner-auth-enabled --strict`.
- [x] Run `openspec validate --all --strict`.
