## Why

When a local collector's durable outbox stalls, the operator console can show `Outbox · stalled` and a `clear_backlog` remediation, but the remediation only lives in hover/title text and there is no copy-pasteable next step. The owner sees a danger signal with no actionable path. The dashboard cannot drain a device-local outbox remotely — only the operator, on the host, can — so the console must surface the local command instead of implying a remote fix.

## What Changes

- Define the operator remediation contract for a stalled local-device outbox in the connection diagnostics surface.
- Surface the reference-authored `condition.remediation.label` as visible operator copy, not hover-only text.
- Render a deterministic, non-secret local collector diagnostic command (`@pdpp/local-collector doctor`) the operator runs on the host that holds the data, scoped by the non-secret connection identity, with no base URL, token, or filesystem path.
- Keep healthy/idle/active/unknown outboxes free of remediation noise.
- Preserve the existing health projection taxonomy and the decomplection of outbox from scheduler health; this change only adds the operator-path rendering contract.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-connection-health`: Add owner-console remediation semantics for a stalled local-device outbox.

### Removed Capabilities

## Impact

- Affected UI: `apps/console/src/app/dashboard/records/[connector]/connection-diagnostics.tsx`, `apps/console/src/app/dashboard/records/[connector]/page.tsx`, `apps/console/src/app/dashboard/lib/connection-evidence.ts`, `apps/console/src/lib/pdpp-cli-command.ts`, and companion tests.
- Affected specs: `reference-connection-health`.
- No change to connector health projection storage, the local collector CLI surface, or public read APIs.
