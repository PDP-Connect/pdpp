## 1. Tooling

- [x] Add a root `pnpm spec:check` script.
- [x] Implement the drift-check script with root/web normalization, the web-only extension allowlist, and the reference-only allowlist.
- [x] Document the web Status/Date callout pattern near the docs corpus.

## 2. Gates

- [x] Wire `pnpm spec:check` into lefthook for root/web spec doc changes.
- [x] Wire `pnpm spec:check` into CI.

## 3. Corpus Reconciliation

- [x] Treat `spec-reference-implementation-examples.md` as reference-only in the check.
- [x] Reconcile `apps/web/content/docs/spec-core.md` with root `spec-core.md` while preserving web metadata.
- [x] Reconcile `apps/web/content/docs/spec-deferred.md` with root `spec-deferred.md` while preserving web metadata.
- [x] Add Status/Date callouts to every web copy of a canonical-root spec.
- [x] Update `README.md` authority-order wording to mention the web-only extension allowlist.

## 4. Validation

- [x] Run `pnpm spec:check`.
- [x] Run `openspec validate implement-root-web-spec-check --strict`.
- [x] Run `openspec validate --all --strict`.
