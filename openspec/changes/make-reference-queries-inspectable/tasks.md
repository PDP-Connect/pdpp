## 1. Inventory

- [ ] Re-audit `swap-sqlite-driver/tasks.md` and classify every remaining query-extraction checkbox as static, dynamic, or obsolete.
- [ ] Count current SQL call sites across `server/`, `runtime/`, `lib/`, and tests.
- [ ] Identify dynamic query sites that should explicitly stay in code.

## 2. Query Registry

- [ ] Add `reference-implementation/server/queries/` with a deterministic loader.
- [ ] Map query file names to stable camelCase registry keys.
- [ ] Fail fast when a required query artifact is missing or malformed.

## 3. Extraction

- [ ] Extract one low-risk server module first and validate the pattern.
- [ ] Extract remaining static server/runtime/lib statements in small commits.
- [ ] Extract test-only static statements only where it improves readability.
- [ ] Leave dynamic query builders in code with short comments explaining why.

## 4. Validation

- [ ] Add a query/schema validation command or test.
- [ ] Run the focused reference test suites touched by extraction.
- [ ] Run `pnpm --dir reference-implementation run verify`.
- [ ] Run `openspec validate make-reference-queries-inspectable --strict`.
- [ ] Run `openspec validate --all --strict`.
