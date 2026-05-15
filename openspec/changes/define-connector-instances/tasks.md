## 1. Design Acceptance

- [ ] Confirm `connector_instance_id` is the durable configured-binding key and `connector_id` remains connector type identity.
- [ ] Confirm local collector uploads resolve `{device_id, connector_id, local_binding}` to an authorized connector instance before ingest.
- [ ] Decide whether the three open questions in `design.md` remain deferred or need a follow-up OpenSpec change before implementation.

## 2. Runtime Implementation Plan

- [ ] Add persistent connector instance storage with owner, connector type, display label, lifecycle status, source binding metadata, and timestamps.
- [ ] Migrate existing connector-keyed state, schedules, active-run rows, diagnostics, and records into single-instance namespaces per owner/connector.
- [ ] Update connector state and checkpoint reads/writes to require connector instance identity.
- [ ] Update record ingest, idempotency, and indexing to distinguish records with the same connector type, stream, and connector-local key from different instances.
- [ ] Update schedules and active-run leases so pause/resume/refresh/conflict checks operate per connector instance.
- [ ] Update local collector/device ingest so every batch, heartbeat, run event, and diagnostic is authorized for a connector instance.
- [ ] Update owner-facing dashboard and reference-only operations to list, filter, and mutate connector instances rather than connector types alone.
- [ ] Preserve temporary connector-only compatibility only for owner operations that resolve to exactly one instance.

## 3. Tests And Validation

- [ ] Add migration tests proving existing single-connector deployments become one instance per owner/connector without data loss.
- [ ] Add multi-account tests proving two Gmail instances do not share state, records, schedules, leases, or diagnostics.
- [ ] Add multi-device tests proving Claude/Codex collectors on two devices do not overwrite each other's checkpoints or records.
- [ ] Add ambiguity tests proving connector-only refresh/pause/read operations fail when more than one instance exists.
- [ ] Add owner UX/API tests proving instance labels and lifecycle actions target one instance.

## Acceptance Checks

- [ ] `openspec validate define-connector-instances --strict`
- [ ] `openspec validate --all --strict`
- [ ] Relevant runtime tests pass once implementation tasks are started.
- [ ] Grep confirms no remaining connector state, schedule, active-run lease, or owner mutation path uses `connector_id` alone as a durable instance key.
