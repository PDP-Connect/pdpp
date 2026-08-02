# Design

The connector-maintenance coordinator already owns durable summary-evidence
repair behind a fenced cursor. The timer now invokes that same coordinator
once when it is armed. The coordinator's in-flight guard and durable lease
continue to reject overlapping work, so startup and periodic maintenance share
one authority.

No GET route calls the coordinator. A failed pass is reported through the
existing timer error path and leaves the stale evidence visible for a later
retry.
