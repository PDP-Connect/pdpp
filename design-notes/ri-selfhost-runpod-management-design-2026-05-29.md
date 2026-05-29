# RI Self-Host and RunPod Management Design

Status: decided
Owner: reference implementation owner (ri-selfhost-runpod-management-design workstream)
Created: 2026-05-29
Updated: 2026-05-29
Related:
  design-notes/selfhost-runpod-onboarding-slvp-2026-05-27.md,
  design-notes/ri-selfhost-operator-setup-intake-2026-05-28.md,
  design-notes/ri-operator-selfhost-management-map-2026-05-28.md,
  design-notes/full-context-refresh.md,
  docs/voice-and-framing.md,
  docs/operator/selfhost-quickstart.md,
  docs/operator/hosted-mcp-setup.md,
  openspec/changes/add-selfhost-onboarding-slvp,
  openspec/changes/harden-reference-auth-surfaces,
  openspec/changes/gate-ref-reads-when-owner-auth-enabled,
  openspec/changes/honor-csrf-exemption-for-bff-device-flow,
  openspec/changes/polish-dashboard-auth-pwa-ux,
  openspec/changes/dcr-per-owner-token-with-revoke,
  openspec/changes/expose-connection-identity-on-public-read,
  openspec/changes/wire-reference-scheduler-loop,
  openspec/changes/define-schedule-manual-attention-policy,
  openspec/changes/split-public-site-and-operator-console

## Purpose

This note is the integration-level design document for making the PDPP reference
implementation easy to self-host, configure, and share with Claude/ChatGPT. It synthesizes
three prior companion notes (SLVP decision, prior-art intake, management-map survey) into a
single artifact that:

1. Defines the essential nouns and surface boundaries.
2. Maps the owner management surfaces (UI, CLI, API) against those boundaries.
3. Identifies what is deployment assembly vs. what is protocol semantics.
4. Produces a phased SLVP implementation plan with explicit acceptance checks.
5. Records risks, tradeoffs, and the evidence base behind each decision.

This note does not re-cover the companion notes' ground in full. Read them first if you need
the prior-art survey or the granular six-lane capability map. This note answers the design
question: "given everything we know, what exactly should we build, in what order, and how do
we know when it is done?"

## Problem

A technically capable person—a friend, an r/selfhosted reader—should be able to:

1. Stand up their own PDPP reference deployment on a Docker host, VPS, or RunPod CPU Pod.
2. Configure required secrets and environment, verify the instance is healthy.
3. Connect one or more data sources (Gmail, Claude Code, etc.) and collect initial data.
4. Grant Claude or ChatGPT scoped MCP access to that data.

Today the quickstart doc (`docs/operator/selfhost-quickstart.md`) covers steps 1–2 procedurally, but the experience has three classes of friction:

- **Missing secret generation.** `PDPP_OWNER_PASSWORD`, `SESSION_SECRET`, and VAPID keys must be set manually. Supabase, n8n, and every major 2026 self-hosted app ship a `generate-secrets.sh`; PDPP does not.
- **Security/auth queue not shipped.** Five active OpenSpec changes (auth hardening, ref-read gate, CSRF fix, PWA session, per-token DCR) are all implemented but not closed. Collectively they protect the owner posture.
- **No ongoing-operations surface.** The scheduler loop is not fully wired; there is no attention surface. An operator who deploys, connects a source, and walks away has no signal when their collection run needs human action.

## Scope Contract

This design is explicitly scoped to the **reference implementation operator experience**. It does not touch:

- PDPP Core protocol semantics or wire formats.
- Collection Profile normative requirements.
- Hosted service onboarding. PDPP has no hosted service; every instance is operator-run.
- Multi-tenant RBAC, auto-update, Kubernetes, or SaaS semantics.

Deployment tooling (Docker, Compose, RunPod, Cloudflare Tunnel) is **assembly**, not protocol. A change to Compose does not require an OpenSpec capability update unless it changes a durable wire format, endpoint contract, or grant shape. The test: "if someone forks and rewrites this in a different stack, do they have to implement this?" If yes, it is protocol. If no, it is assembly.

## Essential Nouns

Within the management surface, the load-bearing nouns are:

| Noun | Definition | Surface layer |
|---|---|---|
| **connection** | An owner-configured concrete data source: one account, one device, one profile. E.g. "Gmail account A", "peregrine Claude Code". Public contract noun (`connection_id`, `display_name`). | Public read contract (via `expose-connection-identity-on-public-read`) |
| **run** | A bounded collection execution against one connection, producing normalized records. Has a lifecycle: queued → active → completed/failed/needs-attention. | Collection Profile + operator console |
| **schedule** | An owner-configured recurring run policy per connection. Has an attention state when a run requires human action. | Collection Profile + operator console |
| **grant** | An owner-issued scoped authorization for an MCP client (Claude, ChatGPT) or trusted agent to read records under defined constraints. | PDPP Core (OAuth + RAR) |
| **owner token** | A bearer token issued via the dashboard device flow that grants an AI agent owner-level access (not a user grant — a local-trust shortcut). Not a grant in the protocol sense. | Reference implementation operator console |
| **deployment** | The running instance: its origin, owner auth gate, storage health, embedding cache, MCP advertised endpoints. Read-only diagnostic surface. | Reference implementation operator console |
| **connection readiness** | A per-connection synthesis of env vars set + manifest requirements + coverage state. Answers "what does this connection still need from me?" | Planned: needs design note → OpenSpec |

`connector_instance_id` (internal storage column) is not an operator noun. `connection` and `connection_id` are the public-facing names (`expose-connection-identity-on-public-read`).

## Owner Management Surfaces

### UI (operator console at `/dashboard/**`)

| Route | What it does | Mutation | Status |
|---|---|---|---|
| `/dashboard` | Overview: attention requests, recent run activity, Web Push settings | none | Implemented |
| `/dashboard/deployment` | Deployment readiness panel (5 rows) + diagnostics view (capabilities, index, env) | none | Implemented |
| `/dashboard/deployment/tokens` | List, issue, revoke owner bearer tokens via device flow | issue / revoke | Active (`dcr-per-owner-token-with-revoke`) |
| `/dashboard/device-exporters` | Enroll local collectors (Claude Code, Codex), view enrolled devices | enroll / revoke | Implemented |
| `/dashboard/event-subscriptions` | List and disable webhook subscriptions | disable | Implemented |
| `/dashboard/grants/**` | View, bootstrap, approve, revoke scoped grants to MCP clients | approve / revoke | Implemented |
| `/dashboard/schedules` | View and manage collection schedules per connection | pause / resume | Implemented (loop wiring: active) |
| `/dashboard/runs/**` | View run traces, attention requests, interaction history | acknowledge | Active (attention contract: active) |
| `/dashboard/explore`, `/dashboard/search` | Browse collected records by stream, query semantically | none | Implemented |

**Tier-2 readiness rows (optional follow-up, not in this tranche):** Web Push VAPID configuration, n.eko allocator policy, Postgres runtime backend, host browser bridge advertisement, `PDPP_TRUSTED_HOSTS` alignment. All derive from existing `/_ref/deployment` data; no new control plane required.

**Connection readiness rollup (deferred):** Per-connection synthesis of env + manifest + coverage. Largest mid-term management gap. Requires its own design note → OpenSpec.

### CLI (`pdpp ref ...`)

The `pdpp ref` command namespace provides operator diagnostics and a bounded set of mutations. It is not a replacement for the console; it is a power-user escape hatch.

| Command | Surface | Status |
|---|---|---|
| `pdpp ref login` | Auth: owner session via owner token | Implemented |
| `pdpp ref connectors` | List connectors + status | Implemented |
| `pdpp ref run <connector>` | Trigger a run | Implemented |
| `pdpp ref grant` | List grants | Implemented |
| `pdpp ref trace` | View run traces | Implemented |
| `pdpp ref event-subscriptions` | List + disable subscriptions | Implemented |

Missing symmetry (not blocking the spin-up-to-grant journey): schedule pause/resume/delete, connection display-name patch, device-exporter revoke. These are a bounded follow-up under `unify-pdpp-cli-command-surface`, not required for this design.

### API (`/_ref/*`)

The operator control-plane API is documented in `reference-implementation/docs/generated/reference-ref-routes.md` (41 advertised routes) plus additional surfaces in `index.js`. Key surfaces:

- `/_ref/deployment` — deployment diagnostics (read-only JSON).
- `/_ref/connectors/<id>/run` — trigger a collection run.
- `/_ref/connectors/<id>/schedule` — create, pause, resume, delete a schedule.
- `/_ref/grants/**` — grant lifecycle management.
- `/_ref/owner/tokens` — token issuance + revoke (via `dcr-per-owner-token-with-revoke`).
- `/_ref/runs/<run_id>/interaction` — run interaction streams.

The `/_ref/*` namespace is owner-authenticated when `PDPP_OWNER_PASSWORD` is set. `gate-ref-reads-when-owner-auth-enabled` closes the read-side auth gate.

## Deployment Modes

### Lane A — Docker host (laptop, NAS, VPS)

Target: operator with a Linux or macOS machine capable of running Docker Compose.

Flow:
1. Clone repo or download `docker-compose.yml` + `.env.docker.example`.
2. Run `scripts/generate-secrets.sh` — auto-generates `PDPP_OWNER_PASSWORD`, `SESSION_SECRET`, VAPID keys.
3. Set `PDPP_REFERENCE_ORIGIN` (public HTTPS URL for this instance).
4. Optionally add `cloudflared` service for "no domain, no open ports" HTTPS (see below).
5. `docker compose up -d`.
6. Visit `/dashboard/deployment` — readiness panel confirms green.
7. Wire Claude/ChatGPT via `hosted-mcp-setup.md`.

**"No domain, no open ports" path (Cloudflare Tunnel):** Add one Compose service and one env var (tunnel token from the Cloudflare dashboard). The tunnel provides a stable `*.trycloudflare.com` HTTPS URL and ensures `PDPP_REFERENCE_ORIGIN` is set consistently before first boot. This is a doc addition to `selfhost-quickstart.md`, not an implementation change.

### Lane B — RunPod CPU Pod

Target: operator who wants a cloud instance without managing a host machine.

Flow:
1. Create a RunPod CPU Pod with the `pdpp-reference` template (or bootstrap manually via web terminal).
2. Instance is reachable at `*.proxy.runpod.net` — this becomes `PDPP_REFERENCE_ORIGIN`.
3. Run `scripts/generate-secrets.sh` in the web terminal.
4. Restart the container with updated env.
5. Visit `/dashboard/deployment` — readiness panel confirms green.

**RunPod Hub vs Pod template:** RunPod Hub is a serverless worker platform. PDPP is a persistent service; Hub is the wrong target. The deferred "RunPod Hub template" from prior notes should be renamed: the correct artifact is a **RunPod Pod template with a `pdpp-all-in-one` single-container image** (process supervision, auto-generates missing secrets on startup, SQLite default). This requires a new image shape and release cadence; it remains deferred.

### What is explicitly not protocol

| Item | Why it is assembly, not protocol |
|---|---|
| `docker-compose.yml` service graph | Runtime topology; a fork can use Kubernetes, Fly.io, bare process |
| `scripts/generate-secrets.sh` | Operator tooling; does not touch wire formats |
| Cloudflare Tunnel Compose service | Ingress/TLS assembly; `PDPP_REFERENCE_ORIGIN` is the only protocol-relevant output |
| RunPod Pod template image | Packaging variant; same AS/RS wire behavior |
| `PDPP_OWNER_PASSWORD` gate | Reference-implementation auth only; not a Core protocol requirement |
| Dashboard session duration, PWA manifest | Operator UX; `polish-dashboard-auth-pwa-ux` |
| `apps/console` vs `apps/web` split | Code organization; `split-public-site-and-operator-console` |

## Phased SLVP Implementation Plan

### Prerequisites (already done)

- `add-selfhost-onboarding-slvp`: quickstart doc (Lane A + Lane B) and five-row deployment readiness panel. Implemented and validated.
- MCP grant packages, grant-package operator visibility: implemented.
- Device-exporter enrollment + diagnostics: implemented.
- Event-subscriptions read/disable: implemented.

### Phase 1 — Security and auth queue (S, ~3–5 days)

Ship in dependency order. Each builds on the previous.

| Step | Change | What it closes |
|---|---|---|
| 1a | `harden-reference-auth-surfaces` | Redact `token_id` from timeline reads; gate `POST /grants/<id>/revoke`; set clickjacking headers; replace personal subject-id default |
| 1b | `gate-ref-reads-when-owner-auth-enabled` | Gate `/_ref/*` reads when `PDPP_OWNER_PASSWORD` is set; reconcile CLI/test header plumbing |
| 1c | `honor-csrf-exemption-for-bff-device-flow` | Unblock the BFF device flow that MCP token issuance depends on |
| 1d | `polish-dashboard-auth-pwa-ux` | Extend owner-session lifetime to 7d; add dark mode; validate PWA + Web Push metadata |
| 1e | `dcr-per-owner-token-with-revoke` | Per-token DCR, RFC 7592 revoke, named clients in `/dashboard/deployment/tokens` |

**Acceptance check for Phase 1:**
- `/_ref/*` returns 401 when `PDPP_OWNER_PASSWORD` is set and no owner session header is present.
- `POST /grants/<id>/revoke` requires owner auth.
- `/dashboard/deployment/tokens` shows issued tokens, each with a revoke action.
- Owner session persists across a browser close (7d cookie).
- PWA install works on mobile.

### Phase 1.5 — Secret generation and quickstart improvements (S, ~1–2 days)

These are pre-flight tooling fixes. They can ship alongside Phase 1 or immediately after.

| Item | What it does | Promotion |
|---|---|---|
| `scripts/generate-secrets.sh` | Auto-generates `PDPP_OWNER_PASSWORD`, `SESSION_SECRET`, VAPID keys via `openssl rand`; writes to `.env.docker`; never overwrites existing values | Follow-up commit under `add-selfhost-onboarding-slvp` or standalone fix |
| Cloudflare Tunnel quickstart addition | Add "no domain, no open ports" sub-section to Lane A in `selfhost-quickstart.md` with a Compose snippet adding `cloudflared` service | Doc-only; no OpenSpec required |
| RunPod Hub → Pod template rename | Update the "deferred RunPod Hub template" framing in `selfhost-runpod-onboarding-slvp-2026-05-27.md` and this note | Doc-only; design note update |

**Acceptance check for Phase 1.5:**
- `./scripts/generate-secrets.sh` on a fresh clone produces a `.env.docker` with non-empty, non-example values for `PDPP_OWNER_PASSWORD`, `SESSION_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
- Running the script twice does not overwrite existing values.
- `selfhost-quickstart.md` Lane A includes a Cloudflare Tunnel option with an explicit Compose snippet.

### Phase 2 — Connection identity on public read (M, ~3–5 days)

This is a prerequisite for any operator UI that surfaces per-connection labels, per-connection config readiness, or per-connection attention state.

| Change | What it closes |
|---|---|
| `expose-connection-identity-on-public-read` | `connection_id` + owner-editable `display_name` on `rs.streams.list`; optional `connection_id` filter on read endpoints; `ambiguous_connection` typed error for detail/blob reads; owner-editable `display_name` mutation; per-connection labels on consent card |

**Acceptance check for Phase 2:**
- `GET /v1/streams` response includes `connection_id` and `display_name` on each stream item.
- `GET /v1/streams?connection_id=<id>` filters correctly.
- `GET /v1/records/<id>` with an ambiguous record (multi-connection) returns `ambiguous_connection` error with `available_connections`.
- `PATCH /connections/<id>/display_name` persists the new label.
- Consent card renders per-connection `display_name` labels, never raw `legacy` or `default_account`.

### Phase 3 — Scheduler loop and attention contract (M, ~5–8 days)

Triaged as one tranche, not four parallel partial slices.

| Step | Change | What it closes |
|---|---|---|
| 3a | `wire-reference-scheduler-loop` | Scheduler loop wired in all startup paths; schedules run on their configured cadence without manual trigger |
| 3b | `add-run-automation-policy-model` | Automation modes (auto / semi-auto / manual) per schedule; determines when a run requires owner action vs. runs silently |
| 3c | `define-schedule-manual-attention-policy` | Durable `attention_request` contract; notification fanout (Web Push); per-connection suppression; safe resume |
| 3d | `define-run-assistance-state-contract` | Separates progress posture, owner action, response obligation, attachments, sensitivity, durability in `run-interaction-streams` |

**Driver change:** `wire-reference-scheduler-loop` is the loop-wiring prerequisite. The owner should sequence 3b–3d behind it.

**Acceptance check for Phase 3:**
- A schedule created via `PUT /_ref/connectors/<id>/schedule` fires at the configured interval without any manual trigger after instance restart.
- A run that reaches an attention state surfaces an entry in `/dashboard` attention section.
- Web Push notification is delivered when Web Push is configured and a run needs attention.
- Acknowledging the attention request via the dashboard resumes the run.
- `/dashboard/runs/<id>` shows the run interaction stream with posture, owner-action, and response-obligation fields.

### Phase 4 — Optional: Deployment readiness Tier 2 (S, ~1–2 days)

Read-only follow-up to the existing five-row panel. No new control plane.

New rows (all derived from existing `/_ref/deployment` data):
- Web Push VAPID: both keys set, VAPID public key matches advertised value.
- n.eko allocator policy: surface mode (disabled / local-only / public) and whether `NEKO_*` vars are set consistently.
- Postgres runtime backend: whether Postgres is configured and health-checked (vs. SQLite default).
- Host browser bridge: whether `PDPP_HOST_BROWSER_*` env is set and the bridge health endpoint responds.
- `PDPP_TRUSTED_HOSTS`: whether the configured trusted-hosts list is non-empty and includes the current origin.

This slice needs its own small OpenSpec change to lock the row contract. It does not block the spin-up-to-grant journey; treat it as a polish slice after Phase 1–3.

**Acceptance check for Phase 4:**
- `/dashboard/deployment` shows the five existing rows plus up to five new optional rows.
- Each new row is absent (not shown as an error) when the corresponding feature is not configured.
- A misconfigured row shows a remediation hint; a correctly configured row shows green.

## Risks and Tradeoffs

### Risk 1 — Lane B (RunPod Pod) unverified live walk-through

The quickstart Lane B is documented but has not been walked through by an owner on a live RunPod Pod. The readiness panel and quickstart copy were written against Lane A. A live owner walk-through should be done before declaring self-host support "ready for friends."

**Mitigation:** Make a Lane B live walk-through a required acceptance step for Phase 1 closeout, not a deferred residual.

### Risk 2 — `generate-secrets.sh` portability

`openssl rand` and `npx web-push` are both available on standard Linux and macOS. RunPod CPU Pods run Ubuntu. The script should include a fallback for environments without `npx` (generate VAPID keys via Python or openssl-based arithmetic as a fallback). Risk is low for the target audience.

### Risk 3 — Phase 2 and connection-identity noun settling

`expose-connection-identity-on-public-read` is the authoritative change for the `connection` noun on the public contract. Any operator UI that renders per-connection labels should wait for that change to land. Racing ahead risks locking in `connector_instance_id` as a user-visible noun, which the proposal explicitly rejects.

### Risk 4 — Collection-policy tranche (Phase 3) as four parallel partial slices

The management map calls out this risk explicitly: `wire-reference-scheduler-loop` + `add-run-automation-policy-model` + `define-schedule-manual-attention-policy` + `define-run-assistance-state-contract` are four active changes. If each ships a partial slice, attention semantics will be inconsistent at intermediate states. The owner should designate one driver change and sequence the others behind it.

### Risk 5 — Credential management temptation

The per-connector configuration-readiness rollup (Lane 3, management map) is a clear operator need. However, crossing from "read env + manifest + coverage state" into "manage credentials in the dashboard" crosses into a durable contract change touching manifest authority and secret storage. Future work in this area must be drafted as its own OpenSpec change; it must not be smuggled under a readiness-panel polish commit.

## Prior Art and Evidence

| Finding | Source |
|---|---|
| `generate-secrets.sh` is the most consistent gap between PDPP and 2026 ecosystem expectations | Supabase self-hosting Docker, n8n 2026 self-host guide, Docker Compose secrets docs |
| RunPod Hub is serverless-only; Pod template is correct for persistent services | RunPod Hub deep dive, Manage Pod templates docs, RunPod containers GitHub |
| Cloudflare Tunnel is the dominant "no domain, no open ports" primitive in 2026 | selfhosting.sh Cloudflare Tunnel with Docker, Cloudflare Tunnel in 2026 (DEV) |
| r/selfhosted audience tolerates env-var setup when secrets are auto-generated + readiness panel confirms | Gitea install wizard, Coolify onboarding, Tipi one-click catalog patterns |
| A proactive first-boot wizard (blocks access until setup done) is correct for a wider non-technical audience; not required for r/selfhosted | Gitea + Coolify pattern analysis; SLVP scope decision in companion notes |
| Backup/export UI is incidental for r/selfhosted; CLI pg_dump + volume tarball is sufficient | Restic Docker Volume Backup (servercrate), Docker volume backup strategies (DEV), oneuptime backup guide |

Full citations in `design-notes/ri-selfhost-operator-setup-intake-2026-05-28.md`.

## What This Design Explicitly Defers

| Item | Why | Re-trigger |
|---|---|---|
| First-boot browser wizard (proactive gate on `/dashboard`) | r/selfhosted audience is comfortable with env-var setup + readiness panel; wizard is for wider non-technical audience | When target audience expands beyond r/selfhosted |
| Per-connector config-readiness rollup | Crosses env + manifest + coverage; needs own design note → OpenSpec | Management map Lane 3 recommendation 5 |
| In-dashboard credential management UI | Durable contract change: manifest authority, secret storage, rotation | Needs own OpenSpec change |
| RunPod Pod template / single-container image | New image shape, process supervision, release cadence | After Phase 1–3; own design note + OpenSpec |
| Tier-2 readiness rows | Nice-to-have polish; does not block the spin-up-to-grant journey | Phase 4 (optional) |
| Multi-operator RBAC | Not in scope for single-owner r/selfhosted target | Separate design |
| Auto-update / Watchtower | Operator-driven pull model is correct for this audience | Separate design |
| TLS at the PDPP layer | Cloudflare Tunnel / reverse proxy / `*.proxy.runpod.net` are the documented paths | N/A |
| Kubernetes deployment | Out of scope for r/selfhosted audience | Separate design |

## Promotion

This design note does not require a new OpenSpec change. Each phase is tracked by an existing active change or is a doc/tooling fix below the OpenSpec promotion bar.

If the owner proceeds with Phase 4 (Tier-2 readiness rows), a small new change `add-selfhost-deployment-tier2-readiness` is warranted.

If the owner proceeds with connection-readiness rollup or credential management, those need their own OpenSpec changes drafted before any implementation.

## Decision Log

- 2026-05-29: Synthesized this design note from three companion notes:
  `selfhost-runpod-onboarding-slvp-2026-05-27.md` (SLVP decision),
  `ri-selfhost-operator-setup-intake-2026-05-28.md` (prior-art intake + wizard-ownership framework),
  `ri-operator-selfhost-management-map-2026-05-28.md` (six-lane capability map).
  All three notes were complete and consistent; this note adds the integration-level framing,
  explicit noun/boundary table, phased plan with acceptance checks, and deployment-mode
  assembly/protocol distinction. No new design decisions are introduced; all conclusions
  follow from the companion notes and the evidence they cite.
  Confirmed: no new OpenSpec change is required for this note itself.
