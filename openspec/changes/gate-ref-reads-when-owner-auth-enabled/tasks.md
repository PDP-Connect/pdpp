## 1. OpenSpec

- [x] Promote the `_ref` read-auth posture note into this OpenSpec change.
- [x] Validate `openspec validate gate-ref-reads-when-owner-auth-enabled --strict`.
- [x] Validate `openspec validate --all --strict`.

## 2. Route Gating

- [ ] Inventory all current `GET /_ref/*` routes in `reference-implementation/server/index.js`.
- [ ] Apply owner-session gating to every `_ref` read when `PDPP_OWNER_PASSWORD` is configured.
- [ ] Preserve open local-dev behavior when owner auth is disabled.
- [ ] Keep existing `_ref` mutation behavior unchanged.

## 3. Consumers

- [ ] Verify dashboard `_ref` fetches forward the owner-session cookie and still work when owner auth is enabled.
- [ ] Audit CLI `_ref` readers (`grant`, `run`, `trace`, `seed`, and any summary commands).
- [ ] Add owner-credential support to CLI `_ref` reads if needed for password-enabled operation.

## 4. Tests

- [ ] Add black-box tests showing password-enabled `_ref` reads reject unauthenticated callers.
- [ ] Add black-box tests showing password-enabled `_ref` reads accept an owner session or owner bearer.
- [ ] Add a regression test showing password-disabled local-dev `_ref` reads remain open.
- [ ] Add or update dashboard/CLI tests for the affected consumers.

## 5. Documentation

- [ ] Update operator/Docker docs to state that deployed reference instances must set `PDPP_OWNER_PASSWORD` and that it gates `_ref` reads and mutations.
- [ ] Update any CLI docs that mention unauthenticated `_ref` reads.

## 6. Validation

- [ ] Run relevant reference auth/security tests.
- [ ] Run relevant CLI tests.
- [ ] Run reference typecheck/lint if touched.
- [ ] Run `openspec validate gate-ref-reads-when-owner-auth-enabled --strict`.
- [ ] Run `openspec validate --all --strict`.
