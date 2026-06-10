## Why

Filesystem-backed connectors such as Codex CLI and Claude Code are awkward in Docker because the data lives on the device where the agent runs, not necessarily on the personal server host. A local-device exporter/collector topology may be a better long-term answer than host bind mounts for multi-device deployments.

## What Changes

- Investigate a local device exporter/collector topology for filesystem-backed and device-local personal data sources.
- Compare pull exporters, push agents, and agent-to-gateway collector patterns against PDPP's grant, source-binding, and Collection Profile boundaries.
- Identify which moving parts already exist in the reference implementation and which are missing before a safe implementation.
- Define the minimum experimental slice for Codex CLI and Claude Code without finalizing protocol semantics.
- Capture source-instance/device identity as a blocking design issue before any multi-device ingest implementation.

## Capabilities

### New Capabilities

- `local-device-exporter-collection`: Proposed topology for collecting device-local data through an installed local exporter/agent rather than Docker bind mounts.

### Modified Capabilities

- None. This is an investigative/proposed capability. It does not modify existing canonical capabilities until accepted and archived.

## Impact

- Potential future code: reference runtime, connector runtime, Docker docs, device enrollment UI/CLI, ingest authorization, deployment diagnostics, and Codex/Claude Code connector packaging.
- Potential future protocol areas: Collection Profile boundaries, source-instance identity, event/freshness reporting, and client-visible query semantics for multi-device data.
- Security impact: introduces device identity, local filesystem access, revocation, replay/idempotency, and update posture questions.
