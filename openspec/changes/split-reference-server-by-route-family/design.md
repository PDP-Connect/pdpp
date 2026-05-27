## Context

`reference-implementation/server/index.js` is 9,316 LOC and registers 111 HTTP route handlers across both the AS app (`buildAsApp`) and the RS app (`buildRsApp`). Per-operation business logic has already moved to `reference-implementation/operations/*` under the recently completed `complete-reference-operation-refactor`. What is left in `index.js` is HTTP wiring: `app.use(...)` middleware (request-id, reference-revision header, PDPP-Version negotiation, CSP/X-Frame-Options on AS), route-level owner/client auth, content negotiation, response writing, and concrete capability binding.

The audit (`tmp/workstreams/code-quality-deep-audit-report.md`) and the design note (`design-notes/server-index-split-and-js-to-ts-2026-05-27.md`) name the split as a P0/P1 construction-quality gap. Biome and `tsc --noEmit` already cover `server/**/*.ts`; extracted TS files participate automatically.

## Goals / Non-Goals

**Goals:**

- Mechanically split `index.js` HTTP wiring into per-family TypeScript adapter modules under `server/routes/<family>.ts`.
- Preserve all observable behaviour: middleware order, owner/client auth posture, request-id and trace propagation, headers (PDPP-Version, Reference-Revision, X-Frame-Options, CSP), content negotiation on `/`, response envelope shape, status codes, spine event emission.
- Keep `server/index.js` as the composition root; capability construction, store factories, controller wiring, `app.use(...)` global middleware, and the AS/RS app builders remain there until or unless a separate change moves them.
- Bring every extracted module under the existing Biome and `tsc --noEmit` gates with no `biome.jsonc` change unless required.

**Non-Goals:**

- Do not introduce a router/controller/repository/aggregate abstraction. The operations boundary already provides the right seam (see `design-notes/broad-storage-abstraction-2026-04-24.md` and the audit's "What NOT to do" list).
- Do not change the public route surface. No route renames, no method changes, no header changes, no response envelope changes, no status-code changes.
- Do not change `server/auth.js`, `server/records.js`, `server/postgres-storage.js`, or any other non-route module. Route adapters import existing functions; the family modules are wiring only.
- Do not touch the `isPostgresStorageBackend()` branches. They have their own design-deferred path (`broad-storage-abstraction-2026-04-24.md` → `complete-postgres-runtime-boundary`).
- Do not bundle a `.js → .ts` sweep of non-route files (e.g. `auth.js`, `records.js`). Those are 3,937 and 3,329 LOC respectively and need separate tranches.

## Decisions

1. **Adapters live under `server/routes/<family>.ts`, not a sibling top-level `routes/`.**
   These modules are HTTP/server adapters that bind to Express-shaped `app` instances. They sit alongside `server/index.js`, `server/transport.js`, `server/owner-auth.ts`, and other server-only wiring. Hoisting them to a sibling top-level `routes/` would split the server's wiring layer across two directories without any benefit; the operations layer already provides the cross-cutting boundary at `reference-implementation/operations/*`.

2. **Behaviour-preserving adapter split over the existing operations boundary.**
   The operations refactor already established the seam (`operations/*` for pure semantics; route handlers for HTTP wiring). Each extracted family imports the same operations and stores `index.js` does. No new controller layer, no new service object, no new repository, no new DDD aggregate.

3. **Each extracted file is `.ts` from the first commit.**
   Landing `.js` first would leave new modules un-gated by Biome and `tsc --noEmit`. The migration cost is small because each route is wiring (parameter parsing, capability dispatch, response writing) and the operations layer already exposes typed surfaces. Migrating in place is also unsafe; the family split is the natural per-file boundary.

4. **Shared mount context, only if it reduces parameter sprawl.**
   The route mount functions need access to `app`, the configured stores (consent, owner device auth, web push, device exporter, …), the controller, the owner-auth placeholder, the resolved provider name and reference revision, and a small set of feature flags (`nativeMode`, `dynamicClientRegistrationEnabled`). If passing those individually pushes a mount signature past ~6 parameters, the family adapter MAY accept a `RouteMountContext` interface so the call site at `index.js` remains readable. If the family adapter only needs `app` plus one or two helpers, the function signature MAY take them directly. Pick what reads naturally per family; do not invent a single one-size context type.

5. **Route-family taxonomy (pinned).**

   | Family | Adapter file | Approximate route count | Notes |
   | --- | --- | --- | --- |
   | Root + discovery | `server/routes/root-and-discovery.ts` | 5 — `GET /` (AS), `GET /` (RS), `GET /.well-known/oauth-authorization-server`, `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-protected-resource/mcp` | Content-negotiated landing; lowest behavioural risk. |
   | `_ref` ops | `server/routes/ref-operations.ts` | ≈55 routes under `/_ref/*` | Owner-session-gated diagnostic and operations routes; dataset summary/size, connectors, connections, schedules, deployment, device-exporters, traces/grants/runs/timelines, dataset rebuild/reconcile, search, schedules, clients. |
   | RS reads | `server/routes/rs-read.ts` | 11 routes under `/v1` reads | `/v1/connectors`, `/v1/schema`, `/v1/streams`, `/v1/streams/:stream`, `/v1/streams/:stream/aggregate`, `/v1/streams/:stream/records`, `/v1/streams/:stream/records/:id`, `/v1/search`, `/v1/search/semantic`, `/v1/search/hybrid`, `/v1/blobs/:blob_id`. |
   | RS mutations | `server/routes/rs-mutation.ts` | 7 routes | `POST /v1/blobs`, `DELETE /v1/streams/:stream/records`, `DELETE /v1/streams/:stream/records/:id`, `POST /v1/ingest/:stream`, `GET /v1/state/:connectorId`, `PUT /v1/state/:connectorId`, and the `event-subscriptions` cluster (currently 6 routes) is read+mutation but logically tracks under client event subscriptions — moves with `rs-mutation` unless the diff demands a sibling file. |
   | AS OAuth + consent + device | `server/routes/as-oauth.ts` | ≈14 routes | OAuth metadata, register/PAR/authorize/token, device authorize/approve/deny, consent approve/deny/exchange, grants revoke, introspect, agent-connect. Heavily coupled to `server/auth.js` (3,937 LOC). Tranche owner-approval gated. |
   | Run interaction | `server/routes/run-interaction.ts` | ≤2 routes | `POST /_ref/runs/:runId/interaction` and dev playground; excludes the streaming adapter routes already isolated in `server/streaming/routes.js`. |
   | Web push | `server/routes/web-push.ts` | 5 routes | `_ref/web-push/config`, `_ref/web-push/subscriptions` GET/POST/DELETE, `_ref/web-push/test`. |
   | Remote surface (n.eko) | `server/routes/remote-surface.ts` | ≤2 routes | Any non-streaming neko/browser surface routes; the streaming adapter (`server/streaming/routes.js`) already owns its slice. |
   | Source webhooks | `server/routes/source-webhooks.ts` | ≤2 routes | `POST /_ref/source-webhooks/:sourceId` ingress. |

   The numbers above are inventory estimates from `grep -nE "^[[:space:]]*app\\.(get|post|...)\\(" reference-implementation/server/index.js`. A specific family file MAY come in larger or smaller than the table; the acceptance bar is correctness and readability, not row count.

6. **Mount-point order is preserved.**
   `buildAsApp` and `buildRsApp` register routes in a specific order today. Each extracted family is mounted at the same point in the composition root where its routes are registered today. This avoids accidentally changing the resolution order between `/` and any specific deeper route, or between owner-auth-gated routes and unauthenticated discovery routes.

7. **`app.use(...)` global middleware stays in the composition root.**
   The AS and RS `app.use(...)` blocks (request-id, reference-revision header, PDPP-Version negotiation, CSP/X-Frame-Options on AS) remain in `index.js`. Family adapters compose route-level middleware (owner-session, owner-CSRF, client auth) but do not register global middleware. This is the contract Fastify enforces via `transport.js` (which throws on `app.use(path, fn)`).

8. **No reordering of middleware on a route, ever.**
   The transport's `registerRoute` runs route-specific middleware in the order they were passed, then transport-owned request validation if the operation id is on the allowlist (`wire-route-contract-validation`), then the handler. Each adapter preserves the exact `(middleware..., handler)` order present in `index.js` today.

9. **Stop-and-report on surprises.**
   If a family's extraction would (a) require changing `server/auth.js`, `server/records.js`, or another non-route file, (b) shift the position of an `app.use(...)` block, (c) interleave middleware in a different order, (d) collapse two routes into one, or (e) change any header, status code, or envelope shape — stop and report. Do not "clean up" while extracting.

## Risks / Trade-offs

- **Risk: a family adapter accidentally drops middleware or reorders auth.** → Mitigation: each family lands as one focused commit; existing route-behavior tests gate behaviour; targeted route-regression tests are added when an existing test does not cover a moved family.
- **Risk: OAuth/consent/device family is too large for a single commit because it shares state with `server/auth.js`.** → Accepted: tranche is deferred behind owner approval per design note. First tranches stop before `as-oauth.ts`.
- **Risk: extracting a route family introduces an awkward parameter list.** → Mitigation: per-family `RouteMountContext` interface, only when parameter sprawl exceeds ~6 arguments. Do not introduce a global mount-context type.
- **Risk: `server/index.js` shrinks faster than the composition root can absorb the new mount calls and starts to feel disjointed.** → Mitigation: composition root stays in `index.js` until a separate change moves it; this change does not relocate `buildAsApp`/`buildRsApp`.
- **Risk: type errors emerge when wiring uses `any` or untyped values from `server/auth.js`.** → Mitigation: `.ts` files MAY narrow at the boundary with explicit interfaces for the imported `.js` exports. Keep narrowing local to the family file; do not retrofit type annotations into `.js` files in this change.

## Migration Plan

1. Promote this design note into OpenSpec (this proposal).
2. Add `server/routes/root-and-discovery.ts` and mount it from `buildAsApp` and `buildRsApp`. Validate behaviour parity.
3. Add `server/routes/ref-operations.ts` and mount it from `buildAsApp`. Validate.
4. Add `server/routes/rs-read.ts` and mount it from `buildRsApp`. Validate.
5. Add `server/routes/rs-mutation.ts` and mount it from `buildRsApp`. Validate.
6. Add `server/routes/run-interaction.ts`, `server/routes/web-push.ts`, `server/routes/source-webhooks.ts`, `server/routes/remote-surface.ts`. Each is its own commit. Validate per commit.
7. Owner-gate `server/routes/as-oauth.ts` extraction. Do not merge without owner review because the auth coupling makes the diff large.
8. Each tranche runs `pnpm --dir reference-implementation run verify` (typecheck + targeted lint) plus `node --test` on the route-behaviour tests touching that family.
9. Final commit (sequence: end of tranche) re-runs `pnpm --dir reference-implementation run test` and confirms `openspec validate split-reference-server-by-route-family --strict`.

Rollback: each family extraction is one commit. If a parity regression appears, revert that commit; the composition root remains valid because `index.js` retains its full registration path until the matching extraction lands.

## Open Questions

- Whether `as-oauth.ts` lands as one file (≈14 routes, owner-approval gated) or splits further into `as-oauth-metadata.ts`, `as-oauth-consent.ts`, and `as-oauth-device.ts`. Resolution deferred until the first three families validate cleanly and the audit's `server/auth.js` coupling is re-examined.
- Whether `event-subscriptions/*` lands inside `rs-mutation.ts` or as a sibling `event-subscriptions.ts`. Default is `rs-mutation.ts` because the routes share auth posture and feature flag; a sibling file is reserved for diff-size relief.
- Whether `_ref` should split further (e.g. `ref-operations.ts` plus `ref-device-exporters.ts`). Default is one file; split only if the first extraction exceeds ~800 LOC after extracting helpers.
