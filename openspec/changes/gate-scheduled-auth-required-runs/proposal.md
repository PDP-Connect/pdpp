# gate-scheduled-auth-required-runs

## Why

ChatGPT scheduled collection previously succeeded by reusing an existing browser/API session. After that session was no longer active, scheduled runs first failed quietly because no credentials were available, then PR #76 made stored credentials available to scheduled runs and those runs began sending owner app-approval notifications.

PR #94 stopped non-manual runs from starting interactive ChatGPT auth repair, but the terminal failure is still not a complete recovery state: it can be classified as a generic runtime exception and it does not itself pause future automatic attempts through the existing scheduler gates.

## What Changes

- Classify ChatGPT non-interactive session-required failures as credential/auth repair, not connector-code failures.
- Preserve terminal auth-required details from managed scheduled runs so scheduler policy can react to the same evidence the run timeline records.
- Reuse the existing human-attention / durable-attention scheduler gates so future automatic attempts do not repeatedly prompt or relaunch while owner auth repair is pending.
- Keep manual owner runs as the repair path that clears the scheduler gate.

## Capabilities

Modified:
- `reference-implementation-runtime`
- `reference-run-assistance`

## Impact

- Reference implementation scheduler/controller/runtime behavior.
- ChatGPT connector terminal-error classification tests.
- Scheduler managed-run tests for auth-required gating.
- No PDPP Core protocol behavior change.
- No new connector-auth framework.
