# Local Collector Recovery Should Finish Or Become Explicit Background Work

Status: captured
Owner: Codex RI owner
Created: 2026-06-17
Updated: 2026-06-17
Related: `openspec/changes/redesign-connection-health-verdict-and-recovery`

## Question

When a local-device source has a stalled outbox and the owner runs the focused
recovery command, should `pdpp-local-collector recover --source-instance-id <id>
--apply` continue until the source is fully drained, or should it hand off to a
visible background-drain model with clear progress?

## Context

The source-profile recovery fix shipped and was live-verified on
`pdpp.vivid.fish` for peregrine Claude Code on 2026-06-17:

- The dashboard rendered source-profile commands with
  `--source-instance-id dsrc_f23027f4ec365b1e`, no public
  `connector_instance_id` placeholder, and no legacy `retry-dead-letters`
  command.
- `@pdpp/local-collector@0.6.0` was published and `npx -y
  @pdpp/local-collector@latest recover --source-instance-id
  dsrc_f23027f4ec365b1e` resolved the local profile and the correct SQLite
  queue.
- The dry run found one dead-lettered upload row caused by a previous
  `local device request failed: 502`.
- The apply run requeued that row, created a backup, ran the collector once, and
  uploaded 77 batches.
- The apply run then returned with no dead-letter rows but 1,348 ready batches
  still queued. The server verdict changed from owner attention to calm/checking
  with `LocalExporterAvailable:local_exporter_active` and
  `BacklogClear:outbox_active`.

The installed systemd user timer is active and runs every 15 minutes:

- `pdpp-claude_code-collector.timer` is enabled and active.
- The service had recently exited successfully.
- The profile's base URL is `https://peregrine-dev.vivid.fish`, which is an
  alias for the same deployed reference instance; metadata reports issuer
  `https://pdpp.vivid.fish` and the same deployed revision.

The current runner policy intentionally bounds a drain pass:

- `drainBatchSize: 4`
- `maxDrainDurationMs: 120_000`
- `maxDrainIterations: 256`

That bound is defensible for normal scheduled runs because a single invocation
must not monopolize the host. It is less defensible as the end state of an
owner-initiated recovery command whose purpose is "fix this source."

## Stakes

The recovery journey is no longer broken, but it is not yet ideal. A motivated
owner can now run a correct command, yet the command may return while meaningful
work remains. The dashboard is right to avoid alarming the owner once the
remaining work is self-handled, but the system still owes the owner a clear
answer to "is it fixed?"

If this remains implicit, the next confusion will be predictable:

- The command says it ran, but the source may still show checking/draining.
- The owner has no obvious estimate of how long the background drain will take.
- A large backlog may take many 15-minute timer cycles even though the owner just
  performed a recovery action.

## Current Leaning

Treat local collector recovery as two phases:

1. **Foreground repair:** clear the condition that required owner action
   (`dead_letter_backlog`, `state_read_failed`, or `stale_pending`) and prove the
   collector can make progress.
2. **Background drain:** when remaining work is self-handled, the dashboard
   should say this plainly and show progress in inspection/detail surfaces
   without raising attention.

Do not silently remove the runner's safety budgets for every scheduled run. The
SLVP-ideal shape is likely one of these:

- `recover --apply --until-idle` or equivalent explicit foreground mode with a
  bounded wall-clock and progress output, used by the dashboard only when it is
  safe for a person to wait.
- A local supervisor handoff where `recover --apply` starts or nudges the
  collector timer/service and returns a clear "uploading in the background"
  status, while the dashboard renders the current backlog, last progress, and
  next expected attempt in the detail layer.
- A server-side desired-drain signal that the host collector consumes, avoiding a
  copy-paste loop while preserving the owner-host boundary. This is a larger
  construction and should not be invented in a bug patch.

## Promotion Trigger

Promote into OpenSpec before changing behavior if any of the following are true:

- The CLI grows a new recovery mode or option.
- The systemd/local supervisor contract changes.
- The dashboard adds a new self-handled drain progress presentation.
- The reference server records or requests a desired local-device drain.

## Decision Log

- 2026-06-17: Captured after live recovery of peregrine Claude Code. The
  existing source-profile command fixed the dead-letter state, published through
  npm, and moved the server verdict out of attention. It did not fully drain the
  local outbox in one foreground command.
