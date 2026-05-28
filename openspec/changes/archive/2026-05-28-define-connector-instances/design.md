## Context

`connector_id` currently names a connector implementation or manifest, such as Gmail, Claude Code, or Codex. Real owner deployments need more than one configured binding for the same connector type:

- two Gmail accounts for the same owner,
- Claude Code history collected from a laptop and a desktop,
- Codex history collected by multiple local collectors,
- future source bindings that share connector code but have distinct credentials, schedules, and freshness.

If these bindings share `connector_id` as their durable key, they can collide in connector state, record identity, schedule lifecycle, active-run conflict detection, and owner-facing diagnostics.

## Goals

- Make connector instances the durable reference identity for configured connector bindings.
- Use `connection` as the owner-facing product noun for a configured connector instance.
- Preserve `connector_id` as connector type identity for manifest lookup and source labels.
- Support multi-account and multi-device collection without record, state, schedule, lease, or UX collisions.
- Provide migration criteria before runtime code changes.
- Keep this as a reference implementation design unless a later PDPP/Profile change promotes source-instance semantics.

## Non-Goals

- Do not move connector state, records, schedules, active-run leases, diagnostics, search indexes, or dashboard UX to instance identity in the first substrate tranche.
- Do not require a new public PDPP source shape in this tranche.
- Do not decide whether connector instance identity becomes a normative Collection Profile field.
- Do not design all credential-vault details beyond instance-scoped ownership and revocation boundaries.

## Design

### Identity Model

`connector_id` remains the stable connector type identifier. It answers "which connector implementation and manifest is this?"

`connector_instance_id` becomes the stable configured binding identifier. It answers "which owner-approved account, device, local binding, or collector source is this?"

`connection` is the owner-facing product noun for the same configured binding. User-facing copy should prefer "connection" when the owner can add, pause, refresh, inspect, schedule, or revoke the configured source. Technical reference APIs may continue to use `connector_instance_id` until an accepted UI/API naming change chooses a different wire name.

A connector instance has at least:

- `owner_id`,
- `connector_instance_id`,
- `connector_id`,
- owner-facing display label,
- lifecycle status such as active, paused, or revoked,
- source binding metadata sufficient to distinguish account/device/local binding without exposing secrets.

For server-side account connectors such as Gmail, the instance maps to one configured account authorization. For local collector connectors such as Claude Code or Codex, the instance maps to one enrolled device plus one local binding for that connector. This aligns with the existing local-device exporter design, where a device plus connector plus local binding becomes a source instance.

`source_instance_id` is not promoted as a peer top-level noun by default. Source/account/profile/device details remain structured binding metadata under the connector instance unless a future invariant requires independent lifecycle, authority, schedule, health, grant, or storage namespaces below the connection.

### Storage And Runtime Boundaries

The storage boundary must treat `connector_instance_id` as part of the namespace for:

- connector state and checkpoints,
- record identity and idempotency,
- blob bindings,
- schedule rows,
- active-run leases,
- run history and diagnostics,
- scheduler backoff and last-run gates,
- detail gaps and recovery state,
- search index rows and backfill progress,
- browser-surface profile/lease ownership,
- collector heartbeats and freshness,
- owner dashboard list/detail routes.

The active-run invariant changes from one active run per connector type to one active run per connector instance unless a later design explicitly allows multiple lanes within one instance. Records from two instances may share `connector_id`, stream, and connector-local key; they must still remain distinct unless an explicit cross-instance deduplication rule is approved.

### Public And Owner-Facing Representation

Reference-internal and owner-facing surfaces should expose connector instance identity. Client-facing PDPP read/disclosure surfaces should continue to use grant-safe source and record views unless a later protocol/Profile change adds source-instance fields.

Owner UX must group by connector type while making configured instances distinct, for example "Gmail - work", "Gmail - personal", "Claude Code - laptop", and "Codex - desktop". Actions such as pause, resume, revoke, refresh, and inspect diagnostics operate on the instance, not every instance of the connector type.

### Migration

Migration must be explicit because existing reference state is connector-keyed. The safe default is to create one connector instance per existing owner/connector binding and move connector-keyed rows under that instance.

Migration needs a deterministic instance id or a persisted generated id. It must not infer that records from two future accounts/devices are the same logical records. Existing single-connector deployments can become one instance per connector without changing visible behavior, but all future writes must use the instance namespace.

Compatibility reads may temporarily accept connector-only identifiers only when they resolve to exactly one instance for that owner. Ambiguous connector-only operations must fail with a clear error rather than choosing an arbitrary instance.

### Relationship To Local Collectors

Device enrollment remains device-scoped. A device is not itself a connector instance because one device can collect multiple connectors or multiple local bindings for the same connector. The collector upload path must resolve each uploaded batch to an authorized connector instance before accepting records, state, health, or diagnostics.

This lets two local Claude/Codex collectors report the same connector type without fighting over checkpoint state, record keys, schedules, or active-run leases.

### 2026-05-18 Namespace Audit

Read-only audit reports under `tmp/workstreams/connector-id-namespace-audit-*.md` confirmed the current reference is not multi-connection-ready beyond the instance registry substrate:

- records, record changes, stream versions, blob bindings, connector state, schedules, active runs, run history, last-run gates, detail gaps, search indexes, and several conformance tests still use bare `connector_id` as a durable namespace;
- runtime maps for active runs, human-attention gates, scheduler backoff, schedule eligibility, browser surface leases, and in-process state reads/writes still key by connector type;
- owner-facing dashboard records/schedules and `_ref/connectors/:connectorId/...` routes still treat connector type as the configured source;
- the local device/exporter path already synthesizes a source-instance storage namespace, but that workaround should migrate into first-class connector-instance columns rather than overloading `connector_id`;
- the CLI/device-exporter use of `source_instance_id` should be treated as a device-binding detail or legacy compatibility field once connection identity is wired.

This audit changes the implementation order: do not claim multi-account or multi-device support until the storage/runtime/UI namespaces above are instance-scoped or reject ambiguous connector-only operations.

### Open Questions

- Whether connector instance identity should become Collection Profile vocabulary or remain reference-only.
- Whether grant-authorized clients should ever be able to filter by connector instance, or whether instance identity remains owner/operator metadata.
- Whether cross-instance deduplication is desirable for specific connectors such as Gmail message IDs, and where that rule should live.
- Whether any source binding below a connection deserves promotion to a first-class object after evidence shows independent lifecycle, authority, schedule, health, grant, or storage semantics.

These questions are deferred for the first implementation tranche. The tranche only creates reference-owned instance registry storage and single-instance compatibility resolution; it does not expose instance identity to grant-authorized client reads, public protocol routes, or cross-instance record identity rules.

## Alternatives Considered

- **Keep `connector_id` and append device/account fields ad hoc:** rejected because every store and UI would need bespoke collision rules.
- **Use `device_id` as the namespace:** rejected because account connectors may have no local device and one device can host multiple connector bindings.
- **Use account email or local path as the primary key:** rejected because those values can change, may be sensitive, and are not universal across connector types.
- **Expose instance identity as PDPP public source identity now:** rejected for this tranche because it would prematurely widen protocol/Profile semantics.

## Acceptance Checks

- `openspec validate define-connector-instances --strict`
- `openspec validate --all --strict`
- Review confirms the first implementation tranche only touches instance registry schema/store/test surfaces and does not alter dashboard UX or connector runtime behavior.
- The spec delta covers collision isolation for state, records, schedules, active-run leases, diagnostics, and owner UX.
- The task list includes migration and compatibility criteria before implementation.
- The implementation plan is checked against the 2026-05-18 namespace audit before any multi-account/multi-device claim is made.
