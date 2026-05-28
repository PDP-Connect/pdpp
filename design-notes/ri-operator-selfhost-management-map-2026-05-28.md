# RI Operator/Self-Host Management Map

Status: captured
Owner: reference implementation owner (ri-operator-selfhost-management-map workstream)
Created: 2026-05-28
Updated: 2026-05-28
Related: openspec/changes/add-selfhost-onboarding-slvp, openspec/changes/dcr-per-owner-token-with-revoke, openspec/changes/define-schedule-manual-attention-policy, openspec/changes/wire-reference-scheduler-loop, openspec/changes/polish-dashboard-auth-pwa-ux, openspec/changes/split-public-site-and-operator-console, openspec/changes/unify-pdpp-cli-command-surface, openspec/changes/expose-connection-identity-on-public-read, docs/operator/selfhost-quickstart.md, docs/operator/hosted-mcp-setup.md, docs/operator/event-subscriptions.md, docs/operator/local-collector-runbook.md, design-notes/selfhost-runpod-onboarding-slvp-2026-05-27.md, design-notes/full-context-refresh.md

## Question

What is the current end-to-end management surface a technically capable operator must traverse to spin up a fresh PDPP reference deployment (laptop, VPS, or RunPod-style host), configure it, connect sources, collect data, and grant scoped access to Claude or ChatGPT — and where are the remaining gaps between today's capabilities and that journey being auditable and high-confidence without repo spelunking?

This is a survey/synthesis note, not a fresh design. The purpose is to draw a single capability map so future workstreams stop re-discovering the same gaps and so already-active OpenSpec changes can be triaged on dependency rather than arrival order.

## Context

PDPP-as-protocol is the headline; the reference implementation, Collection Profile, polyfill connectors, and operator console are downstream surfaces (`docs/voice-and-framing.md`). Within the reference implementation, the canonical nouns for management work are `connector_id`, `connection`, `device`, `run`, `schedule`, `coverage`, `grant` (`design-notes/full-context-refresh.md`).

The journey the user named for this lane is:

1. fresh-host **spin-up** (Docker host or RunPod-style substrate);
2. instance **configuration** (owner gate, reference origin, embedding cache, optional Web Push, Postgres);
3. **source connection** (credential entry, enrollment, polyfill bindings, browser sessions);
4. **collection** (schedules, runs, attention, coverage, freshness);
5. **scoped grant** to Claude/ChatGPT (hosted MCP via DCR + OAuth) or trusted local agent (operator-token via `/dashboard/deployment/tokens`).

### Surface inventory observed today

Operator-facing docs under `docs/operator/`:

- `selfhost-quickstart.md` — Lane A (Docker host) and Lane B (RunPod CPU Pod).
- `hosted-mcp-setup.md` — wiring Claude/ChatGPT to `/mcp` and minting trusted-local-agent owner tokens.
- `event-subscriptions.md` — operator console read-only surface + bundled `scripts/event-subscription-test-receiver.mjs`.
- `local-collector-runbook.md` — Claude Code / Codex enrollment, ingest, doctor, coverage.

Operator console pages under `apps/console/src/app/dashboard/**` (post `split-public-site-and-operator-console`; `apps/web/src/app/dashboard/**` is the pre-split mirror still in tree):

- `/dashboard` — overview, attention, recent activity, Web Push settings.
- `/dashboard/deployment` — `DeploymentReadinessPanel` + `DeploymentDiagnosticsView` (warnings, runtime capabilities, lexical/semantic index, participation, manifests, database, environment) + `ConnectAgentCard`.
- `/dashboard/deployment/tokens` — operator owner-bearer issuance via in-browser device flow, list + revoke (`dcr-per-owner-token-with-revoke`).
- `/dashboard/device-exporters` — local-collector enrollment codes + enrolled device diagnostics.
- `/dashboard/event-subscriptions` — read-only list + peek + disable.
- `/dashboard/grants/**` — grants list, packages, bootstrap, request flow, per-grant view.
- `/dashboard/records/**`, `/dashboard/explore`, `/dashboard/search`, `/dashboard/stream-playground` — data inspection.
- `/dashboard/schedules`, `/dashboard/runs/**`, `/dashboard/traces/**` — collection lifecycle inspection.

`/_ref/*` operator routes (41 advertised in `reference-implementation/docs/generated/reference-ref-routes.md` plus additional surfaces in `reference-implementation/server/index.js` for grants, runs, dataset projections, source webhooks, device exporters, clients, schedules, web push, event subscriptions, run interaction streams, deployment, search, records timeline, retained-size, version stats).

CLI (`packages/cli`, `pdpp`):

- `pdpp connect <provider-url>` — public delegated-access cache.
- `pdpp token <provider-url>` — emit cached bearer.
- `pdpp collector advertise|enroll|run` — thin shim for `@pdpp/local-collector@beta`.
- `pdpp ref login`, `pdpp ref run|grant|trace|connectors|event-subscriptions` — operator diagnostics requiring an owner session.

Compose stack: `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.neko.yml`, `.env.docker.example` (~290 lines), named volumes `pdpp-transformers`, `pdpp-home`, `pdpp-postgres-data`.

## Stakes

- **If we under-build management UI**, every new operator has to read `.env.docker.example` (290 lines), audit `/_ref/*` routes, and intuit which dashboard pages are read-only versus mutation. That is a steep filter for "friend or r/selfhosted reader" and contradicts the reference's job of proving the paradigm is operable.
- **If we over-build management UI**, we smuggle durable contract changes (credential vaulting, connection mutation, attention triage) under an "onboarding polish" lane and re-litigate Core/Collection/reference boundaries. The voice/framing guide and the full-context refresh both push back on this.
- **If we ignore the journey holistically**, we will keep solving sub-problems (readiness panel, tokens page, device-exporters page, schedules wired into a loop, hosted MCP DCR, ref-read auth gate) without ever closing the cognitive loop "I shipped a new instance and I am ready to share it with Claude."

## Current Leaning

The capability map breaks into six lanes. For each lane the table below states **what exists**, **the durable next gap** (with the OpenSpec change that already owns it, if any), and **what is intentionally deferred** (so future workers do not re-derive it).

### Lane 1 — Substrate spin-up

| What exists today | Durable next gap | Owned by | Deferred |
|---|---|---|---|
| `selfhost-quickstart.md` Lane A (Docker host) end-to-end; Lane B (RunPod CPU Pod) documented but unverified | RunPod Hub `hub.json` + `tests.json` single-container template; this requires a process-supervised image and a release cadence | `selfhost-runpod-onboarding-slvp-2026-05-27.md` decision log (next slice after `add-selfhost-onboarding-slvp`) | Custom-domain TLS at the PDPP layer; multi-Pod fleet; auto-update; multi-operator RBAC |
| Compose graph with three services (`reference`, `web`, optional `postgres`), named volumes for transformer cache, runtime state, and Postgres data | Cohesive "lane B verified once" residual — owner-only live verify recorded as risk in `add-selfhost-onboarding-slvp` | `add-selfhost-onboarding-slvp` residual risks | Single-container image; `pdpp init` CLI |

**Verdict.** Substrate spin-up is the closest to closure: `add-selfhost-onboarding-slvp` is implemented and validated, with the only open work being an owner-only Lane B live walk-through and the deferred Hub template. No additional implementation lane is needed here in the short term unless an owner explicitly funds the Hub template.

### Lane 2 — Instance configuration

| What exists today | Durable next gap | Owned by | Deferred |
|---|---|---|---|
| `.env.docker.example` (~290 lines) covers owner password, reference origin, embedding cache, Web Push VAPID keys, Postgres opt-in, ~30 connector credentials, n.eko/TURN, host browser bridge | First-boot **structured** misconfiguration surfacing in dashboard: `DeploymentReadinessPanel` covers owner password, reference origin, storage health, embedding cache, MCP refresh-token. No row yet for Web Push VAPID, n.eko allocator policy, Postgres backend, host browser bridge, or `PDPP_TRUSTED_HOSTS` | `add-selfhost-onboarding-slvp` (locked at five rows for SLVP) | In-dashboard env edit/reload, server-side env vault, secret rotation |
| `/_ref/deployment` carries warnings, runtime capabilities, lexical/semantic index, participation, manifests, database, environment | A documented "what each row means and what to do about it" reference for operators — currently the dashboard view is honest but expects the reader to know `building_index` vs `stale_index` | none yet | — |

**Verdict.** A second readiness-panel slice (beyond the SLVP five rows) is reasonable but bounded. Recommended structure: an explicitly numbered "Tier 2" set of optional checks (Web Push configured, n.eko allocator policy, Postgres runtime backend, host browser bridge advertised, `PDPP_TRUSTED_HOSTS` aligned), still read-only against existing `/_ref/deployment` data — no new owner control plane.

### Lane 3 — Source connection / credentials

| What exists today | Durable next gap | Owned by | Deferred |
|---|---|---|---|
| Connector credentials are env-var driven in `.env.docker.example` | **In-dashboard credential management UI** (Plaid-Link-style flow) is the named next OpenSpec change; not yet drafted | `selfhost-runpod-onboarding-slvp-2026-05-27.md` decision log; `add-selfhost-onboarding-slvp/design.md` non-goals | — |
| Device-exporter enrollment exists for local collectors (`/dashboard/device-exporters`, `@pdpp/local-collector@beta`) | Honest "what each connection currently needs from the operator" view: today the dashboard does not synthesize "Gmail wants `GMAIL_APP_PASSWORD`; you have set it; the connector is `proven_working`" across env + manifest + coverage state | partial: `complete-ri-operator-console-reliability` (archived) defined the connection-as-projection model, but the user-visible "what configuration is missing for this connector?" rollup is not yet wired in the live console | — |
| Public-read contract is gaining a `connection_id` + owner-editable `display_name` dimension | `expose-connection-identity-on-public-read` is active — needs to land before any operator UI promises connection-keyed semantics in consent or read flow | `expose-connection-identity-on-public-read` | — |

**Verdict.** This is the largest open lane. Credential-vault work is a real durable contract change (manifest authority, secret storage, rotation policy) and should be drafted as its own OpenSpec change rather than smuggled. The smaller, separable subslice is the **per-connector configuration-readiness rollup** (read-only synthesis of env + manifest + coverage + binding state) that the dashboard could honestly surface today without touching credential storage.

### Lane 4 — Collection: schedules, runs, attention, coverage

| What exists today | Durable next gap | Owned by | Deferred |
|---|---|---|---|
| `/_ref/connectors/<id>/run`, `/_ref/connectors/<id>/schedule` (PUT/pause/resume/DELETE), per-`connector_instance_id` variants; `/dashboard/schedules` and `/dashboard/runs` | Scheduler **loop** is currently wired only in some startup paths | `wire-reference-scheduler-loop` (active) | — |
| `define-schedule-manual-attention-policy` defines schedule + attention semantics as a design-only change | Implementation tranche: durable `attention_request` contract, notification fanout, per-connection suppression, safe resume | `define-schedule-manual-attention-policy`; `add-run-automation-policy-model`; `define-run-assistance-state-contract` | — |
| `/_ref/runs/<run_id>/interaction` and `run-interaction-streams` surface run-assistance state | `define-run-assistance-state-contract` separates progress posture, owner action, response obligation, attachments, sensitivity, durability | `define-run-assistance-state-contract` | — |

**Verdict.** Schedules/runs/attention is the lane that already has the most active OpenSpec changes. The cognitive-load reduction here is **not another design proposal**; it is making sure the existing `wire-reference-scheduler-loop` + `define-schedule-manual-attention-policy` + `add-run-automation-policy-model` + `define-run-assistance-state-contract` proposals get implemented in dependency order rather than as parallel partial slices. Recommend the owner triages those as a single tranche before any new design.

### Lane 5 — Scoped-grant issuance to MCP clients

| What exists today | Durable next gap | Owned by | Deferred |
|---|---|---|---|
| `/mcp` accepts OAuth scoped-grant tokens (RFC 7591 DCR + PKCE + refresh_token); `hosted-mcp-setup.md` documents the ChatGPT/Claude wiring; refresh-token advertisement check in `DeploymentReadinessPanel` | None blocking the SLVP. Coverage of grant lifecycle (approve, revoke, grant package operator visibility) was closed by `add-hosted-mcp-grant-packages` and `add-grant-package-operator-visibility` (archived) | — | — |
| Operator-token path via `/dashboard/deployment/tokens` (per-token DCR, RFC 7592 revoke, named clients) | `dcr-per-owner-token-with-revoke` is active and tracks the per-token DCR + list + revoke flow | `dcr-per-owner-token-with-revoke` | — |
| Owner-bearer vs MCP scoped-grant boundary documented in console copy and `hosted-mcp-setup.md` "Trusted local agents" section | — | — | — |

**Verdict.** Lane 5 is the closest to "shipped." The only durable open item is `dcr-per-owner-token-with-revoke`. No new design lane is recommended.

### Lane 6 — Auth posture and ref-read gating

| What exists today | Durable next gap | Owned by | Deferred |
|---|---|---|---|
| `harden-reference-auth-surfaces` (active) redacts `token_id` from timeline reads, gates `POST /grants/<id>/revoke`, sets clickjacking headers, replaces personal subject-id default | Same proposal — ship it | `harden-reference-auth-surfaces` | Hashing/removing `token_id` from `spine_events` storage; consent exchange codes; broader `_ref/*` read gating |
| `gate-ref-reads-when-owner-auth-enabled` (active) gates `_ref/*` reads when `PDPP_OWNER_PASSWORD` is set | Same proposal — ship it; reconciles CLI/test header plumbing | `gate-ref-reads-when-owner-auth-enabled` | — |
| `polish-dashboard-auth-pwa-ux` extends owner-session lifetime to 7d, adds dark mode, validates PWA + Web Push metadata | Same proposal — ship it | `polish-dashboard-auth-pwa-ux` | — |
| `honor-csrf-exemption-for-bff-device-flow` (active) | Ship it | `honor-csrf-exemption-for-bff-device-flow` | — |

**Verdict.** Lane 6 is a "ship the queue" lane, not a "design more" lane. These four active changes plus `dcr-per-owner-token-with-revoke` are the security/posture stack and should be triaged ahead of any new readiness-panel rows.

## Cross-lane observations

1. **The repo's standing constraint is healthy: management UI must not silently invent durable contract.** Both `add-selfhost-onboarding-slvp/design.md` and the RunPod design note explicitly reject readiness-panel features that would introduce a new control plane (env edit, password reset, credential vault). The capability map should preserve that — every new dashboard row should be a presentation of existing diagnostic state until a discrete OpenSpec change authorizes a new mutation.

2. **The `connection` noun is still settling on the public read contract.** `expose-connection-identity-on-public-read` is the load-bearing active change. Operator UI that wants to surface per-connection status, label, or rollup should not race ahead of that change — the contract semantics (fan-in vs. ambiguous-connection error, owner-editable `display_name`, consent-card label defaults) are owned there.

3. **The split into `apps/console` vs `apps/web` is in progress.** `split-public-site-and-operator-console` is the authoritative active change; until it closes there are two parallel `/dashboard` trees. New management work should land in `apps/console` (the operator console), not in `apps/web`, to avoid extending the split.

4. **The `pdpp ref ...` CLI namespace exists but lacks symmetry with `_ref/*` mutations.** `unify-pdpp-cli-command-surface` defines the durable boundary, but at the implementation level `pdpp ref` covers reads + `event-subscriptions disable`; it does not yet cover schedule pause/resume/delete, connector run, connection display-name patch, or device-exporter revoke. A bounded follow-up could extend the CLI's mutation coverage symmetrically with `_ref/*` — but it is **not** required for the spin-up-to-scoped-grant journey, since the dashboard already covers those. Listed here for completeness only.

5. **A clean operator console "what do I need to do next?" surface is still missing.** The closest things today are `/dashboard` (overview) and `/dashboard/deployment` (readiness panel + diagnostics). Neither composes the cross-lane operator state ("readiness OK + at least one connection enrolled + at least one collected stream + at least one issued MCP grant or operator token") into a single "ready-to-share" verdict. This is a candidate for a bounded Tier-2 readiness slice — see recommendations below.

## Recommended next implementation lanes

These are recommendations to the owner, not new design proposals. Each one names a lane, the active OpenSpec change it threads (if any), and the rough size.

1. **Ship the active security/posture queue in dependency order** (S, no new design):
   - `harden-reference-auth-surfaces` →
   - `gate-ref-reads-when-owner-auth-enabled` →
   - `honor-csrf-exemption-for-bff-device-flow` →
   - `polish-dashboard-auth-pwa-ux` →
   - `dcr-per-owner-token-with-revoke`.

   These all change owner-facing posture or the operator-token surface. Landing them in this order avoids re-doing CLI/test header plumbing twice.

2. **Land `expose-connection-identity-on-public-read`** (M, active change) before any operator UI that surfaces per-connection labels or rollups. This unblocks Lane 3 read-side and Lane 4 attention-state copy.

3. **Triage and tranche the collection-policy stack as one tranche, not four parallel slices**: `wire-reference-scheduler-loop` (loop wiring), `add-run-automation-policy-model` (automation modes), `define-schedule-manual-attention-policy` (attention contract), `define-run-assistance-state-contract` (assistance shape). All four are active. The owner should pick one driver change and let the others sequence behind it instead of each shipping a partial slice.

4. **(Optional bounded slice) Deployment readiness Tier 2** (S–M, no current OpenSpec change). A read-only follow-up to `DeploymentReadinessPanel` adding rows for Web Push VAPID configuration, n.eko allocator policy and surface mode, Postgres runtime backend, host browser bridge advertisement, and `PDPP_TRUSTED_HOSTS` alignment — each row derives from existing `/_ref/deployment` data, with no new control plane. Would need its own small OpenSpec change to lock the new row contract.

5. **(Optional design lane, do not implement here) In-dashboard connector configuration-readiness rollup** (M, needs design note → OpenSpec). The synthesis of env + manifest + coverage + binding state per connector, surfacing "what does this connection still need from me?" The expected promotion trigger is "first owner-facing readout that crosses env, manifest, and coverage in one row," which is past the `decided-promote` bar. Recommend draft as a design note before any implementation lane. **Out of scope for this workstream.**

6. **(Optional design lane, do not implement here) Connector credential management UI** (L, needs OpenSpec change). This is the named "next slice" in `selfhost-runpod-onboarding-slvp-2026-05-27.md`. It is a real durable contract change touching manifest authority and secret storage. Recommend draft as its own OpenSpec change. **Out of scope for this workstream.**

## Promotion Trigger

This note should be promoted into OpenSpec only if the owner decides to act on recommendation 4 (Tier-2 readiness rows), 5 (configuration-readiness rollup), or 6 (credential management). Recommendations 1–3 are existing active changes; they need triage and implementation, not a new spec.

If recommendation 4 is taken, the natural shape is a follow-up amendment to `add-selfhost-onboarding-slvp` (after it archives) or a sibling `add-selfhost-onboarding-tier-2-readiness` change.

## Decision Log

- 2026-05-28: Captured this note after auditing the docs, operator console, CLI, `/_ref/*` route generation, and the 80-odd active + archived OpenSpec changes touching self-host onboarding, dashboard, hosted MCP, schedules, attention, runs, auth, and connection identity. Conclusion: this workstream does **not** need to add a new OpenSpec change. The capability map shows the gaps are already owned by active proposals; the cognitive-load reduction is to triage and ship those in dependency order, not to mint more specs. Two optional new design lanes (Tier-2 readiness, configuration-readiness rollup) are identified for the owner to consider, but neither is implemented in this workstream.
