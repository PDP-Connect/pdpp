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

`startServer` accepts a narrow timer-constructor seam for integration tests.
Production retains the normal timer constructor. The integration fixture uses
that same startup path to enable an immediate competing tick while a real
startup fold is paused, and observes every startup round through the callback
that `startServer` already passes to its walker. This makes a reverted launch
ordering observable without a second startup implementation in test code.
