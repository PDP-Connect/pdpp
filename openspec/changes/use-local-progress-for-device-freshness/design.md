## Context

Local-device collectors push records from a device outbox and do not require a scheduler run to prove current device progress. The connection-health projection already accepts a local-device collection verdict when coverage is complete, outbox work is idle, and freshness is fresh.

The residual bug is the freshness anchor. `synthesizeConnectorSummary` computes a healthy heartbeat timestamp, but `buildConnectorFreshness` only uses that timestamp when `lastRun == null`. Live local collector connections can still have stale historical run rows. Those old rows then suppress fresh heartbeat evidence and make the connection appear stale/degraded after the collector has actually checked in or drained.

## Goals / Non-Goals

**Goals:**

- For `sourceKind=local_device`, use trusted local-device progress as the freshness anchor whenever the caller has established that heartbeat evidence is eligible.
- Preserve the safety gates that prevent false green status: stalled outbox, dead letters, incomplete coverage, owner attention, active failures, and missing freshness policy still win through existing conditions.
- Add a server-rollup regression test that matches the live shape: local-device heartbeat inside the freshness window plus stale historical scheduler run history.

**Non-Goals:**

- Changing how local collector outboxes drain or retry.
- Changing connector manifests or the stream coverage/freshness evidence contract.
- Changing owner-console layout or labels.

## Decisions

### Use local progress as authoritative freshness evidence for local-device connections

The correct source of freshness for local-device-backed connections is trusted local progress, not scheduler history. Scheduler history is not the primary execution substrate for push-mode collectors, and old rows must not override current heartbeat evidence.

Alternative considered: keep heartbeat as a fallback only when no run exists. This is the current behavior and fails on real instances with stale historical run rows.

### Keep heartbeat eligibility narrow

The caller passes a heartbeat timestamp only when local-device progress is trusted and the outbox axis is non-stalled: either idle with a healthy zero-pending heartbeat, or active with a recent heartbeat that the outbox projection has already classified as normal draining work. Stalled or unknown outboxes continue to surface through the outbox axis and cannot be greened by heartbeat freshness.

Alternative considered: use `last_ingest_at` or any heartbeat regardless of status. That would green retrying/stalled device work and hide local repair issues.

### Do not alter generic freshness derivation

`deriveReferenceFreshness` remains a generic helper over run/record timestamps. The local-device decision belongs in the caller that knows the connection binding kind and whether the heartbeat row is trusted.

## Risks / Trade-offs

- A local-device connection with a healthy heartbeat but unrelated old failed run will no longer be stale solely because of that old run. This is intended for push-mode collectors because current trusted device progress is the better freshness fact.
- If heartbeat eligibility is too broad, it could hide device backlog. The implementation keeps the current zero-pending/healthy gate and leaves outbox/coverage evidence load-bearing.

## Migration Plan

Deploy as a projection-only change. Existing data does not require migration. Rollback is the previous projection behavior.
