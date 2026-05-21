## Context

`apps/web` is one Next 16 App Router process layered with five surface families on a single origin, plus a BFF that proxies to the AS/RS (`reference-implementation/`). The detailed inventory and reasoning live in `design-notes/public-site-vs-reference-server-split-2026-05-21.md` (Promotion Trigger §); this design carries the decisions over into a normative OpenSpec change.

Three facts shape the design:

1. **pdpp.dev is a standards/docs site, not a hosted service.** PDPP does not operate a live consumer reference instance. The public site must be deployable without any reference-implementation runtime — Vercel static, S3+CloudFront, GitHub Pages, anything.
2. **The reference server is self-hostable, not centrally hosted.** Anyone can run the AS/RS + operator console on their own infrastructure. The operator origin is theirs (`pdpp.local`, `mybox.tailnet`, `pdpp.example.com`). There is no "the production reference instance" to point users at.
3. **`reference-surface-topology` already anticipates this split** ("public hosted documentation site without an intended live reference instance"), but the code conflates the two surfaces. Today the only deployable that exists is "site + console + BFF in one Next process."

This change is durable architecture: the boundary between public-site and operator-console becomes an artifact boundary, not a route-level guess in middleware. Once landed, forks can safely rewrite one without touching the other.

## Goals / Non-Goals

**Goals:**

- Make the public site deployable from this repo without including operator-console code or a BFF.
- Make the operator console deployable from this repo without including marketing/docs/explainer code.
- Preserve the existing mock sandbox (`/sandbox/**`) as a public, mock-backed pedagogical surface on the public site.
- Preserve the existing live dashboard (`/dashboard/**`) as the owner-authed operator surface on the operator console.
- Resolve the "two things both claim `/`" mental-model collision by having the bare AS/RS root serve a browser-friendly landing page that points the developer at their console origin while keeping JSON discovery contracts intact.
- Keep `/sandbox` and `/dashboard` UI in sync by extracting the shared feature components into one workspace package.
- Codify the split in `reference-surface-topology` and `reference-implementation-architecture` so future work (Turborepo adoption, repo rename of `reference-implementation/`, additional surfaces) inherits the boundary.

**Non-Goals:**

- Do not adopt Turborepo in this change. That is a sibling change (`adopt-turborepo-task-graph`) that lands after the split is stable.
- Do not rename `reference-implementation/` to `apps/reference/`. Optional follow-up after the split lands.
- Do not change AS/RS wire contracts: well-known metadata, OAuth flows, RS surfaces, `_ref` surfaces are unchanged.
- Do not introduce Multi-Zones as a required topology. It remains an optional composition primitive that operators may use if they want one origin to serve both docs and console.
- Do not pre-fork CI/CD pipelines. CI updates land alongside the implementation lanes.

## Decisions

### 1. Two Next apps, one Node service

Three deployables after the split:

| Deployable | Owns | Origin (default) | Live state? | Deployable target |
| --- | --- | --- | --- | --- |
| `apps/site` | `/`, `/docs`, `/reference`, `/llms*`, `/sandbox`, `/planning`, `/design`, `/palette` | `pdpp.dev` (Vana) or any static host | No | Vercel / static |
| `apps/console` | `/dashboard`, BFF/proxy (`/_ref`, `/v1`, `/oauth`, `/.well-known`, `/consent`, `/device`, `/owner`, `/__pdpp`, `/connectors`, `/neko`, `/agent-connect`) | Operator-chosen | Yes | Operator container alongside AS/RS |
| `reference-implementation` | AS/RS API + AS/RS-hosted HTML (`hosted-ui.js`) | Internal only, behind the console BFF | Yes | Operator container |

The public site never proxies to a hosted live AS/RS. The operator console proxies only to its co-deployed AS/RS instance over Docker DNS (or equivalent).

**Alternative considered: keep one Next app with environment-gated routes.** This is what the current code attempts. It puts route-family ownership in middleware and env flags, which is exactly the route-level guesswork the spec already says we should retire. It also forces every docs PR to retrigger operator-console regression risk and vice versa. Rejected.

**Alternative considered: Multi-Zones with one origin.** Next's Multi-Zones (`apps/web/.../guides/multi-zones.mdx`) still requires two Next apps; it only changes how they are composed at the edge. It is an optional composition layer for operators who want `pdpp.example.com` to serve both docs and a console under different prefixes. It is not a way to keep one app. The split is required regardless; Multi-Zones can be enabled later as a deployment choice.

### 2. Bare AS/RS root: content negotiation, not route change

Today, `reference-implementation/server/index.js` registers a root `/` handler (`getAsDiscoveryIndex` on the AS process at line 2072, and another on the RS process at line 5180) that returns AS/RS discovery JSON. That is correct behavior for an AS/RS root and SHALL remain the response for `Accept: application/json` and similar discovery-shaped requests. The "operator mental model collision" (a developer hitting `http://localhost:7662/` in a browser and seeing JSON) is resolved by **content negotiation**:

- `Accept: application/json` (or any JSON-shaped Accept header) → existing discovery JSON, unchanged byte-for-byte where any client cares.
- `Accept: text/html` (browser default) → a small operator/admin landing page that says: *"This is the PDPP reference AS/RS at `<origin>`. The operator console is at `<configured-console-origin>` (or open it locally at `http://localhost:3002`). Discovery JSON is available at `/.well-known/oauth-authorization-server` (AS) and `/.well-known/oauth-protected-resource` (RS)."*

This page is server-rendered HTML in the existing `hosted-ui.js` style, not a Next page. It is reachable from `reference-implementation` alone and SHALL NOT require `apps/console`.

The well-known JSON endpoints (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`) and existing API routes are unchanged. The content-negotiated HTML at `/` is an addition for browsers, not a replacement.

**Alternative considered: move discovery to `/.well-known/pdpp-discovery` and serve the landing page at `/` unconditionally.** That changes a wire contract for the sake of a UX problem. Rejected — content negotiation solves the UX without breaking discovery.

**Alternative considered: serve no HTML at the AS/RS origin in any case and rely on operators always fronting it with the console.** That punishes the "developer hits the bare port in a browser" path that the design note explicitly calls out as a confusion source. Rejected.

### 3. `packages/operator-ui` is the shared component substrate

The mock sandbox and the live dashboard share UI by spec ("Sandbox UI reuses dashboard components", `reference-surface-topology`). After the split, the public site owns `/sandbox` and the operator console owns `/dashboard`, so the components they share must live outside both. They land in a new `packages/operator-ui` workspace package (private):

- `packages/operator-ui` exports feature components (records, search, grants, runs, traces, deployment, timelines) bound to a `DashboardDataSource` interface.
- `apps/site` (sandbox) imports `operator-ui` and binds the components to a deterministic mock data source — same shape used today by `add-mock-reference-demo-instance`.
- `apps/console` (dashboard) imports `operator-ui` and binds the components to live AS/RS clients via the BFF.

The existing `packages/operator/` placeholder either absorbs this scope or is removed and replaced by `packages/operator-ui`; the implementation lane will choose based on what is least churn.

**Alternative considered: duplicate components across `apps/site` and `apps/console`.** Rejected — drift is guaranteed; the spec already says sandbox reuses dashboard components.

**Alternative considered: keep the components in `apps/console` and have `apps/site` import from it.** Rejected — that makes `apps/site` deployable only when `apps/console` is buildable, which defeats the public-site-only deploy story.

### 4. Public site never proxies to a hosted live AS/RS

The public site is statically generable. It does not embed an AS/RS origin. When the public site wants to send users to a live experience, it does so via a documented link to `localhost:3002` (default operator origin) or an operator-supplied origin, never via a BFF on `pdpp.dev`.

This protects two invariants:

1. **No protocol-leak hygiene risk.** The public site cannot accidentally serve a stateful AS/RS surface alongside protocol docs.
2. **No central reference instance implication.** Visitors to pdpp.dev cannot mistake a hosted AS/RS for "Vana's PDPP service." There is no such service.

The mock sandbox on the public site is the only "interactive PDPP" experience pdpp.dev exposes, and it is mock-backed by design.

### 5. Three contributor workflows, named

`pnpm dev` — boots `reference-implementation` (AS `:7662`, RS `:7663`) and `apps/console` (`:3002` or next free port). `apps/site` does not boot. This is the default contributor workflow because most PDPP work touches the reference behavior or the console.

`pnpm site:dev` — boots `apps/site` (`:3001`). The reference server is not started. No `/dashboard`. No BFF. The mock sandbox still works (it is mock-backed). This is the docs/marketing contributor workflow.

`pnpm dev:full` — boots `reference-implementation`, `apps/console`, and `apps/site`. This is for verifying cross-surface linking ("open your dashboard from the docs", etc.).

The exact script names are normative because they appear in the public docs and in the contributor onboarding. They MAY be implemented as `concurrently`, `pnpm -r`, or Turborepo `turbo run dev` (the latter after `adopt-turborepo-task-graph` lands).

### 6. Migration order, not migration mechanism

The OpenSpec change captures the *target shape* and the *migration order*; it does not prescribe a specific git mechanic. The recommended order (also in `tasks.md`):

1. Extract `packages/operator-ui` from `apps/web` without splitting `apps/web`. Verify `/sandbox` and `/dashboard` still render in the single app.
2. Create `apps/console` as a copy of `apps/web` with public-site routes removed. Move `apps/web/src/proxy.ts` to `apps/console/src/proxy.ts` whole. Verify `/dashboard` end-to-end against `reference-implementation`.
3. Trim `apps/web` into `apps/site` — remove `/dashboard`, BFF, server-only proxy imports, and any owner-auth code. Verify static build.
4. Update `docker-compose.yml`: `web` service now publishes `apps/console`. The `apps/site` image is built but is not part of the operator's default `docker compose up` flow.
5. Add the content-negotiated `/` HTML on `reference-implementation`.
6. Remove `apps/web/`.

This sequence keeps a working `/dashboard` and `/sandbox` at every commit until the very last step.

### 7. What stays the same

- All `/v1` RS routes, `/oauth` AS routes, `/.well-known/*` metadata, and `_ref` reference-only routes keep their paths, methods, request shapes, response shapes, and authentication semantics.
- The owner-session cookie contract (`PDPP_OWNER_PASSWORD`, `dashboard/lib/verify-session.ts`) is unchanged.
- `hosted-ui.js` keeps serving `/consent`, `/device`, `/owner/login` from the AS/RS origin (same-origin cookie reality is unchanged).
- The `reference-implementation` package layout, `pdpp` CLI, and all internal modules are unchanged.

## Risks / Trade-offs

- **Two Next builds instead of one.** Real cost in CI minutes today; net win once Turborepo lands (sibling change). For self-hosters via Docker Compose, the deployment is identical to today (`web` + `reference` containers); only the contents of the `web` image change.
- **BFF migration is the largest single move.** `apps/web/src/proxy.ts` is non-trivial. Mitigation: move it whole into `apps/console/src/proxy.ts` in one commit, then prune public-site matchers in a follow-up. Do not interleave splits with proxy refactors.
- **Shared components must not regress sandbox vs dashboard.** Mitigation: extract `packages/operator-ui` *first*, with both `/sandbox` and `/dashboard` still in `apps/web`, verify both still render, and only then split the apps.
- **Static-site decision constrains some interactive flows.** `apps/site` is statically generable, which means it cannot host server-side personalization or live AS/RS state. This is a feature, not a bug — pdpp.dev is a docs site — but contributors must understand that anything live belongs on `apps/console`.
- **Operator who wants one origin for both docs and console.** Supported via Next Multi-Zones at the operator's reverse proxy. The repo does not bake this as the default topology, but the public site is buildable as a Multi-Zone child app with `assetPrefix` configured.
- **Forks that rename `pdpp.dev`.** A fork that wants `their-org.example/docs` for the public site can deploy `apps/site` to that origin without code changes. A fork that wants only the console can run `apps/console` + `reference-implementation` and skip `apps/site` entirely.

## Acceptance Checks

- `openspec validate split-public-site-and-operator-console --strict` passes.
- `openspec validate --all --strict` passes.
- The proposal, design, tasks, and spec deltas reference `design-notes/public-site-vs-reference-server-split-2026-05-21.md` so the requirements-discovery lineage is auditable.
- Reviewers can answer these questions from the artifacts alone:
  - Where does the public site live, what does it own, and what does it not own?
  - Where does the operator console live, what does it own, and what does it not own?
  - What happens when a developer hits the bare AS/RS root in a browser? What happens with `Accept: application/json`?
  - Which packages must be shared, and where do they live?
  - What are the three `pnpm dev*` workflows and what does each boot?
  - What wire contracts change? (Answer: none.)

Implementation-side acceptance (verified during the implementation lanes, not in this proposal):

- `apps/site` builds with `pnpm --dir apps/site run build` and serves statically.
- `apps/console` builds with `pnpm --dir apps/console run build` and serves `/dashboard` against `reference-implementation`.
- `curl -H 'Accept: application/json' http://localhost:7662/` returns the existing AS discovery JSON byte-for-byte.
- `curl -H 'Accept: text/html' http://localhost:7662/` returns the new operator landing HTML.
- `apps/web/` no longer exists.
- `docker compose up` brings up `reference` + `console` (renamed from `web`). The `site` image, when built, runs independently.
