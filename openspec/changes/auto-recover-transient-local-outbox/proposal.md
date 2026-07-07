## Why

Local collectors can dead-letter durable outbox rows after transient reference-server failures such as `502`. A later scheduled run currently leaves those rows dead-lettered until an operator runs `pdpp-local-collector recover --apply`, even though the failure class is transient and the host owns the outbox.

## What Changes

- Requeue only transient local-device request dead letters at the start of a normal collector run.
- Keep terminal payload, protocol, and non-transient HTTP failures in dead-letter state for explicit recovery.
- Fix local recovery/run summaries so retrying rows are not double-counted as separate open work.
- Make CLI JSON writes tolerate closed stdout pipes.

## Capabilities

- Modified: `local-collector-durable-work`

## Impact

- A local collector that hit a transient reference outage can recover on the next scheduled run without manual repair.
- Operators still see and explicitly recover terminal dead letters.
- No protocol or server storage migration.
