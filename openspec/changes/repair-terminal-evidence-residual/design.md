# Design

The connector-maintenance coordinator already owns durable summary-evidence
repair behind a fenced cursor. The startup multi-round walker now invokes that
coordinator immediately during startup, before the periodic timer is armed.
That call claims the in-process guard and durable lease before its first
await, so it is the one explicit first-pass authority. The timer retains its
ordinary periodic cadence; it does not compete with the startup walker using
an immediate tick.

No GET route calls the coordinator. A failed pass leaves the stale evidence
visible for a later periodic retry. The startup walk remains finite through
its existing round cap and keeps the durable cursor/fence unchanged.
