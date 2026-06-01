# Design

## Context

The reference projects connection health as decomplected axes plus typed conditions (`reference-connection-health`). For a stalled local-device outbox it emits `axes.outbox = "stalled"` and a `false` condition (`LocalExporterAvailable` / `BacklogClear`) carrying `remediation.action = "clear_backlog"` and `remediation.label = "Inspect the local collector backlog"`. The console already renders the axis chip and dominant condition, but the remediation label only reaches the operator through hover/title text, and there is no command to run.

The `local-collector-durable-work` spec already requires that device health be inspectable and that remotely-displayed diagnostics avoid leaking raw secrets, auth files, cookies, or unredacted absolute local paths. The `@pdpp/local-collector` CLI already ships `doctor` and `status` subcommands that print durable-outbox health as JSON; both are local-only (no `--base-url`, no credentials) and accept an optional `--connection-id`.

## Decision

Add a console-only operator remediation path, not new protocol or projection semantics:

1. **Command builders** (`pdpp-cli-command.ts`): `pdppLocalCollectorDoctorCommand` / `pdppLocalCollectorStatusCommand`. They emit `npx -y @pdpp/local-collector@beta <doctor|status> [--connection-id <id>]`. They deliberately omit `--queue` (a device-local path) and never carry a base URL or token.
2. **Evidence helper** (`connection-evidence.ts`): `summarizeOutboxStallRemediation` returns the reference's `remediation.label` (and humanized reason) when a `clear_backlog` condition is current, or when `axes.outbox === "stalled"`. It returns `null` for healthy/idle/active/unknown outboxes so the surface stays quiet otherwise.
3. **Render** (`connection-diagnostics.tsx`): when the helper fires, show the label as readable copy plus the doctor command in a copy-pasteable code block scoped by the connection identity.

## Voice

Operator-console voice. The copy states that the dashboard cannot clear the backlog remotely and that the operator must run the command on the host that holds the data. It does not imply a hosted service can repair the local device.

## Alternatives Considered

- **Deep-link to the devices page only.** Rejected: it does not give the owner the concrete command, which is the missing primitive.
- **Embed `--queue <path>` for precision.** Rejected: leaks a device-local filesystem path into a remotely-rendered command, violating `local-collector-durable-work`'s no-path-leak rule. The collector resolves the default queue on the device.
- **Promote outbox counts into the connection-summary projection in this slice.** Deferred: it broadens the branch into the reference projection and query layer. The visible remediation path is the required deliverable; counts are a separate slice.

## Out Of Scope

- Version-churn banner and records-list drilldown (owned elsewhere).
- Promoting numeric outbox counts into `ConnectorSummary`.
- Any live-device heartbeat validation.

## Acceptance Checks

- A stalled-outbox connection renders the remediation label as visible text and a copy-pasteable `@pdpp/local-collector doctor` command.
- The command contains no base URL, token, or filesystem path.
- Healthy/idle/active/unknown outbox rows render no remediation.
- `pnpm --dir apps/console run types:check`, the targeted console tests, and `openspec validate --all --strict` pass.
