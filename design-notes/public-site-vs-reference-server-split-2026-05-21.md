# Public Site Vs Reference Server Surface Split

Status: sprint-needed
Owner: reference implementation owner
Created: 2026-05-21
Updated: 2026-05-21
Related: openspec/specs/reference-surface-topology/spec.md, openspec/specs/reference-implementation-architecture/spec.md, openspec/changes/standardize-pdpp-package-publishing, design-notes/full-context-refresh.md, docs/package-release-policy.md

## Question

How should pdpp.dev (the public protocol/standards site) be physically separated from the hosted reference server and operator console, and is the existing pnpm-workspaces layout the right monorepo shape — or should the repo move to a Turborepo-style organization with explicit `apps/`, `packages/`, and a task graph?

The question matters because today running a single Next process (`apps/web`) ends up serving five very different surface families — public protocol docs, the public reference explainer, the mock sandbox, the live operator dashboard, and (via proxy) the reference AS/RS hosted HTML pages. Likewise, running the bare reference server (`reference-implementation`) exposes its own `/` discovery index, hosted `/consent`, `/device`, `/owner/login`, and `/__pdpp/*` assets even when the operator hasn't asked for an operator console. The `reference-surface-topology` capability already declares these surfaces must be distinguishable — but in code they share one origin, one build, and one deployment.

## Context

### What the website is today

`apps/web` is a single Next 16 App Router application with all of these route families layered onto one origin:

- public protocol/standards site: `/`, `/docs/**`, `/llms.txt`, `/llms.mdx`, `/llms-full.txt`
- public reference explainer + coverage matrix: `/reference/**`
- mock sandbox: `/sandbox/**` (mock-backed pedagogical reference dashboard, declared by `reference-surface-topology`)
- contributor workbench: `/design`, `/palette`
- OpenSpec viewer: `/planning/**`
- live operator console: `/dashboard/**`
- BFF/proxy to the reference HTTP servers: `/_ref/**`, `/v1/**`, `/oauth/**`, `/.well-known/**`, `/consent`, `/device`, `/owner/**`, `/agent-connect`, `/neko/**`, `/connectors/**`, `/__pdpp/**` (`apps/web/src/proxy.ts`)

### What the reference server is today

`reference-implementation/server/index.js` is a Node/Express AS+RS pair plus a small server-rendered "hosted-ui" layer (`reference-implementation/server/hosted-ui.js`) for `/consent`, `/device`, and `/owner/login`. The AS process also registers a root `/` discovery index (`app.get('/', { contract: 'getAsDiscoveryIndex' }, …)`, line 2072) and the RS process registers its own root discovery index (line 5180). Those are intentional — they are AS/RS service roots, not "the website" — but they collide visually with the public pdpp.dev `/` page in operator mental models, because hitting the reference server origin directly returns *something* at `/`.

### What runs in which deployment

`docker-compose.yml` runs two services side-by-side:

- `reference`: the AS/RS process (internal `:7662` and `:7663`)
- `web`: the Next app (browser-facing `:3002`)

The Next BFF proxies all reference traffic to the internal AS/RS over Docker DNS. The public Docker images are `ghcr.io/vana-com/pdpp/reference:main` and `ghcr.io/vana-com/pdpp/web:main` (README §Quick start). The browser only sees the web origin.

This means the *production* deployment shape already separates the two processes — the coupling is at the **routing and Next-app** layer, not at the *process* layer.

### What the pnpm workspace looks like today

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "demo/app"
  - "reference-implementation"
```

`apps/`:
- `web` — the combined public site + operator console + BFF

`packages/`:
- `cli` (`@pdpp/cli`, publishable)
- `local-collector` (`@pdpp/local-collector`, publishable)
- `pdpp-brand` (`@pdpp/brand`, private)
- `polyfill-connectors` (`@pdpp/polyfill-connectors`, private)
- `reference-contract` (`@pdpp/reference-contract`, private)
- `remote-surface` (`@pdpp/remote-surface`, private)
- `operator` (private — currently a placeholder)

`reference-implementation/` is its own workspace package (`pdpp-reference-implementation`, private) instead of living under `apps/` for historical reasons. It both publishes a CLI binary (`pdpp`) and runs the AS/RS as a Node service.

### What `reference-surface-topology/spec.md` already declares

The capability spec is explicit about taxonomy:

- `/docs/**` is protocol documentation; never live state.
- `/dashboard/**` is a live owner/operator control plane; owner-authed, noindex, safe to disable on public hosted documentation.
- `/sandbox/**` is mock-backed, resettable, clearly labeled simulated, never collects real credentials.
- `/reference/**` (and similar) is the public reference-implementation explainer.
- OpenSpec viewer is project planning, not protocol authority.

The spec says these surfaces SHALL be distinguishable. It does not require they live in the same Next app, and it explicitly anticipates a "public hosted documentation site without an intended live reference instance" deployment in which `/dashboard/**` SHALL be disabled or hidden.

### What is actually weird

1. **Operator mental model collision.** A developer running `pnpm reference-implementation:server` directly (not via Compose) hits `http://localhost:7662/` and sees an AS discovery JSON. They then run `pnpm dev` (web) and hit `http://localhost:3000/` and see the marketing splash. Two different surfaces both legitimately claim "root of PDPP" depending on which process they hit.

2. **Single Next app couples two release cadences.** The public site changes when docs, brand, and explainer copy change. The operator console changes when AS/RS behavior changes. They share a build, a bundle, a Next version, and a deploy step. A docs typo retriggers operator-console regression risk and vice versa.

3. **Public hosted documentation deploy is theoretical, not real.** The spec already says "public hosted documentation site without an intended live reference instance" is a valid deployment, but today the only way to deploy the public site is to ship the operator console along with it (and either disable it at runtime via env, or hide it behind owner auth). Hosting pdpp.dev on Vercel as a pure documentation site currently requires either dead routes or a forked build.

4. **`/sandbox` and `/dashboard` reuse code.** The mock sandbox is *designed* to share components with the live dashboard (spec: "Sandbox UI reuses dashboard components"). Splitting public vs operator at the build boundary must preserve that sharing, which means a shared package, not duplication.

5. **Reference server's hosted-ui is fine — until it's not.** `hosted-ui.js` exists because AS/RS need to render OAuth consent, device flow, and owner-login HTML *at the AS/RS origin* (Cookies-Are-Site-Scoped reality). Those pages can't live in `apps/web` without a same-origin trick. The BFF proxy is that trick. Splitting public site from operator console must not break the AS/RS-hosted pages.

## Stakes

- **Operator clarity.** A self-hosting operator should be able to choose "public docs site only", "operator console only", or "the whole thing" without forking the repo. Today the only honest answer is "the whole thing".
- **Hosted reviewer story.** Standards reviewers landing on pdpp.dev should never see an operator dashboard shell or reference-only AS/RS plumbing on the public site. Today that protection is route-level guesswork in proxy + middleware, not architecture.
- **Build/CI cost and blast radius.** A docs PR rebuilds the operator console; a dashboard change rebuilds the docs site. With Turborepo task caching, both could be untouched-package skips. Without it, every CI run rebuilds everything.
- **Forkability.** PDPP is a reference implementation. Forks should be able to keep our public site untouched and rewrite only the operator console, or vice versa.
- **Protocol-leak hygiene.** Any decision that puts the reference-server-hosted pages and the public docs behind one Next bundle invites accidental coupling between protocol artifacts and reference UX, which `full-context-refresh.md` calls out as the central risk.

## Current Leaning

### Surface taxonomy and ownership

Pick five surfaces. Each gets one clear owner:

| Surface | Today | Proposed owner |
| --- | --- | --- |
| Public protocol/standards site (`/`, `/docs`, `/reference`, `/llms*`) | `apps/web` | `apps/site` (new) |
| Public mock sandbox (`/sandbox`) | `apps/web` | `apps/site` (shares UI from `packages/operator-ui`) |
| Public OpenSpec viewer (`/planning`) | `apps/web` | `apps/site` |
| Contributor workbench (`/design`, `/palette`) | `apps/web` | `apps/site` (gated to non-prod or kept as `?dev=1`) |
| Live operator console (`/dashboard`) | `apps/web` | `apps/console` (new) |
| AS/RS API + AS/RS-hosted HTML (`/oauth`, `/consent`, `/device`, `/owner`, `/_ref`, `/v1`, `/.well-known`, `/__pdpp`, `/neko`) | `reference-implementation` | `reference-implementation` (unchanged) |

The reference-implementation server keeps its current routes — including its `/` discovery index, which is correct behavior for an AS root. The "weirdness" is resolved by ensuring the *public-facing host* never points directly at the AS/RS origin. Public traffic terminates at the public site or at the operator console, never at the bare reference server.

### Process/zone topology

Recommended:

1. **`apps/site`** — Next 16 App Router, owns the public protocol/standards surfaces. Statically generated where possible. No BFF to the reference server. No `/dashboard`. Safe to deploy to Vercel as the canonical pdpp.dev with zero reference-implementation runtime dependency.
2. **`apps/console`** — Next 16 App Router, owns `/dashboard` and the AS/RS BFF rewrites (`/_ref`, `/v1`, `/oauth`, `/.well-known`, `/consent`, `/device`, `/owner`, `/__pdpp`, `/connectors`, `/neko`). This is what ships in the Docker `web` image today, minus the public-site routes.
3. **`reference-implementation`** — unchanged AS/RS Node service. Its `/` discovery indexes remain but are not user-facing in the default operator deployment because the console is what the browser hits.
4. **Public site ↔ console linking.** When pdpp.dev wants to link to "Open your local dashboard" or "Try the sandbox connected to your own instance", the public site emits a `localhost:3002` link (or a documented operator origin), never proxies. The sandbox stays on the public site because it is mock-backed; the dashboard stays on the console because it is live.

### Should it be Multi-Zones or two deployments?

Next's Multi-Zones (`apps/web/.../guides/multi-zones.mdx`) is designed for "one origin, many Next apps". It works by giving each zone a unique `assetPrefix` and routing top-level paths to other zones via rewrites. It is the right tool when:

- the operator wants one URL like `pdpp.example.com` that serves both public docs *and* an operator dashboard at `/dashboard`;
- and they accept hard navigations between zones (no client-side prefetch across zones).

For PDPP, **separate deployments are the better default**, with Multi-Zones available as an *optional composition layer*:

- **Public pdpp.dev** is statically generated and never needs to be on the same origin as a running reference instance. It is a documentation site. A future Vana-hosted pdpp.dev should not carry operator-console code at all.
- **Operator console** runs alongside the AS/RS in the operator's deployment (Docker Compose, Coolify, k8s, whatever). The operator origin is theirs (`pdpp.local`, `mybox.tailnet`, `pdpp.example.com`).
- **Multi-Zones is the right tool for the *operator* deployment** if the operator wants their origin to also serve the public docs under `/docs/**` — but that's a hosting choice, not the default. The recommended default is: the operator origin serves only the console (+ BFF to AS/RS); pdpp.dev serves the docs.
- The public site can also be reverse-proxied in front of an operator instance at deploy time, but we should not bake that as a *required* topology.

This matches Next.js's own framing of Multi-Zones: "one of the Next.js applications can also be used to route requests for the entire domain" — i.e., it is a composition primitive available when needed, not a mandatory architecture.

### What happens when a developer runs the reference server locally

Three honest paths, all supported:

1. **`pnpm dev` (default contributor workflow).** Boots `reference-implementation` (AS `:7662`, RS `:7663`) and `apps/console` (`:3002` or first free port from `:3000`). `apps/site` does *not* boot by default. The contributor sees the operator console, which is what they almost always want when developing reference-implementation behavior.
2. **`pnpm site:dev` (docs/marketing contributor workflow).** Boots only `apps/site` (`:3001` say). The reference server is not started. No `/dashboard`, no BFF. The mock sandbox still works because it is mock-backed.
3. **`pnpm dev:full`.** Boots `reference-implementation`, `apps/console`, and `apps/site`. The contributor can verify cross-surface linking ("open your dashboard from the docs", etc.) without hard-coding origins.

The bare reference server retains its current behavior — `/` returns the AS/RS discovery JSON — but we add a small `/` HTML fallback that says "This is the PDPP reference AS/RS. Open your operator console at <link>." in browsers (content negotiation), so a developer who hits `http://localhost:7662/` in a browser by mistake is not confused. The JSON discovery contract remains.

### Should we adopt Turborepo now?

Turborepo's own docs (`vercel/turborepo` `apps/docs/content/docs/index.mdx`) frame it as: "Turborepo solves your monorepo's scaling problem… Turborepo can be adopted incrementally and you can add it to any repository in just a few minutes. It uses the `package.json` scripts you've already written, the dependencies you've already declared, and a single `turbo.json` file. You can use it with any package manager."

For PDPP the practical questions are:

1. **Do we have a build-graph problem today?** Partially. The repo already has ~10 publishable/private packages plus `apps/web` plus `reference-implementation`. CI does whole-repo work even when only docs change. A docs-only PR rebuilds the operator console, retypechecks the reference server, and so on.
2. **Will splitting `apps/web` into `apps/site` and `apps/console` make this worse?** Marginally — two Next builds instead of one. Turborepo's per-package caching makes it net better.
3. **Do we need remote caching?** Not yet. Local caching is the immediate win.
4. **Does Turborepo conflict with semantic-release / pnpm workspace publish?** No. semantic-release config (`.releaserc.yaml`) targets `packages/cli` and `packages/local-collector` independently of Turborepo. Turborepo orchestrates `build`/`test`/`lint`/`verify`; semantic-release orchestrates publishing.
5. **Is `reference-implementation` outside `apps/` a problem?** Slightly, by convention. Turborepo's "structuring a repository" guidance recommends `apps/` for deployables and `packages/` for shared libs. `reference-implementation` is a deployable (it's the AS/RS service) and would more naturally live at `apps/reference`. But this rename is a separate cleanup from the site/console split and should not block it.

**Recommendation: adopt Turborepo as part of the split, not before.** Adopt it because we are explicitly creating a second Next app and we want untouched-package skips. Do not adopt it as a precursor refactor — that creates churn without payoff. The order is:

1. land the site/console split with the existing pnpm workspaces;
2. add `turbo.json` and convert root scripts to `turbo run …`;
3. consider renaming `reference-implementation` → `apps/reference` in a follow-up.

### OpenSpec changes required

Two changes look necessary, possibly three:

1. **`split-public-site-and-operator-console`** (required, large).
   - Modifies `reference-surface-topology` with new requirements: public surfaces SHALL NOT be served from the same origin as a live operator dashboard by default; operator deployments SHALL be able to disable the public-site bundle entirely; the public site SHALL be deployable without a running reference instance.
   - Modifies `reference-implementation-architecture` to acknowledge the split (the deployable shape now includes two Next apps + one Node service).
   - Migrates routes from `apps/web` to `apps/site` and `apps/console`.
   - Adds the BFF/proxy responsibility explicitly to the console, not the site.
   - Defines what `pnpm dev`, `pnpm site:dev`, and `pnpm dev:full` mean.

2. **`adopt-turborepo-task-graph`** (recommended, medium).
   - Adds `turbo.json` with `build`, `test`, `verify`, `types:check`, `check`, `dev` pipelines.
   - Converts root `package.json` scripts to `turbo run …` aliases.
   - Documents the task graph and pnpm-workspaces interaction.
   - Decides about remote caching (default: off; we can revisit).

3. **`relocate-reference-implementation-to-apps`** (optional follow-up).
   - Moves `reference-implementation/` to `apps/reference/`.
   - Pure rename + path update; deferrable until quieter.

The first two should ship as separate proposals because the surface-split is durable architecture and Turborepo adoption is a tooling/CI change. They share a worktree but are mergeable independently.

### Counterarguments and risks

- **"Two Next apps is more to deploy."** True. The operator already runs Docker Compose; we ship one more image (`pdpp/site`) for the public site, but operators don't need it — only pdpp.dev needs it. For self-hosters the deployment shape is identical to today (`web` + `reference`), just with the BFF responsibilities moved to `web` (now `console`).
- **"BFF migration is risky."** Moderately. `apps/web/src/proxy.ts` is non-trivial. The mitigation is to move it whole into `apps/console/src/proxy.ts` first, then prune public-site matchers in a second commit. The DAL gate in `dashboard/lib/verify-session.ts` and the topology resolver are reused unchanged.
- **"Shared components between sandbox and dashboard will rot."** Mitigated by extracting a `packages/operator-ui` (or similar) for the shared component layer. The mock sandbox imports from `packages/operator-ui` and lives on `apps/site`; the live dashboard imports from `packages/operator-ui` and lives on `apps/console`. This is the kind of "small set of durable primitives" `full-context-refresh.md` advocates.
- **"Turborepo is overhead for a small team."** It is genuinely lightweight in 2026 (`turbo.json` + `turbo run …` is the whole footprint). The concrete win is per-package CI caching once we have two Next apps; without two apps, the win is smaller.
- **"Multi-Zones would let us keep one Next app and just split logically."** Multi-Zones still requires two Next apps; it only changes how they are composed at the edge. It is not a way to keep one app.
- **"What about pdpp.dev SEO/links?"** The split *improves* this — pdpp.dev becomes a static-friendly docs site without a stateful operator surface dragging it down. Existing operator console URLs continue to work because the operator deployment still serves `/dashboard` at the operator origin; pdpp.dev never hosted a real `/dashboard` for users in the first place.
- **"Are we sure `/sandbox` belongs on the public site?"** Yes per `reference-surface-topology`: mock-backed, resettable, pedagogical, never real credentials. It is a documentation surface that happens to be interactive.
- **"Are we sure `/reference` and `/planning` belong on the public site?"** `/reference` is the public reference-implementation explainer; explicitly public per spec. `/planning` is the OpenSpec viewer; spec says it must not be presented as protocol authority but doesn't say where it must live. Keeping it on the public site under a "Project planning" badge is fine.

## Boundary Map

PDPP Core / `openspec/specs/*` ownership is unchanged.

Reference implementation deployable shape becomes:

- `apps/site` — public protocol/standards site, public sandbox, public reference explainer, OpenSpec viewer, contributor workbench. No BFF. No live state. Statically deployable.
- `apps/console` — operator dashboard + BFF to AS/RS. Owner-authed when configured. Noindex. Safe to disable.
- `reference-implementation` (or future `apps/reference`) — AS/RS Node service. AS/RS-hosted OAuth/device/owner pages. Unchanged contract.
- `packages/operator-ui` — shared components between sandbox (mock-backed) and dashboard (live-backed).
- `packages/brand`, `packages/reference-contract`, `packages/remote-surface`, `packages/polyfill-connectors`, `packages/cli`, `packages/local-collector` — unchanged ownership.

## Implementation Lanes

When the OpenSpec changes are approved, work splits into bounded lanes (no implementation here — these are scope hints for future task packets):

1. **Surface inventory + spec delta (owner agent).** Enumerate every current route under `apps/web/src/app/**`, classify each as public-site or operator-console, and draft the `reference-surface-topology` and `reference-implementation-architecture` deltas. No code yet.
2. **Extract `packages/operator-ui` (worker).** Move shared components used by both `/sandbox` and `/dashboard` into a new private workspace package. Verify both routes still render in the current single app.
3. **Create `apps/console` (worker).** Copy `apps/web` minus the public-site routes; move `src/proxy.ts` here. Wire BFF. Verify `/dashboard` end-to-end against the running reference server.
4. **Trim `apps/web` → `apps/site` (worker).** Remove `/dashboard`, remove BFF routes, remove server-only proxy imports. Public site becomes statically generatable.
5. **Docker Compose update (worker).** `web` image now publishes `apps/console`; add an `apps/site` image only if Vana intends to deploy pdpp.dev from this repo (likely yes, separately).
6. **Turborepo adoption (worker, after split is stable).** Add `turbo.json` + root script rewrites; verify CI savings.
7. **Optional: relocate `reference-implementation/` → `apps/reference/` (worker, follow-up).** Cosmetic but improves repo legibility.

## Source Links

- Next.js Multi-Zones (App Router): https://nextjs.org/docs/app/guides/multi-zones
- Turborepo docs index: https://turborepo.dev/docs
- Turborepo "Structuring a repository": https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository
- `reference-surface-topology` spec (this repo): `openspec/specs/reference-surface-topology/spec.md`
- `reference-implementation-architecture` spec (this repo): `openspec/specs/reference-implementation-architecture/spec.md`
- Existing BFF/proxy (this repo): `apps/web/src/proxy.ts`
- Reference server hosted-ui (this repo): `reference-implementation/server/hosted-ui.js`
- Reference topology resolver (this repo): `reference-implementation/server/reference-topology.ts`
- Package release policy (this repo): `docs/package-release-policy.md`

## Promotion Trigger

Promote into OpenSpec before any code moves. The split changes:

- the architecture boundary of the reference implementation (one Next app → two apps);
- the operator deployment shape (one container vs two browser-facing containers);
- the public/private surface contract declared by `reference-surface-topology`;
- the build/CI topology (one task graph → Turborepo task graph).

All four are explicitly listed in `design-notes/README.md` as promotion triggers.

The recommended sequence is: open `split-public-site-and-operator-console` first; once approved, open `adopt-turborepo-task-graph` as a sibling change so the surface split lands first and Turborepo lands on top of the new layout.

## Decision Log

- 2026-05-21: Captured. Inspected `apps/web/src/app/**`, `apps/web/src/proxy.ts`, `reference-implementation/server/index.js` (and `hosted-ui.js`), `pnpm-workspace.yaml`, `docker-compose.yml`, `docs/package-release-policy.md`, `openspec/specs/reference-surface-topology/spec.md`, current Next.js Multi-Zones docs, and current Turborepo docs. Current conclusion: split `apps/web` into `apps/site` (public) and `apps/console` (operator + BFF), keep `reference-implementation` as the AS/RS Node service, extract a `packages/operator-ui` for sandbox/dashboard component sharing, and adopt Turborepo as a follow-up change after the split lands. Multi-Zones is available as an optional operator-deployment composition primitive but is not the default. Two OpenSpec changes are required before implementation, plus an optional `reference-implementation/` → `apps/reference/` rename later.
