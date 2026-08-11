## 1. Resolver contract

- [x] Add the platform user-state default and source-isolated canonical names.
- [x] Preserve explicit queue-path precedence and profile queue overrides.
- [x] Implement bounded source-aware legacy discovery and ambiguity errors.
- [x] Implement atomic SQLite snapshot migration without changing the source.

## 2. CLI integration

- [x] Route run, setup/connect sample, recover, status, doctor, retry,
      prune-sent, and compact through the shared resolver.
- [x] Remove package-relative default-path logic and stale unscoped-default
      refusal text from the affected command paths.
- [x] Update durable-state documentation and residual lost-queue guidance.

## 3. Evidence

- [x] Add cwd/install-root stability, legacy migration/ambiguity,
      crash/restart, explicit precedence, and source-isolation tests.
- [x] Run focused package tests, package validation, typecheck, changed-file
      lint, and strict focused OpenSpec validation.
- [x] Write `/tmp/fix-local-collector-stable-state-0811.md` with exact SHA,
      paths, test counts, migration semantics, and residual recovery note.
