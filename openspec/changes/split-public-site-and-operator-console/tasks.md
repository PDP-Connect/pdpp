## 1. Spec deltas and design lineage

- [ ] 1.1 Land this proposal, design, and the two spec deltas (`reference-surface-topology`, `reference-implementation-architecture`) as a reviewable artifact set.
- [ ] 1.2 Update `design-notes/public-site-vs-reference-server-split-2026-05-21.md` to status `decided` once the change is merged, linking back to this OpenSpec change.
- [ ] 1.3 Run `openspec validate split-public-site-and-operator-console --strict` and `openspec validate --all --strict`.

## 2. Extract `packages/operator-ui` (no app split yet)

- [ ] 2.1 Inventory components reused between `apps/web/src/app/sandbox/**` and `apps/web/src/app/dashboard/**`. Confirm coverage of records, search, grants, runs, traces, deployment, timelines.
- [ ] 2.2 Create `packages/operator-ui/` as a private pnpm workspace package. Add to `pnpm-workspace.yaml`.
- [ ] 2.3 Move the shared feature components and the `DashboardDataSource` interface into `packages/operator-ui/`. Update both `/sandbox` and `/dashboard` imports to consume the package.
- [ ] 2.4 Decide whether to absorb or remove the existing `packages/operator/` placeholder. Record the decision in the workstream report.
- [ ] 2.5 Verify both `/sandbox/**` and `/dashboard/**` still render and behave identically in `apps/web`. Run `pnpm --dir apps/web run types:check`, `pnpm --dir apps/web run check`, and `pnpm --dir apps/web run build`.

## 3. Create `apps/console` (operator surface + BFF)

- [x] 3.1 Copy `apps/web` to `apps/console`. Add to `pnpm-workspace.yaml`.
- [x] 3.2 In `apps/console`, remove public-site routes: `/`, `/docs/**`, `/reference/**`, `/llms*`, `/planning/**`, `/design`, `/palette`. Keep `/dashboard/**` and the API/BFF surface.
- [x] 3.3 Verify `apps/web/src/proxy.ts` was moved (not copied) to `apps/console/src/proxy.ts` and prune any public-site matchers in a second commit. (Public-site matchers and sandbox/docs branches pruned in Tranche C; the eventual move-not-copy completes when apps/web → apps/site lands.)
- [ ] 3.4 Confirm `/dashboard/**` renders end-to-end against a locally running `reference-implementation`. Owner-session gating and CSRF behavior SHALL be byte-identical to `apps/web`. (Build/typegen verified in CI; full live owner-session smoke deferred to owner-run validation.)
- [x] 3.5 Run `pnpm --dir apps/console run types:check`, `pnpm --dir apps/console run check`, and `pnpm --dir apps/console run build`. (types:check + build pass. `check` mirrors apps/web's pre-existing formatting failures — not newly introduced.)

## 4. Trim `apps/web` into `apps/site` (public surface only)

- [ ] 4.1 Rename `apps/web/` to `apps/site/` (or copy to `apps/site/` and remove `apps/web/` once tasks 3 and 4 are stable).
- [ ] 4.2 Remove `/dashboard/**`, the BFF/proxy module, and any server-only imports that pulled the BFF into `apps/site`.
- [ ] 4.3 Verify `/`, `/docs/**`, `/reference/**`, `/sandbox/**`, `/planning/**`, `/design`, `/palette`, `/llms*` still render. The mock sandbox SHALL keep working without any reference-implementation runtime.
- [ ] 4.4 Verify `apps/site` builds statically with `pnpm --dir apps/site run build`. The build SHALL NOT require `reference-implementation` to be running.
- [ ] 4.5 Confirm cross-surface links from `apps/site` to a local console use a documented `localhost:3002` (or operator-supplied) origin, not a `apps/site` BFF.

## 5. Reference server: content-negotiated `/`

- [x] 5.1 In `reference-implementation/server/index.js`, replace the AS root handler at line ~2072 so the existing JSON discovery response is served only when the client wants JSON (Accept header negotiation, content type, or explicit `?format=json`). Existing JSON-shaped clients SHALL get byte-identical bytes.
- [x] 5.2 For browsers (`Accept: text/html`), serve a small operator landing page produced by `reference-implementation/server/hosted-ui.js` (or an equivalent server-rendered HTML module). The page SHALL say what the AS/RS is, the configured console origin (if known) or `http://localhost:3002` as the default, and link to the existing well-known discovery endpoints.
- [x] 5.3 Apply the same browser-friendly landing-page treatment to the RS root handler (line ~5180 in current `index.js`). The RS landing page MAY share template with the AS landing page.
- [x] 5.4 Add tests proving (a) `Accept: application/json` returns the existing discovery JSON unchanged, (b) `Accept: text/html` returns HTML containing the configured console-origin link and links to the well-known discovery URLs, and (c) clients with no Accept header keep the existing default.
- [x] 5.5 Update reference docs (`reference-implementation/README.md` or equivalent) to describe the bare-server browser landing behavior.

## 6. Docker, docs, and contributor workflows

- [ ] 6.1 Update `docker-compose.yml`: the `web` service is renamed/repurposed to publish the `apps/console` image. The `apps/site` image is built but not required by the operator's default `docker compose up`.
- [ ] 6.2 Update `pnpm dev`, `pnpm site:dev`, and `pnpm dev:full` in the root `package.json` to match the contributor workflows in `design.md` §5.
- [ ] 6.3 Update repo README/quick-start, contributor docs, and `reference-implementation/README.md` to describe: (a) the two-app shape, (b) how to deploy `apps/site` alone, (c) how to deploy `apps/console` + `reference-implementation` alone, (d) where the console origin link comes from on the bare AS/RS landing page.
- [ ] 6.4 Remove `apps/web/` once tasks 2–5 are stable and verified.

## 7. Validation

- [ ] 7.1 Run `openspec validate split-public-site-and-operator-console --strict`.
- [ ] 7.2 Run `openspec validate --all --strict`.
- [ ] 7.3 Run `pnpm --dir apps/site run types:check`, `check`, and `build`.
- [ ] 7.4 Run `pnpm --dir apps/console run types:check`, `check`, and `build`.
- [ ] 7.5 Run targeted `reference-implementation` tests for the new content-negotiated root handlers: `pnpm --dir reference-implementation run verify` plus any new `node --test` files added in task 5.
- [ ] 7.6 Smoke `curl -H 'Accept: application/json' http://localhost:7662/` (and the RS port) and verify byte-identical existing discovery JSON.
- [ ] 7.7 Smoke `curl -H 'Accept: text/html' http://localhost:7662/` (and the RS port) and verify the operator landing page.
- [ ] 7.8 Smoke `apps/console` against the locally running `reference-implementation`: `/dashboard`, `/.well-known/oauth-authorization-server` (proxied), `/v1/streams` (proxied), and `_ref` timeline.
- [ ] 7.9 Smoke `apps/site` without any reference instance running: `/`, `/docs`, `/reference`, `/sandbox` (mock-backed), `/planning`.

## Acceptance checks (reproducible commands)

- `openspec validate split-public-site-and-operator-console --strict`
- `openspec validate --all --strict`
- `pnpm --dir apps/site run build` succeeds with no reference-implementation process running.
- `pnpm --dir apps/console run build` succeeds; the resulting container can serve `/dashboard` against a co-deployed `reference-implementation`.
- `curl -i -H 'Accept: application/json' http://localhost:7662/` returns the AS discovery JSON (byte-identical to today's behavior for that Accept header).
- `curl -i -H 'Accept: text/html' http://localhost:7662/` returns 200 + `Content-Type: text/html` + a page that names the AS/RS, names the configured (or default) console origin, and links to `/.well-known/oauth-authorization-server`.
- `apps/web/` no longer exists in the working tree after task 6.4.
- The mock sandbox at `/sandbox/**` on `apps/site` renders without any AS/RS process running.
