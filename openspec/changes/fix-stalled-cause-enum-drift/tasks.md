## 1. Spec correction

- [x] Widen the stalled-cause enum in `reference-connection-health` to the
  five values the implementation classifies.
- [x] Correct the precedence-ordering sentence to the full five-way rank
  order (`server/connector-outbox-axis.ts` `STALLED_CAUSE_RANK`).
- [x] Add a `transient_upload_failure` classification scenario.
- [x] Add a `stale_heartbeat` classification scenario.
- [x] `openspec validate fix-stalled-cause-enum-drift --strict` passes.
