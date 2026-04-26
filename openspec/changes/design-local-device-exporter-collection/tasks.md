## 1. Prior-Art Research

- [ ] Review Prometheus exporter and multi-target exporter patterns for scrape/pull topology lessons.
- [ ] Review OpenTelemetry Collector agent, gateway, and agent-to-gateway patterns for push/forwarding lessons.
- [ ] Review Grafana Alloy and Vector agent/aggregator patterns for fleet-management, config, and retry lessons.
- [ ] Review device enrollment and local-agent examples outside observability if relevant (Tailscale, Syncthing, backup agents, GitHub self-hosted runners).
- [ ] Summarize which parts transfer to PDPP and which do not.

## 2. Existing-Pieces Inventory

- [ ] Inventory current Codex CLI and Claude Code connector code paths that can be reused inside a local device agent.
- [ ] Inventory existing ingest paths and decide whether an exporter needs a new device-ingest route or can reuse connector runtime plumbing.
- [ ] Inventory current auth/token machinery from `add-agent-scoped-pdpp-access` and identify what can be reused for device enrollment.
- [ ] Inventory current freshness, run timeline, deployment diagnostics, and scheduler pieces that can display device-agent status.

## 3. Architecture Decisions

- [ ] Decide first experimental topology: pull exporter, push agent, or hybrid.
- [ ] Decide source-instance identity model before implementation.
- [ ] Decide whether device agents emit Collection Profile messages locally, push normalized records directly, or use a new reference-only ingest envelope.
- [ ] Decide credential scope and revocation behavior for device agents.
- [ ] Decide idempotency keys, replay protection, and retry/queue semantics.

## 4. Experimental Slice Planning

- [ ] Choose first source: Codex CLI or Claude Code.
- [ ] Define the smallest owner-visible device enrollment flow.
- [ ] Define the first dashboard diagnostics: enrolled devices, last report, last ingest, records accepted/rejected, stale/unreachable state.
- [ ] Define the first test plan for multi-device collision prevention.
- [ ] Decide whether the implementation belongs under this change or a follow-up implementation change.

## 5. Validation

- [ ] `openspec validate design-local-device-exporter-collection --strict`
- [ ] `openspec validate --all --strict`
