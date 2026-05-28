## Why

Recent Slack and YNAB connector runs exited with code `1` before emitting `DONE`, and the persisted run timeline only reported `connector_exit_without_done`. The runtime had captured connector stderr in memory, but discarded it before writing the terminal spine event, leaving the owner unable to diagnose the failure after the process exited.

## What Changes

- Persist bounded, redacted connector-failure diagnostics for connector processes that exit before `DONE`.
- Add runtime-authored terminal failure fields that distinguish the failure origin and provide an operator-safe explanation.
- Keep raw connector output out of public/client grant surfaces; diagnostics are owner/control-plane evidence, not a PDPP client API contract.
- Treat Node.js diagnostic reports as a complementary reference/operator artifact for fatal native/V8/uncaught-crash cases, not as a replacement for stderr persistence.
- If dev/runtime commands enable Node diagnostic reports that connector children may inherit, ensure report flags exclude environment variables and network details.
- Defer full log-artifact/blob retention until retention, authorization, and storage policy are designed.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add a reference-runtime requirement for bounded, non-secret connector failure diagnostics on failed connector runs.
- `reference-implementation-architecture`: add a reference-runtime requirement that Node diagnostic reports, when enabled for connector-inheritable processes, are secret-minimized and operator-local.

## Impact

- `reference-implementation/runtime/index.js` — replace unbounded stderr accumulation with a bounded tail buffer, redact before persistence, and thread diagnostics into terminal `run.failed` data when a connector exits without `DONE`.
- `reference-implementation/runtime/index.d.ts` and related tests — type and assert the new additive terminal failure fields.
- `reference-implementation/server/ref-control.ts` and dashboard run detail surfaces — render the diagnostic as owner-facing evidence without exposing it through grant-scoped `/v1` reads.
- `apps/web/package.json` and `reference-implementation/package.json` — if Node report flags remain enabled in dev scripts, include `--report-exclude-env` and `--report-exclude-network`.
- `tmp/connector-failure-diagnostics-memo.md` and `tmp/connector-failure-diagnostics-followup-node-reports.md` — promoted into this change's design notes so the investigations are durable.
