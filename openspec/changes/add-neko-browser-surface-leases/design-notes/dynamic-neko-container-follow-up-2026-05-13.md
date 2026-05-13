# Dynamic n.eko Container Allocation Follow-Up

Status: decided-defer
Owner: Worker D
Created: 2026-05-13
Updated: 2026-05-13
Related: openspec/changes/add-neko-browser-surface-leases

## Question

What should the post-static n.eko tranche build once the lease state machine is proven with one configured Compose surface?

## Context

The first tranche is intentionally static: one Compose `neko` service, one CDP endpoint, one stream base URL, `PDPP_NEKO_SURFACE_CAP=1`, and one compatible `PDPP_NEKO_STATIC_PROFILE_KEY`. That proves managed connector policy, pre-spawn queueing, incompatible-profile defer, and fail-closed child env without claiming multi-surface concurrency.

Dynamic allocation is a separate boundary because it changes container lifecycle, profile storage, health reconciliation, and capacity behavior.

## Stakes

Treating the static overlay as multi-surface would overstate correctness and risk profile leakage. Dynamic allocation must create a separate browser surface per compatible profile and make lifecycle choices explicit enough for restart reconciliation and operator diagnostics.

## Current Leaning

The next tranche should add a controller-owned n.eko surface allocator with:

- Per-surface n.eko container allocation keyed by `surface_id`, not a shared static service.
- Per-profile persistent volumes or directories keyed by the lease `profile_key`, with account-scoped keys when account identity lands.
- Health checks for n.eko HTTP, CDP `/json/version`, browser process liveness, and stream readiness before lease promotion.
- Optional warm-pool policy for ready idle surfaces when capacity and memory budgets allow it.
- Idle TTL shutdown that releases stopped containers while retaining profile volumes for future runs.
- Reconciliation that preserves profile volumes, expires missing surfaces, marks unhealthy surfaces failed, and restarts the queue pump after storage initialization.

## Promotion Trigger

Promote this into OpenSpec before implementing dynamic containers, increasing `PDPP_NEKO_SURFACE_CAP` above one in Docker docs, or adding multiple configured n.eko services.

## Decision Log

- 2026-05-13: Deferred out of the static Docker lane. The static overlay remains cap `N=1` and routes managed connectors through controller-owned lease env rather than per-profile remote-CDP overrides.
