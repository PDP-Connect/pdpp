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

If implemented experimentally, prefer a **push-first device agent** for the first slice because it works for laptops and remote devices without requiring inbound reachability. Keep pull exporter support as a possible later mode for LAN/server deployments.

## Existing Moving Parts In PDPP

Already present or mostly present:

- Codex CLI and Claude Code connectors parse device-local files and emit normalized records.
- Connector manifests already declare `runtime_requirements.bindings.filesystem`.
- The connector runtime already owns START / RECORD / STATE / PROGRESS / DONE and shape validation.
- The reference RS already stores normalized records and supports grant-scoped query, search, schema, `changes_since`, and freshness-related metadata work.
- The reference has an event spine/run timeline model for operator visibility.
- Agent-scoped access work already explores local agent client registration, scoped grants, and project-local credential caches.
- Refresh-policy work already classifies connector scheduling posture.

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

## Source Identity Gate

This is the highest-risk design issue.

For Codex/Claude Code, the same `connector_id` may exist on multiple devices. Record keys that are unique on one machine may collide or become semantically ambiguous across machines. A safe design needs a source-instance dimension such as:

- `device_id`,
- `source_instance_id`,
- connector configuration instance,
- or a storage-binding extension that names both connector and device/source instance.

This must be decided before implementation. A quick push endpoint that writes multi-device records into the current connector-only namespace would create silent data corruption or misleading query results.

## Security And Privacy Requirements

The device exporter must not become a broad remote-filesystem bridge.

Principles:

- Local device agent reads only explicitly configured source directories.
- Mounts or local file access are read-only wherever the platform allows it.
- Device enrollment is explicit and revocable by the owner.
- Device credentials are scoped to ingest/heartbeat for that device, not owner query access.
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

1. Create a local device agent mode for one filesystem source, likely Claude Code or Codex CLI.
2. Enroll a device with the reference server and get a device-scoped ingest credential.
3. Emit a small set of records with a source-instance identifier.
4. Show device health/freshness in the owner dashboard.
5. Query records through existing RS grant/query surfaces.

Stop before claiming this is a Collection Profile extension. Promote spec questions separately once the implementation proves the topology.
