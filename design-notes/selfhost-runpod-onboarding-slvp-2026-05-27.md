# Self-Host Onboarding SLVP (RunPod-Shaped)

Status: decided-promote
Owner: reference implementation owner (selfhosted-runpod-onboarding-slvpi workstream)
Created: 2026-05-27
Updated: 2026-05-27
Related: openspec/changes/add-selfhost-onboarding-slvp (promoted from this note), openspec/changes/add-hosted-mcp-grant-packages (just landed), openspec/changes/add-compose-postgres-proof-service, docs/operator/hosted-mcp-setup.md, .env.docker.example, docker-compose.yml, tmp/workstreams/research-selfhost-prior-art.md, tmp/workstreams/inventory-selfhost.md

## Question

What is the smallest, durable, verifiable lane that lets a friend or r/selfhosted reader spin up their own PDPP reference deployment (RunPodHub is the lighthouse target), configure connections from the dashboard, collect data, and permission Claude or ChatGPT to read it — without conflating PDPP-the-protocol with a hosted service we are offering?

## Context

PDPP is an authorization and disclosure protocol. The reference implementation is forkable and self-hostable; there is no PDPP-the-company offering a multi-tenant hosted backend. The voice/framing guide (`docs/voice-and-framing.md`) is explicit: do not adopt hosted-service semantics. The site at `pdpp.vivid.fish` is a public reference deployment for inspection, not a product end users sign up for.

The user specifically named **RunPodHub** and **in-dashboard configuration**. Today the repository ships:

- Published GHCR images: `ghcr.io/vana-com/pdpp/reference:main`, `ghcr.io/vana-com/pdpp/web:main`.
- `docker-compose.yml` + `.env.docker.example` with ~150 env vars (the operator-configurable surface).
- A working operator console at `/dashboard`, with `/dashboard/deployment` (diagnostics) and `/dashboard/deployment/tokens` (MCP grant package issuance via device-flow OAuth) — the latter just landed in `add-hosted-mcp-grant-packages` (commit d9dd4ee7).
- `/docs/operator/hosted-mcp-setup.md` explaining how to wire Claude or ChatGPT to a deployment's `/mcp` endpoint.

What is missing for the friend / r/selfhosted reader:

- **No self-host quick-start that names the artifacts in one place.** `.env.docker.example` is 13 KB of env vars without a "minimum to boot" reading order. The reference README is reviewer-shaped, not operator-shaped.
- **No deployment-target-specific guidance**, including but not limited to RunPod. There is no statement of what RunPod-the-substrate provides and what it does not (no multi-container compose, no native custom-domain TLS, no UDP, GPU-only global networking).
- **No first-boot config validation.** Today the stack will start with a blank `PDPP_OWNER_PASSWORD` (which leaves protected routes open), no `PDPP_REFERENCE_ORIGIN` consistency check, and no actionable diagnostic when an operator visits the dashboard for the first time and something is misaligned.
- **No path to a RunPod Hub listing** (the `hub.json` + `tests.json` declarative format) — and prior art shows Hub is single-container-only, so we cannot publish today's three-service compose graph directly.
- **Connection / credential configuration remains env-var driven.** This is fine for SLVP; it is not fine to silently ship a dashboard that implies dashboard-configured credentials when none exist.

The full-context refresh (`design-notes/full-context-refresh.md`) names the relevant nouns: `connector_id`, `connection`, `device`, `run`, `schedule`, `coverage`, `grant`. Self-host onboarding touches `device` (the host machine the operator runs PDPP on), `connection` (operator-configured source instances), and `grant` (what an MCP client like Claude or ChatGPT receives). The Core protocol is unchanged by this work; everything proposed here is reference-implementation and operator-surface.

## Stakes

- **Wrong:** ship a "RunPod template" that bundles compose-on-Docker-in-Docker, or that pretends to deliver custom domains / TLS at the RunPod layer, or that disguises PDPP-as-protocol behind a "Sign up for PDPP" wizard. Each of those misframes the project and creates an operator support tail we cannot service.
- **Right:** ship a thin, honest onboarding lane that (a) names the substrate-specific constraints up front, (b) gives the operator a copy-pasteable minimum boot sequence on at least one substrate, (c) provides a first-boot self-check in the dashboard that surfaces the most common misconfigurations, and (d) explains the MCP grant package flow from inside that dashboard.
- **Audience:** r/selfhosted reader, friend who tries this on a RunPod CPU Pod, a Vana engineer evaluating the paradigm, and a future reviewer of how we treat self-host without hosted-service drift.

## Current Leaning

This work splits into four primitives. Only the first two are SLVP-eligible right now; the last two are documented as the natural next steps but explicitly deferred.

### SLVP-eligible

1. **Self-host quick-start doc (`docs/operator/selfhost-quickstart.md`).** Two named lanes:
   - *Lane A — Docker host (laptop, Hetzner, NAS, VPS).* Uses the existing `docker-compose.yml` and `.env.docker.example`. This is the lane that fully exists today.
   - *Lane B — RunPod Pod (CPU template).* Documents the *single-container* shape RunPod requires, how to mount `/workspace` for persistence, how to expose the dashboard port via `*.proxy.runpod.net`, and what RunPod does and does not give you (no UDP, no first-party custom TLS, single container per Hub template).

   For each lane: minimum env vars to set, what to verify in the dashboard, how to wire Claude/ChatGPT via the existing `/mcp` endpoint, how to update, how to back up.

2. **Operator-side deployment self-check (extend `/dashboard/deployment`).** Add a small, structured "self-host readiness" panel that surfaces, with zero new contract surface:
   - whether `PDPP_OWNER_PASSWORD` is set (and whether protected routes are therefore actually protected);
   - whether `PDPP_REFERENCE_ORIGIN` matches the URL the operator is currently viewing the dashboard at (catches the `*.proxy.runpod.net` mismatch class of bug);
   - whether the storage backend reports healthy;
   - whether the embedding cache exists or is downloading;
   - whether the MCP route advertises a refresh-token grant (catches "old reference image" from `hosted-mcp-setup.md` troubleshooting).

   This is **diagnostic surfacing**, not a new control plane. Every value already exists in `/_ref/deployment`; the work is presenting it as a readiness checklist with one-line remediation per row.

### Deferred (named, not implemented)

3. **RunPod Hub `hub.json` + `tests.json`.** Requires a *single-container* image that runs the reference + web + (optional) Postgres in one Pod. This is a new image shape, a new operational surface (process supervision inside one container, single startup script that auto-generates missing secrets), and a Hub release tag cadence. Worth doing, but it is *not* a low-risk landing today and it depends on decisions about whether SQLite-only is the default Hub image (almost certainly yes) and how the embedding cache is preloaded. Tracked as the next OpenSpec change after this one lands.

4. **In-dashboard connector credential management UI.** Today credentials are env-var-driven and that is honest. A dashboard UI that captures, encrypts, and rotates connector credentials is a real and durable contract change — it touches the connector manifest authority model, secret storage, and a Plaid-Link-style UX surface. Worth doing, but it is its own OpenSpec change and it must not get smuggled in under an "onboarding polish" lane.

### Out of scope explicitly

- Custom-domain TLS at the PDPP layer. The proxy URL is fine for SLVP; Cloudflare-in-front is a documented escape hatch in Lane B.
- Multi-Pod / fleet deploy. Single Pod / single host first.
- Backup-restore UI. `pg_dump` + a `/workspace` tarball is documented; UI is later.
- Multi-operator RBAC. Single owner password remains the SLVP model.
- Auto-update / Watchtower. Operator-driven `docker compose pull` only (per Immich's experience — auto-update bit them on DB migrations).

## Promotion Trigger

Promote into OpenSpec because:

- adds new owner-facing operator behavior (the readiness panel) that should be reviewable;
- introduces a new durable doc surface (the quick-start) that the voice/framing guide governs and that we will cite from the public site;
- names a deferred RunPod Hub direction that should be tracked rather than rediscovered.

OpenSpec change: `openspec/changes/add-selfhost-onboarding-slvp/`.

The deferred items (3, 4 above) are *not* part of this change. They are tracked in this note's Decision Log as "next slice."

## Decision Log

- 2026-05-27: Captured this note after two parallel research lanes (`tmp/workstreams/research-selfhost-prior-art.md` and `tmp/workstreams/inventory-selfhost.md`). The single most load-bearing fact: **RunPod Hub is single-container only**, so the SLVP cannot promise a Hub one-click deploy of today's compose stack. Lane A (Docker host) is fully ready today; Lane B (RunPod Pod) is reachable today by setting one host port and using the existing compose stack on a single Pod via SSH/Web Terminal, even before a Hub template exists.
- 2026-05-27: Decided to promote to `add-selfhost-onboarding-slvp` rather than fattening any existing change. The MCP grant package work (`add-hosted-mcp-grant-packages`) is the in-product half of the onboarding; this change is the operator-substrate half.
- 2026-05-27: Decided to ship the dashboard readiness panel as part of this change rather than deferring it. Rationale: the most common "friend spins this up and it doesn't work" failure modes (owner password unset, reference origin mismatch, embedding cache still downloading) are diagnostic-only, and we already collect each value in `/_ref/deployment`. The risk of leaving them invisible is higher than the risk of one more dashboard view.
- 2026-05-27: Deferred RunPod Hub template (item 3) and in-dashboard credential UI (item 4) as separate OpenSpec changes. Naming both here so the next worker does not re-derive that they are out of scope.
