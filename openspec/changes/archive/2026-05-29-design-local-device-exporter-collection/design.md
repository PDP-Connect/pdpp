## Status

This change is an investigative design track. It is not an accepted PDPP protocol change and does not finalize a new Collection Profile or connector manifest field.

## Prior Art

### Prometheus Exporters

Prometheus documents exporters as a way to expose data from systems that cannot be instrumented directly. This maps to Codex/Claude Code history: the source application is not a PDPP server, so an adapter process can translate local state into a scrapeable/exportable surface.

Prometheus also documents exporter-writing guidance and the multi-target exporter pattern. The useful lesson is separation of concerns: an exporter owns source-specific collection and exposes a narrow collection surface; the central server owns storage, query, alerting, and visualization.

References:

- https://prometheus.io/docs/instrumenting/exporters/
- https://prometheus.io/docs/instrumenting/writing_exporters/
- https://prometheus.io/docs/guides/multi-target-exporter/

### prometheus-pve-exporter

`prometheus-pve-exporter` is useful as a configuration-shape analogy: operators mount a config file such as `/etc/prometheus/pve.yml` into a container and the exporter uses named modules/targets. The important lesson is not "mount local filesystem data"; it is "keep deployment configuration explicit, file-backed, auditable, and outside the image."

Reference:

- https://github.com/prometheus-pve/prometheus-pve-exporter

### OpenTelemetry Collector

OpenTelemetry Collector has explicit agent, gateway, and agent-to-gateway deployment patterns. This is the closest analogy for "many machines with local data send to one central backend." The agent-to-gateway pattern also highlights retry queues, reliable forwarding, and routing consistency.

References:

- https://opentelemetry.io/docs/collector/deployment/
- https://opentelemetry.io/docs/collector/deploy/other/agent-to-gateway/

### Grafana Alloy / Agent

Grafana Alloy is an OpenTelemetry Collector distribution with Prometheus pipelines. Its relevance is fleet deployment and pipeline composition: local agents can collect host-local signals and forward them to a backend without the backend mounting the host filesystem.

References:

- https://grafana.com/oss/alloy-opentelemetry-collector/
- https://grafana.com/docs/alloy/latest/

### Vector Agent / Aggregator

Vector's agent and aggregator architecture is another direct analogue: deploy agents near local sources, optionally aggregate centrally, and choose topology based on operational constraints.

Reference:

- https://vector.dev/docs/setup/going-to-prod/arch/agent/

### Device Enrollment Analogues

Tailscale auth keys, Syncthing device IDs, and GitHub self-hosted runner registration all point to the same enrollment shape: an operator intentionally enrolls a local process, the enrolled device gets its own identity/credential, and revocation must target the enrolled device rather than the bootstrap token alone.

Useful lessons:

- Bootstrap credentials should be one-time or short-lived by default.
- The enrolled device needs a stable identity distinct from the owner account and distinct from the source connector.
- Revoking a bootstrap/enrollment token is not the same as revoking an already-enrolled device credential.
- The local agent should connect outward where possible; inbound reachability is an operations burden, not a protocol virtue.

References:

- https://tailscale.com/docs/features/access-control/auth-keys
- https://docs.syncthing.net/v1.22.2/dev/device-ids.html
- https://docs.github.com/actions/reference/self-hosted-runners-reference

### Transfer To PDPP

The parts that transfer cleanly are local collection, explicit enrollment, per-device identity, heartbeat/freshness, retryable forwarding, and an owner-facing fleet/status view.

The parts that do **not** transfer directly are Prometheus scrape semantics and observability-specific aggregation. PDPP records are user data, not metrics; the design must preserve grant-scoped disclosure, source-instance identity, record idempotency, and the Collection Profile boundary.

## Problem Shape

Direct Docker mounts solve one case: the personal server container runs on the same host that has the data. They do not solve:

- one personal server collecting from multiple devices,
- laptops or workstations that run Codex/Claude Code but do not host PDPP,
- remote servers where bind-mounting a user's home directory is undesirable,
- per-device freshness/health reporting,
- eventual device-scoped revocation or pause.

A local-device exporter/collector topology would install a small process on each device that has local data. That process reads the configured local sources and forwards or exposes normalized PDPP records to the personal server.

## Candidate Topologies

### Pull Exporter

The device runs an HTTP exporter. The personal server periodically scrapes it.

Pros:

- Familiar Prometheus mental model.
- Central server controls scheduling.
- Device exporter can be mostly stateless.

Cons:

- Device must be reachable from the server, often requiring LAN, VPN, Tailscale, reverse tunnel, or public exposure.
- Server needs credentials for each device endpoint.
- Not ideal for intermittently connected laptops.

### Push Agent

The device agent enrolls with the personal server and pushes batches/events.

Pros:

- NAT-friendly and laptop-friendly.
- Works across multiple networks.
- Agent can queue locally and retry.
- Closer to OpenTelemetry agent-to-gateway and Vector agent pipelines.

Cons:

- Requires device enrollment, device credentials, retry queues, and idempotency.
- The server must expose a trusted ingest endpoint for device agents.
- More moving parts than direct Docker mounts.

### Hybrid Agent

The device agent pushes records and heartbeats, while the server can provide desired schedule/config on polling or long-poll.

Pros:

- Push-friendly data path with central policy visibility.
- Allows future remote configuration without forcing inbound connectivity to the device.

Cons:

- More protocol surface.
- Requires careful update, revocation, and config-version semantics.

## Current Leaning

Use direct read-only Docker mounts for immediate local single-host usability. Treat local-device exporter/collector as the better long-term topology for multi-device filesystem-backed sources.

For the first reference implementation slice, use a **push-first device agent**. It works for laptops and remote devices without requiring inbound reachability, and it matches the OpenTelemetry/Vector agent-to-gateway pattern more closely than a scrape endpoint. Keep pull exporter support as a possible later mode for LAN/server deployments.

The first slice is reference-experimental only. It must not claim a finalized PDPP protocol or Collection Profile extension.

## Existing Moving Parts In PDPP

Already present or mostly present:

- Codex CLI and Claude Code connectors parse device-local files and emit normalized records (`packages/polyfill-connectors/connectors/codex/index.ts`, `packages/polyfill-connectors/connectors/claude_code/index.ts`).
- Connector manifests already declare `runtime_requirements.bindings.filesystem` (`packages/polyfill-connectors/manifests/codex.json`, `packages/polyfill-connectors/manifests/claude_code.json`).
- The connector runtime already owns START / RECORD / STATE / PROGRESS / DONE, shape validation, local state, progress, interactions, and fixture capture (`packages/polyfill-connectors/src/connector-runtime.ts`, `packages/polyfill-connectors/src/fixture-capture.ts`).
- The orchestrator and scheduler already know how to register manifests, issue an owner token for local runs, invoke connectors, persist sync state, and summarize run history (`packages/polyfill-connectors/bin/orchestrate.ts`, `packages/polyfill-connectors/src/scheduler-runner.ts`, `reference-implementation/runtime/index.js`, `reference-implementation/runtime/scheduler.ts`).
- The reference RS already stores normalized records and supports grant-scoped query, search, schema, `changes_since`, and derived index maintenance (`reference-implementation/server/records.js`, `reference-implementation/server/postgres-records.js`).
- Existing public RS routes in `reference-implementation/server/index.js` are read/query surfaces and should not be repurposed for device ingest.
- The reference has event-spine/run-history and deployment-diagnostics surfaces for operator visibility (`reference-implementation/lib/spine.ts`, `reference-implementation/runtime/controller.ts`, `reference-implementation/runtime/scheduler.ts`, `reference-implementation/server/stores/scheduler-store.ts`, `reference-implementation/server/deployment-diagnostics.ts`).
- The web dashboard already has nearby surfaces for records, stream health, timelines, runs, schedules, deployment diagnostics, and token management (`apps/web/src/app/dashboard/records/page.tsx`, `apps/web/src/app/dashboard/records/[connector]/[stream]/health/page.tsx`, `apps/web/src/app/dashboard/records/timeline/page.tsx`, `apps/web/src/app/dashboard/runs/page.tsx`, `apps/web/src/app/dashboard/schedules/page.tsx`, `apps/web/src/app/dashboard/deployment/page.tsx`, `apps/web/src/app/dashboard/deployment/tokens/actions.ts`).
- Owner device authorization provides a reusable lifecycle shape for initiate → approve/deny → exchange, but its tokens are owner tokens and must not be reused directly as device-exporter credentials (`reference-implementation/server/stores/owner-device-auth-store.js`).
- Refresh-policy work already classifies connector scheduling posture via manifest capabilities.

Missing or unresolved:

- Device enrollment and device identity.
- A trusted device-agent ingest endpoint distinct from public client read access.
- Source-instance identity in storage and query. Current connector-shaped storage risks conflating records from multiple devices if only `connector_id + stream + record_key` is used.
- Idempotency and replay protection for pushed batches.
- Local queue/retry behavior on the agent.
- Device health/freshness reporting.
- Update and trust posture for installed device agents.
- Owner UI to approve, revoke, pause, or inspect device exporters.
- Clear boundary between Collection Profile conformance and a possible local-device exporter profile.

Conclusion: a new collection-side route is required. Reusing `ingestRecord()` and index maintenance internally is appropriate, but exposing that path over HTTP needs a new credential kind, source-instance-aware storage binding, and idempotency/replay checks. Reusing public read/query routes would violate the ingest/disclosure separation requirement.

## Source Identity Gate

This is the highest-risk design issue.

For Codex/Claude Code, the same `connector_id` may exist on multiple devices. Record keys that are unique on one machine may collide or become semantically ambiguous across machines. A safe design needs a source-instance dimension such as:

- `device_id`,
- `source_instance_id`,
- connector configuration instance,
- or a storage-binding extension that names both connector and device/source instance.

This must be decided before implementation. A quick push endpoint that writes multi-device records into the current connector-only namespace would create silent data corruption or misleading query results.

Decision for the first reference-experimental slice:

- Assign every enrolled exporter a server-generated `device_id`.
- Assign every configured connector-on-device binding a `source_instance_id`, initially derived from `{device_id, connector_id, local_binding_name}`.
- Store and index pushed records under a source-instance-aware storage binding before they reach the current `connector_id + stream + record_key` namespace. The implementation may use a reference-only storage adapter or key namespace while the protocol question remains proposed.
- Keep public run/event source descriptors as `{ kind: "connector", id: connector_id }` unless a later accepted PDPP/Profile change adds source-instance semantics to the public contract.

Protocol/Profile owner questions to promote separately:

- Whether `source_instance_id` becomes a core PDPP source dimension, a Collection Profile extension, or remains reference-local.
- Whether clients can request/query by device/source instance, or whether source instance remains owner/operator metadata only.
- Whether connector manifests can declare source-instance fields or sensitivity; this change must not unilaterally add manifest schema.

## Security And Privacy Requirements

The device exporter must not become a broad remote-filesystem bridge.

Principles:

- Local device agent reads only explicitly configured source directories.
- Mounts or local file access are read-only wherever the platform allows it.
- Device enrollment is explicit and revocable by the owner.
- Device credentials are scoped to ingest/heartbeat for that device and source bindings, not owner query access.
- Enrollment bootstrap credentials are short-lived and single-use by default; active device credentials are revoked separately.
- Batch ingest is idempotent and replay-resistant.
- The personal server records per-device freshness/health without exposing paths unnecessarily to clients.
- Client grants authorize query results, not device-agent control.

## Relationship To Webhooks And Freshness

This topology complements, but does not replace, client-facing event subscriptions and freshness semantics.

- Device exporter push events are collection-side events.
- Client subscriptions are disclosure-side events constrained by client grants.
- Freshness metadata is the bridge between them: a client should be able to know how recently the personal server observed data, without receiving a false guarantee about upstream freshness.

The related design note is `design-notes/client-event-subscriptions-and-freshness-2026-04-26.md`.

## First Experimental Slice

A safe first slice would avoid new public client protocol:

1. Create a local device agent mode for the Codex CLI connector first; Claude Code follows once the source-instance path is proven. Codex is the stronger dogfood path for this repo, already has a manifest, and exercises both rollout JSONL and read-only SQLite state.
2. Enroll a device with the reference server using a one-time owner-approved enrollment code and exchange it for a device-scoped ingest credential.
3. Run the existing connector locally through the Collection Profile runtime, but push accepted output through a new reference-only device-ingest envelope rather than pretending the remote server is the connector runtime.
4. Include `device_id`, `source_instance_id`, `batch_id`, `batch_seq`, `body_hash`, connector id, stream, record key, emitted time, and normalized record data in the ingest path.
5. Make batch ingest idempotent by storing `(device_id, batch_id, body_hash)`; repeated same-body delivery returns the original outcome, while same batch id with a different body is rejected.
6. Keep a small local durable queue on the agent for failed batches, retry with backoff, and preserve per-source-instance ordering.
7. Show device health/freshness in the owner dashboard: enrolled devices, configured source instances, last heartbeat, last ingest, records accepted/rejected, stale/unreachable state, and last error.
8. Query records through existing RS grant/query surfaces while preserving source-instance separation internally.

Stop before claiming this is a Collection Profile extension. Promote spec questions separately once the implementation proves the topology.

The implementation belongs in a follow-up OpenSpec change. This design change chooses the experimental topology and safety constraints; it should not land `/v1/device-ingest`, enrollment tables, dashboard UI, or storage-key changes directly.
