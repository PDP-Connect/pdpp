## 1. Projection Fix

- [x] 1.1 Add a server-rollup regression test for fresh local heartbeat plus stale historical scheduler history.
- [x] 1.2 Update local-device freshness projection so trusted local progress can anchor freshness even when old run rows exist.
- [x] 1.3 Treat active local-device outbox progress with fresh complete
      evidence as syncing/idle work-in-progress rather than as an unknown
      collection verdict.

## 2. Validation

- [x] 2.1 Run `openspec validate use-local-progress-for-device-freshness --strict`.
- [x] 2.2 Run targeted reference connection-health/local-device tests.
- [ ] 2.3 Verify the live local-device source summaries no longer require manual repair or render Not measured when heartbeats/outboxes are current.
