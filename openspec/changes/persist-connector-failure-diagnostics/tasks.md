## 1. OpenSpec and memo promotion

- [x] 1.1 Promote `tmp/connector-failure-diagnostics-memo.md` into this change's design notes.
- [x] 1.2 Author proposal, design, and spec delta against `reference-implementation-architecture`.
- [x] 1.3 Fold `tmp/connector-failure-diagnostics-followup-node-reports.md` into the design and spec delta.
- [x] 1.4 Validate `persist-connector-failure-diagnostics` strictly.

## 2. Runtime diagnostics

- [x] 2.1 Replace unbounded `stderrChunks` accumulation in `reference-implementation/runtime/index.js` with a bounded UTF-8 stderr tail buffer that tracks `bytes_observed`, `bytes_captured`, and `truncated`.
- [x] 2.2 Redact the stderr tail before persistence using the reference diagnostic redaction policy; add or reuse a helper that returns whether redaction changed the text.
- [x] 2.3 Thread the diagnostic into terminal `run.failed` data for connector exits before `DONE`, alongside additive `failure_origin` and `failure_message` fields.
- [x] 2.4 Update runtime types so the new terminal fields are explicit and owner-surface consumers do not have to parse unknown JSON.

## 3. Owner surfaces

- [x] 3.1 Render the diagnostic on the dashboard run detail page as connector-authored stderr evidence, preferably collapsed by default with byte/truncation metadata visible.
- [x] 3.2 Confirm the CLI/timeline inspection path shows the fields in raw JSON without introducing a separate command.
- [x] 3.3 Verify grant-scoped `/v1` reads do not expose connector stderr diagnostics or any pointer to them.

## 4. Node diagnostic report safety

- [x] 4.1 If Node report flags remain enabled in dev scripts, add `--report-exclude-env` and `--report-exclude-network` anywhere connector children may inherit report settings.
- [x] 4.2 Confirm Node reports are documented as operator-local artifacts and are not linked from run timelines in this slice.

## 5. Tests

- [x] 5.1 Add a runtime test where a stub connector writes stderr and exits `1` before `DONE`; assert `failure_origin`, `failure_message`, `exit_code`, and `connector_diagnostics.stderr_tail`.
- [x] 5.2 Add a truncation test with stderr larger than the cap; assert the tail is bounded and metadata reports truncation.
- [x] 5.3 Add a redaction test with representative secret-like stderr; assert the persisted timeline contains the redacted value, not the original.
- [x] 5.4 Add an owner/control-plane visibility test and, where practical, a grant-scoped negative test.

## 6. Validation

- [x] 6.1 `openspec validate persist-connector-failure-diagnostics --strict`.
- [x] 6.2 `openspec validate --all --strict`.
- [x] 6.3 Relevant reference runtime tests, including the new diagnostic tests.
- [x] 6.4 `pnpm --dir reference-implementation run verify` if the implementation touches shared runtime/server code.

## Deferred follow-up

- [ ] Consider a separate log-artifact/blob-backed diagnostic store after retention, authorization, and storage policy are designed. Do not implement that as part of this slice.
- [ ] Consider per-run Node diagnostic report correlation after filename, retention, and authorization policy are designed. Do not implement that as part of this slice.
