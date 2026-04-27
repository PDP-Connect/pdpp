# Reference Quality Closeout Plan

Status: decided-promote
Owner: owner agent
Created: 2026-04-26
Updated: 2026-04-26
Related: `add-reference-web-dark-mode`, `add-mock-reference-demo-instance`, `design-host-browser-bridge-for-docker`, `design-local-device-exporter-collection`, `add-agent-scoped-pdpp-access`, `polish-reference-api-discovery-seams`, `polish-assistant-query-api-discovery`

## Question

What remains before the PDPP reference can be shown internally as a serious protocol/reference implementation rather than a pile of useful prototypes?

## Context

Several implementation lanes landed quickly: dark mode, Docker packaging, host-browser bridge design and first implementation, mock sandbox, retrieval/search improvements, connector schema validation, refresh scheduling, and agent-scoped access. The velocity was useful, but it also created a risk: implementation details can drift from PDPP's purpose and from the discipline expected of a normative protocol reference.

Six read-only Claude audit lanes were run on 2026-04-26:

- Modern Next/React/Vercel implementation audit.
- Workaround and OpenSpec reconciliation audit.
- Runtime UX, mobile, Docker, and browser-connector audit.
- Sandbox/live-dashboard parity audit.
- Connector and Docker support matrix audit.
- Assistant API capability gap audit.

This note is the owner synthesis of those audits. It is not itself a task dump and does not supersede the linked OpenSpec changes.

## Stakes

- PDPP is a protocol with a reference implementation. The public and internal surfaces must not imply stronger protocol maturity, connector support, Docker support, or demo parity than the implementation actually has.
- The dashboard is an operator surface. It should be reliable, mobile-usable, dark-mode-safe, and clear about deployment constraints.
- The sandbox should demonstrate the real reference shape with deterministic mock AS/RS data, not a forked tutorial shell that drifts from production UI.
- Assistants should be able to discover, request, and use scoped PDPP access without owner tokens or guesswork.
- Workarounds are acceptable only when named, scoped, and given an exit condition.

## Current Leaning

Treat the remaining work as five tranches, in this order:

1. **Correctness and operational safety.** Fix or explicitly track process crashes (`EPIPE`), owner-auth misconfiguration loops, proxy/header leakage, server-only token caching, and standalone manifest tracing. These are higher priority than visual polish because they affect trust.
2. **Reference web best-practice closeout.** Remove React module-global state, classify `force-dynamic` usage, add loading/error boundaries, standardize polling, and make the landing surface server-rendered except for genuinely interactive leaves.
3. **Sandbox/live parity.** Make `/sandbox/**` use the same shared view components as `/dashboard/**` wherever possible. The demo should be the real dashboard with a mock data source, not a lookalike.
4. **Docker connector honesty.** Surface browser-bridge and filesystem-mount posture in deployment diagnostics and connector rows. Do not silently present scaffolded, blocked, deprecated, or Docker-impossible connectors as supported.
5. **Assistant API follow-through.** Keep shipped discovery/search/schema/blobs/hybrid retrieval coherent, promote completed changes, and design but do not rush webhook/freshness semantics.

## Promotion Trigger

Promote individual items from this note into OpenSpec before implementation when they change a protocol surface, durable reference contract, architecture boundary, security posture, storage model, or multi-step implementation tranche.

Immediate promotion candidates:

- `reference-runtime-reliability` for `EPIPE` handling and process-supervision guarantees.
- `reference-web-hardening` for owner-session/proxy/token-cache/standalone tracing semantics.
- `sandbox-live-parity-closeout` for the one-dashboard/two-data-sources contract.
- `connector-support-posture` for manifest/UI fields such as verification status, Docker support class, required host paths, required external binaries, upstream-deprecated status, and observed interaction kinds.
- `client-events-and-freshness` after prior-art research, not before.

## Execution Lanes

### Lane A: Immediate No-Spec Cleanup

- Replace remaining double-casts in `apps/web/src/lib/seed-data.ts` with honest nullable types.
- Replace remaining client module-global UI control state, starting with the command palette.
- Remove dead dependencies only after confirming no generated/imported route uses them.
- Add or keep guard tests for every anti-pattern previously rejected: raw theme scripts, `dangerouslySetInnerHTML` theme bootstrap, hydration suppression, and mutable module-level UI state.

### Lane B: Web And Security Hardening

- Revisit `apps/web/src/app/dashboard/lib/owner-token.ts` so per-request owner state is not cached in module globals.
- Audit `apps/web/src/proxy.ts` for cookie/header forwarding to internal AS/RS rewrites and make header policy explicit.
- Decide whether raw App Router API bridge routes should exist; if they remain, remove token-in-URL patterns and align them with owner-session forwarding.
- Verify `output: "standalone"` traces manifest files used by the dashboard. If not, move manifest sourcing to a traceable import/build artifact.
- Add route-level loading/error boundaries for dashboard and sandbox surfaces.

### Lane C: Sandbox And Demo

- Refactor live dashboard overview, records, grants, runs, traces, deployment, schedules, and search pages to consume the same shared view components used by sandbox pages.
- Keep live-only mutations as injected actions/slots, not separate forks.
- Fix sandbox clock semantics so "stale" and "last 24h" reflect the deterministic demo clock rather than wall-clock time.
- Add URL-level smoke tests for `/sandbox/.well-known/**`, `/sandbox/_ref/**`, and `/sandbox/v1/**`.

### Lane D: Docker Connector Support

- Complete the manual host-browser bridge proof with ChatGPT in Docker.
- Show bridge configuration/reachability and daily-Chrome opt-in state on `/dashboard/deployment`.
- Show connector support posture in `/dashboard/records`: token-only, browser bridge required, host filesystem required, external binary required, scaffolded, blocked upstream, or deprecated.
- Encode posture in durable manifests/spec only after OpenSpec review.
- Treat Spotify/Pocket and scaffolded browser connectors honestly in UI and docs.

### Lane E: Assistant API And Agent Access

- Promote completed discovery, schema, hybrid retrieval, expand, blob, and refresh changes once owner-reviewed.
- Keep `/_ref/**` as operator-only; do not blur it into the public assistant API.
- Finish the agent-scoped CLI/skill loop, especially consent polling and broad-access UI tests.
- Open a dedicated OpenSpec change before adding `connector_id` search filters, `sum/min/max group_by`, webhook subscriptions, event payloads, freshness guarantees, or client-triggered refresh.

## Decision Log

- 2026-04-26: Captured owner synthesis from six read-only Claude audits. Immediate implementation should continue through bounded Claude Code lanes with owner review before merge.
