## 0. Design Closeout

- [x] Confirm `connector_instance_id` is the durable configured-binding key and `connector_id` remains connector type identity.
- [x] Confirm local collector uploads eventually resolve `{device_id, connector_id, local_binding}` to an authorized connector instance before ingest.
- [x] Defer the three open questions in `design.md` for the first implementation tranche.

## 1. Instance Registry Substrate

- [x] Add persistent connector instance storage with owner, connector type, display label, lifecycle status, source binding metadata, and timestamps.
- [x] Add deterministic legacy default instance compatibility for existing owner/connector deployments.
- [x] Preserve temporary connector-only compatibility only for owner operations that resolve to exactly one active instance.
- [x] Add registry tests for two Gmail instances, two local-device instances, paused filtering, default instance compatibility, and ambiguous connector-only resolution.

## 2. Store Migration Tranche

- [ ] Migrate existing connector-keyed state, schedules, active-run rows, diagnostics, and records into single-instance namespaces per owner/connector.
- [ ] Update connector state and checkpoint reads/writes to require connector instance identity.
- [ ] Update schedules and active-run leases so pause/resume/refresh/conflict checks operate per connector instance.
- [ ] Add migration tests proving existing single-connector deployments become one instance per owner/connector without data loss.
- [ ] Add ambiguity tests proving connector-only refresh/pause/read operations fail when more than one instance exists.

## 3. Records, Search, And Collector Tranche

- [ ] Update record ingest, idempotency, and indexing to distinguish records with the same connector type, stream, and connector-local key from different instances.
- [ ] Update local collector/device ingest so every batch, heartbeat, run event, and diagnostic is authorized for a connector instance.
- [ ] Add multi-account tests proving two Gmail instances do not share state, records, schedules, leases, or diagnostics.
- [ ] Add multi-device tests proving Claude/Codex collectors on two devices do not overwrite each other's checkpoints or records.

## 4. Owner UX/API Tranche

- [ ] Update owner-facing dashboard and reference-only operations to list, filter, and mutate connector instances rather than connector types alone.
- [ ] Add owner UX/API tests proving instance labels and lifecycle actions target one instance.

## Acceptance Checks

- [x] `openspec validate define-connector-instances --strict`
- [ ] `openspec validate --all --strict`
- [x] Relevant runtime tests pass once implementation tasks are started.
- [ ] Grep confirms no remaining connector state, schedule, active-run lease, or owner mutation path uses `connector_id` alone as a durable instance key.
