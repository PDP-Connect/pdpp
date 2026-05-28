# Design: Self-Host Onboarding SLVP

## Goal

A friend or r/selfhosted reader can spin up a working PDPP reference deployment, see honest readiness in the dashboard, and permission Claude or ChatGPT to read their records — without confusing the protocol with a hosted service.

## Non-goals

- A RunPod Hub one-click template (`hub.json` + `tests.json`). Requires a single-container image and a new operational shape; tracked as the next slice.
- A dashboard UI for connector credential management. Today credentials are env-var driven, and changing that is its own durable contract.
- Custom-domain TLS at the PDPP layer. RunPod's proxy URL is fine for SLVP; Cloudflare CNAME is the documented escape hatch.
- Multi-operator RBAC, auto-update, multi-Pod fleet, backup-restore UI.

## Approach

Two artifacts, both small.

### 1. `docs/operator/selfhost-quickstart.md`

Two lanes, in this order:

- **Lane A — Docker host.** The fully-supported path. Targets a laptop, VPS, Hetzner box, or NAS that runs Docker. Uses the existing `docker-compose.yml` and `.env.docker.example`. Cites the minimum env vars that must change from defaults (`PDPP_OWNER_PASSWORD` set; `PDPP_REFERENCE_ORIGIN` set to the external URL when not `http://localhost:3002`).
- **Lane B — RunPod Pod (CPU).** The substrate-specific path requested by the user. States RunPod's constraints up front: HTTP via `*.proxy.runpod.net` with TLS terminated by RunPod (services must bind `0.0.0.0`), TCP via public-IP ephemeral ports, no UDP, no first-party custom-domain TLS, no multi-container compose primitive. Documents the practical recipe: a single CPU Pod with `/workspace` mounted, the existing reference image, web container reached via the proxy URL, env vars set in the Pod's template form, MCP wired via the proxy URL.

Each lane ends with a "wire Claude/ChatGPT to your `/mcp`" pointer to the existing `docs/operator/hosted-mcp-setup.md`.

The quick-start explicitly *does not* claim that the current compose stack is RunPod-Hub publishable. It names the Hub template as the next slice.

### 2. Deployment readiness panel on `/dashboard/deployment`

A small structured surface inside the existing deployment diagnostics view. Each row is `{ check, status, detail, hint? }`. Statuses are `ok | warn | error | info | unknown`. `unknown` is reserved for browser-side probes that have not yet returned (origin comparison before `window.location` resolves; `/.well-known/oauth-authorization-server` fetch in flight) — the panel must not lie about a check it has not actually performed. Checks for SLVP:

| Check | Source | Hint when not OK |
|---|---|---|
| Owner password gate | `/_ref/deployment` (does `PDPP_OWNER_PASSWORD` map to a non-empty configured value) | "Set `PDPP_OWNER_PASSWORD` in your env and restart; otherwise `/owner`, `/device`, `/consent`, and `/dashboard` are reachable without auth." |
| Reference origin / proxy alignment | client-side: compare `window.location.origin` with the server-reported `PDPP_REFERENCE_ORIGIN` | "Set `PDPP_REFERENCE_ORIGIN` to the URL you are visiting (e.g. `https://<podid>-3002.proxy.runpod.net`). Mismatches break the MCP and OAuth callback flows." |
| Storage backend health | existing `/_ref/deployment` storage check | "Storage backend reports unhealthy. See `docs/operator/selfhost-quickstart.md#storage`." |
| Embedding cache | existing `/_ref/deployment` embedding cache report | "Embedding cache is still downloading or missing. Wait for first-boot download to finish, or set `PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0` if you do not need semantic search yet." |
| MCP refresh-token advertisement | one-shot fetch of `/.well-known/oauth-authorization-server` for `grant_types_supported` containing `refresh_token` | "Reference image is too old to advertise `refresh_token`. `docker compose pull` to the current image." |

Every value already exists or is computable from values already exposed. **No new `/_ref/*` endpoint, no new owner control plane.** The panel is presentation of existing state.

The panel does not implement an "owner password reset" or "credential entry" affordance — those would be new contract surface and are out of scope.

## Alternatives considered

- **Ship a RunPod Hub template now.** Rejected for SLVP. Requires a new single-container image (`reference` + `web` + optional Postgres baked together with a supervisor), a `hub.json` schema we have not authored, and a release-tag cadence. Worth doing as the next slice but not as a low-risk landing today.
- **Build the in-dashboard credential UI as part of onboarding.** Rejected for SLVP. Credentials in the connector ecosystem have manifest authority semantics that deserve their own change. Bolting a credential form onto an "onboarding polish" lane would smuggle a durable contract.
- **Auto-generate missing secrets on first boot** (Supabase's `generate-keys.sh` model). Tempting but unnecessary for SLVP: the only secret the operator must set is `PDPP_OWNER_PASSWORD`, and prompting them to choose it is more honest than generating it. If we add more required secrets in future (encryption key for a credentials vault), revisit.
- **A `pdpp init` CLI.** Adds tooling for a problem the dashboard panel already solves visibly. Deferred.

## Acceptance checks

1. `docs/operator/selfhost-quickstart.md` exists, lints clean, links to `docker-compose.yml`, `.env.docker.example`, and `docs/operator/hosted-mcp-setup.md` with resolvable paths.
2. `/dashboard/deployment` shows the readiness panel with all five checks rendering against the live `/_ref/deployment` response and the in-browser origin.
3. With `PDPP_OWNER_PASSWORD` unset on a fresh stack, the panel renders the owner-password row as `error` with the documented hint.
4. With `PDPP_REFERENCE_ORIGIN=http://localhost:3002` but the dashboard accessed at any other origin, the panel renders the origin row as `warn` with the documented hint.
5. `openspec validate add-selfhost-onboarding-slvp --strict` passes.
6. `openspec validate --all --strict` passes.

## Residual risks

- Lane B (RunPod) is unverified by a real RunPod deployment in this change. The substrate constraints are sourced from current RunPod docs but no one has executed the runbook end-to-end on a fresh Pod. This is an owner-only live verification step; record it in `Residual Risks` and do not block archival on it.
- The readiness panel's "MCP refresh-token advertisement" check fetches `/.well-known/oauth-authorization-server`. If a deployment is configured with a custom `AS_ISSUER` whose well-known is not co-located with the dashboard origin, the check may show `warn` even on a healthy deployment. The hint should mention this case.
