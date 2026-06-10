## Why

`apps/web` currently bundles five very different surface families onto one Next process and one origin: the public protocol/standards site (`/`, `/docs`, `/reference`, `/llms*`), the public mock sandbox (`/sandbox`), the OpenSpec viewer (`/planning`), the contributor workbench (`/design`, `/palette`), and the live operator dashboard (`/dashboard`) — plus the BFF/proxy that fronts the AS/RS service (`/_ref`, `/v1`, `/oauth`, `/.well-known`, `/consent`, `/device`, `/owner`, `/__pdpp`, `/connectors`, `/neko`).

This conflates two products with two different audiences, two different deploy stories, and two different release cadences:

1. **pdpp.dev** is a public standards/docs site. It should be a static-friendly documentation surface that any reviewer (standards body, engineer evaluating adoption, GTM author) can read without a live reference instance behind it. Vana does not operate a hosted live PDPP service for end users; pdpp.dev is the public face of the protocol.
2. **The reference server** is a self-hostable AS/RS plus operator console. Anyone can run it on their own infrastructure. PDPP itself does not host this as a live consumer service.

Today the only way to deploy the public site is to also ship the operator console and BFF; the only way to expose the operator console is to also ship the public site. `reference-surface-topology` already anticipates a "public hosted documentation site without an intended live reference instance" deployment, but the code does not support it. Forks that want to rewrite only the console (or only the docs site) must touch both.

The design note `design-notes/public-site-vs-reference-server-split-2026-05-21.md` lays out the recommended split and is the authoritative source for this proposal. This change promotes that note into a durable architecture decision before any code moves.

## What Changes

- Split `apps/web` into two Next deployables:
  - **`apps/site`** — the public pdpp.dev surface: `/`, `/docs/**`, `/reference/**`, `/llms*`, `/sandbox/**` (mock-backed), `/planning/**` (OpenSpec viewer), and the contributor workbench (`/design`, `/palette`). Statically generable. No BFF. No live AS/RS dependency.
  - **`apps/console`** — the self-hosted operator console: `/dashboard/**` plus the BFF/proxy to the AS/RS (`/_ref`, `/v1`, `/oauth`, `/.well-known`, `/consent`, `/device`, `/owner`, `/__pdpp`, `/connectors`, `/neko`, `/agent-connect`). Owner-authed when configured, noindex, safe to disable.
- Extract a shared `packages/operator-ui` so the public mock sandbox and the live operator console bind the same dashboard feature components to different data sources.
- Keep `reference-implementation/` unchanged as the AS/RS Node service. Its `/` discovery contract (JSON) remains under the appropriate well-known/API routes via content negotiation; in browsers the AS/RS root SHALL serve a small operator/admin landing page that points the developer at their console origin. JSON discovery contracts remain available unchanged.
- Codify the public-site/operator-console split in `reference-surface-topology` and the new deployable shape in `reference-implementation-architecture`:
  - public surfaces SHALL NOT share an origin with a live operator dashboard by default;
  - the public site SHALL be deployable without a running reference instance;
  - operator deployments SHALL be able to disable the public-site bundle entirely;
  - the bare reference server root SHALL serve a browser-friendly landing page in addition to honoring JSON discovery contracts.
- pdpp.dev MAY include a mocked AS/RS reference demo (the existing `/sandbox` family, mock-backed) but SHALL NOT proxy to a hosted live reference instance.
- Do NOT in this change: adopt Turborepo, rename `reference-implementation/` to `apps/reference/`, or change AS/RS wire contracts. Those follow as sibling changes when this lands.

## Capabilities

### Modified Capabilities

- `reference-surface-topology` — codifies the public-site / operator-console split, the deployment topologies (`apps/site` standalone, `apps/console` + reference server, both together), and the operator-friendly bare-AS/RS browser landing page.
- `reference-implementation-architecture` — replaces "the website is a downstream consumer" wording (which assumed a single `apps/web`) with the two-Next-apps deployable shape, and acknowledges `packages/operator-ui` as the shared component substrate. Also retargets the residual `apps/web` references in the forkable-substrate requirement, the semantic-retrieval dashboard `rs-client.ts` path (now `apps/console`), the operation-module discovery-boundary forbidden-import specifier (now `apps/site`, matching the retargeted `operation-boundary.js` needle), and the `packages/remote-surface` import-boundary guards (now name `apps/site`/`apps/console`) so they stay true after `apps/web` is deleted.
- `reference-implementation-governance` — retargets the root/public spec-publication contract from the legacy `apps/web/content/docs` tree to the public-site `apps/site/content/docs` tree, and retargets the supplemental-notes rendering scenario from `apps/web` to the public-site deployable.
- `reference-web-bridge-contract` — retargets the mock-sandbox bridge-route ownership from `apps/web` to the public-site deployable (`apps/site`), so the sandbox-only/non-authoritative contract stays true after `apps/web` is deleted.

### Added Capabilities

- None. The split refines existing capabilities rather than introducing new ones.

### Removed Capabilities

- None.

## Impact

- `apps/web/` — to be split into `apps/site/` (public) and `apps/console/` (operator + BFF). This proposal does not perform the split; it authorizes it.
- `apps/web/src/proxy.ts` — to move to `apps/console/src/proxy.ts` whole, then have public-site matchers pruned in a follow-up commit.
- `packages/operator-ui/` — new private workspace package extracted from the components shared between `/sandbox` and `/dashboard`. (`packages/operator/` currently a placeholder package may absorb or be superseded by this.)
- `reference-implementation/server/index.js` — root `/` handler gains content-negotiated HTML fallback (browser → operator landing page; JSON Accept → existing discovery JSON). Existing well-known/API discovery routes are unchanged.
- `docker-compose.yml` — the `web` image becomes the `apps/console` image; an `apps/site` image is published separately for pdpp.dev (not required for self-hosters).
- `pnpm-workspace.yaml` — `apps/site`, `apps/console`, `packages/operator-ui` enter the workspace; `apps/web` is removed once migration completes.
- Root `package.json` scripts — `pnpm dev` boots `reference-implementation` + `apps/console`; `pnpm site:dev` boots `apps/site` only; `pnpm dev:full` boots everything.
- `openspec/specs/reference-implementation-governance/spec.md` — spec-publication governance follows the post-split public docs tree (`apps/site/content/docs`) instead of the legacy combined app tree, and the supplemental-notes rendering scenario names the public-site deployable instead of `apps/web`.
- `openspec/specs/reference-implementation-architecture/spec.md` — the forkable-substrate requirement, the semantic-retrieval dashboard `rs-client.ts` callsite, and the `packages/remote-surface` import-boundary guards stop naming `apps/web` and instead name the post-split deployables, so deleting `apps/web` does not leave the architecture spec referencing a nonexistent directory.
- `openspec/specs/reference-web-bridge-contract/spec.md` — the mock-sandbox bridge-route contract names the public-site deployable (`apps/site`) instead of `apps/web`.
- No protocol wire-format change. No grant/manifest/schema change. No new external runtime dependency.
- Sibling change `adopt-turborepo-task-graph` (recommended) lands on top of this split. Optional follow-up `relocate-reference-implementation-to-apps` is deferred.
