## 1. Prior-Art Research

- [x] Review Prometheus exporter and multi-target exporter patterns for scrape/pull topology lessons.
- [x] Review OpenTelemetry Collector agent, gateway, and agent-to-gateway patterns for push/forwarding lessons.
- [x] Review Grafana Alloy and Vector agent/aggregator patterns for fleet-management, config, and retry lessons.
- [x] Review device enrollment and local-agent examples outside observability if relevant (Tailscale, Syncthing, backup agents, GitHub self-hosted runners).
- [x] Summarize which parts transfer to PDPP and which do not.

## 2. Existing-Pieces Inventory

- [x] Inventory current Codex CLI and Claude Code connector code paths that can be reused inside a local device agent.
- [x] Inventory existing ingest paths and decide whether an exporter needs a new device-ingest route or can reuse connector runtime plumbing.
- [x] Inventory current auth/token machinery from `add-agent-scoped-pdpp-access` and identify what can be reused for device enrollment.
- [x] Inventory current freshness, run timeline, deployment diagnostics, and scheduler pieces that can display device-agent status.

## 3. Architecture Decisions

- [x] Decide first experimental topology: pull exporter, push agent, or hybrid.
- [x] Decide source-instance identity model before implementation.
- [x] Decide whether device agents emit Collection Profile messages locally, push normalized records directly, or use a new reference-only ingest envelope.
- [x] Decide credential scope and revocation behavior for device agents.
- [x] Decide idempotency keys, replay protection, and retry/queue semantics.

## 4. Experimental Slice Planning

- [x] Choose first source: Codex CLI or Claude Code.
- [x] Define the smallest owner-visible device enrollment flow.
- [x] Define the first dashboard diagnostics: enrolled devices, last report, last ingest, records accepted/rejected, stale/unreachable state.
- [x] Define the first test plan for multi-device collision prevention.
- [x] Decide whether the implementation belongs under this change or a follow-up implementation change.

## 5. Validation

- [x] `openspec validate design-local-device-exporter-collection --strict`
- [x] `openspec validate --all --strict`
