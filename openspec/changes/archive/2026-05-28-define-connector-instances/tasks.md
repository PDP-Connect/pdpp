## 0. Design Closeout

- [x] Confirm `connector_instance_id` is the durable configured-binding key and `connector_id` remains connector type identity.
- [x] Confirm `connection` is the owner-facing noun for a configured connector instance.
- [x] Confirm local collector uploads eventually resolve `{device_id, connector_id, local_binding}` to an authorized connector instance before ingest.
- [x] Defer the three open questions in `design.md` for the first implementation tranche.
- [x] Run 2026-05-18 connector-id namespace audit across storage/admission, runtime/orchestration, and UI/API/docs.

## 1. Instance Registry Substrate

- [x] Add persistent connector instance storage with owner, connector type, display label, lifecycle status, source binding metadata, and timestamps.
- [x] Add deterministic legacy default instance compatibility for existing owner/connector deployments.
- [x] Preserve temporary connector-only compatibility only for owner operations that resolve to exactly one active instance.
- [x] Add registry tests for two Gmail instances, two local-device instances, paused filtering, default instance compatibility, and ambiguous connector-only resolution.

## 2. Store Migration Tranche

- [x] Migrate existing connector-keyed records, record changes, stream version counters, blob bindings, connector state, schedules, active-run rows, run history, last-run gates, detail gaps, diagnostics, search indexes, and freshness into single-instance namespaces per owner/connector.
- [x] Update owner-auth ingest and blob upload/read paths to accept connector instance identity, with connector-only compatibility only when exactly one active instance exists.
- [x] Migrate connector state storage and owner-auth `/v1/state` reads/writes to connector-instance namespaces without exposing instance metadata on the public state response.
- [x] Update runtime checkpoint reads/writes so connector execution supplies connector instance identity rather than legacy connector-only fallback.
- [x] Update schedules, scheduler backoff, last-run gates, human-attention gates, and active-run leases so pause/resume/refresh/conflict checks operate per connector instance.
- [x] Update browser-surface leases and default profile keys so browser-backed connections isolate profiles and queued leases by connector instance rather than connector type.
- [x] Add migration tests proving existing single-connector deployments become one instance per owner/connector without data loss.
- [x] Add ambiguity tests proving connector-only refresh/pause/read operations fail when more than one instance exists.

## 3. Records, Search, And Collector Tranche

- [x] Update record ingest, idempotency, and indexing to distinguish records with the same connector type, stream, and connector-local key from different instances.
- [x] Update local collector/device ingest so every batch, heartbeat, run event, and diagnostic is authorized for a connector instance.
- [x] Replace or subordinate `source_instance_id` in CLI/device-exporter UX with connection / connector-instance terminology while preserving compatibility for existing local device bindings.
- [x] Scope local collector default queue durability by source binding or add locking/diagnostics proving concurrent local connections cannot corrupt the shared queue.
- [x] Add multi-account tests proving two Gmail instances do not share state, records, schedules, leases, or diagnostics.
- [x] Add multi-device tests proving Claude/Codex collectors on two devices do not overwrite each other's checkpoints or records.

## 4. Owner UX/API Tranche

- [x] Update owner-facing dashboard and reference-only operations to list, filter, and mutate connector instances rather than connector types alone.
- [x] Add `_ref` connection / connector-instance routes or projections for list/detail/run/schedule actions; keep connector-id routes as compatibility shims that reject ambiguity.
- [x] Update dashboard Records and Schedules copy/actions to use "connections" for actionable rows while retaining connector-type grouping.
- [x] Regenerate reference route docs and operator runbooks after instance-aware routes land.
- [x] Add owner UX/API tests proving instance labels and lifecycle actions target one instance.

## Acceptance Checks

- [x] `openspec validate define-connector-instances --strict`
- [x] `openspec validate --all --strict`
- [x] Relevant runtime tests pass once implementation tasks are started.
- [x] Grep confirms no remaining connector state, schedule, active-run lease, or owner mutation path uses `connector_id` alone as a durable instance key.
