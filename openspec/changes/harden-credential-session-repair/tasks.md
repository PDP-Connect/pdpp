## 1. Spec and design

- [x] 1.1 Add OpenSpec deltas for credential rejection lifecycle, run assistance evidence, and polyfill terminal error codes.
- [x] 1.2 Validate `harden-credential-session-repair` strictly.

## 2. Credential lifecycle storage

- [x] 2.1 Add `rejected` credential status and non-secret rejection metadata for SQLite and Postgres.
- [x] 2.2 Add store APIs/tests for mark-rejected, recovery fail-closed, and explicit re-capture clearing rejection.
- [x] 2.3 Update static-secret run-env resolution so browser-session sources ignore rejected optional login secrets while true static-secret sources fail closed.

## 3. Runtime signal propagation

- [x] 3.1 Widen failed `DONE.error` to accept bounded optional `code`.
- [x] 3.2 Preserve the code in runtime result and terminal spine data.
- [x] 3.3 Add runtime protocol tests for accepted/rejected error-code shapes.

## 4. ChatGPT proof path

- [x] 4.1 Detect definitive incorrect-password UI after stored-password submit.
- [x] 4.2 Emit a typed `credential_rejected` terminal error without requesting app approval or browser assistance.
- [x] 4.3 Let owner-attended ChatGPT browser-session repair proceed without stored username/password by opening manual browser assistance.
- [x] 4.4 Add focused ChatGPT auto-login tests for rejected stored credential and no-stored-secret manual browser repair.

## 5. Reference controller and UI

- [x] 5.1 Mark injected stored credentials rejected when a terminal run reports `credential_rejected`.
- [x] 5.2 Inject the controller rejection handler from the reference server without importing credential-store internals into the controller.
- [x] 5.3 Update browser-session repair copy to distinguish session capture from password storage.
- [x] 5.4 Add controller/server tests for rejected credential marking and browser-source optional-secret behavior.

## 6. Verification and closeout

- [x] 6.1 Run targeted polyfill tests.
- [x] 6.2 Run targeted reference-implementation tests.
- [x] 6.3 Run OpenSpec strict validation.
- [ ] 6.4 Merge/deploy only after no active connector runs.
- [ ] 6.5 Verify live ChatGPT no longer reuses a rejected stored password and can become healthy through owner repair.
