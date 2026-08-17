## Why

A connector can complete and durably flush several independent streams before a later stream fails. The current all-or-nothing checkpoint rule discards those proven sibling checkpoints, forcing every retry to repeat completed work and making large multi-stream sources needlessly slow to converge.

## What Changes

- Define a narrow, provider-neutral partial-failure contract for a failed `DONE` paired with matching, in-scope `SKIP_RESULT` messages that identify the failed streams.
- Permit the runtime to commit only staged state streams that are independent of every identified failed stream, while preserving the failed run and retryable coverage gap.
- Keep all other failed, cancelled, ambiguous, malformed, or unterminated runs fail-closed with no checkpoint commit.
- Record the checkpoint-parent mapping rule so a failed child stream cannot advance the parent cursor that covers it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `polyfill-runtime`: Define the protocol evidence required to certify a stream-scoped failure and the checkpoint semantics for unaffected sibling streams.
- `reference-implementation-runtime`: Commit only proven sibling checkpoints for a certified stream-scoped failure and expose honest partial-commit terminal evidence.

## Impact

- Updates the normative Collection Profile checkpoint contract.
- Changes reference runtime terminal checkpoint handling and conformance tests.
- Does not add provider-specific logic, change record ingestion, or allow failed streams to claim complete coverage.
