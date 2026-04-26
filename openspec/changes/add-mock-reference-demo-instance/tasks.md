## 1. Demo Data And Response Builders

- [x] 1.1 Move the existing client-side walkthrough to `/sandbox/walkthrough` or preserve it as a secondary route/panel so `/sandbox` can become the demo instance entry point.
- [x] 1.2 Create a typed fictional demo dataset covering at least three connectors, multiple streams, records, schema metadata, grants, runs, traces, capabilities, search fixtures, and revoked/refused evidence.
- [x] 1.3 Add pure response-builder functions for demo list pagination, schema graph, stream metadata, records, search, well-known metadata, `_ref` summaries, and timelines.
- [x] 1.4 Add tests proving seeded data is deterministic, contains no obvious real credentials/tokens/private domains, and response builders return stable shapes.

## 2. Demo API Routes

- [x] 2.1 Implement sandbox-prefixed well-known routes for mock AS and RS metadata.
- [x] 2.2 Implement `/sandbox/v1/schema`, `/sandbox/v1/streams`, `/sandbox/v1/streams/[stream]`, `/sandbox/v1/streams/[stream]/records`, and `/sandbox/v1/streams/[stream]/records/[recordId]`.
- [x] 2.3 Implement `/sandbox/v1/search` over the seeded records with deterministic snippets and list envelopes.
- [x] 2.4 Implement `/sandbox/_ref/traces`, `/sandbox/_ref/traces/[traceId]`, `/sandbox/_ref/grants`, `/sandbox/_ref/grants/[grantId]/timeline`, `/sandbox/_ref/runs`, `/sandbox/_ref/runs/[runId]/timeline`, and `/sandbox/_ref/dataset/summary`.
- [x] 2.5 Add route-handler tests or direct handler/client tests for representative success, not-found, pagination, and search paths.

## 3. Demo Dashboard Surface

- [x] 3.1 Build a sandbox-specific dashboard shell with persistent "Demo instance / fictional data" labeling and no live owner-auth dependency.
- [x] 3.2 Implement `/sandbox` as the demo overview, with clear CTA paths to records, search, grants, runs, traces, deployment/capabilities, API examples, and the guided walkthrough.
- [x] 3.3 Implement records pages that browse seeded connectors, streams, record lists, and record detail views.
- [x] 3.4 Implement search, grants, runs, traces, and deployment/capabilities pages backed by sandbox demo clients or response builders.
- [x] 3.5 Add a reset control or reset affordance that restores local UI state to the seeded initial view without implying server-side personal data exists.
- [x] 3.6 Ensure `/dashboard/**` live behavior remains unchanged and does not fall back to sandbox data.

## 4. Public Evidence And Copy

- [x] 4.1 Update `/reference` and `/reference/coverage` so the mock reference demo instance is listed as demonstrated evidence without overstating conformance.
- [x] 4.2 Update sandbox copy so visitors understand the distinction between static walkthrough, mock reference demo instance, live local dashboard, and protocol docs.
- [x] 4.3 Add copyable API examples for the demo endpoints and links to the normative docs where practical.
- [x] 4.4 Update the workstream merge report with exact demo URLs, API examples, validation commands, and residual risks.

## 5. Validation

- [x] 5.1 Run `openspec validate add-mock-reference-demo-instance --strict`.
- [x] 5.2 Run `openspec validate --all --strict`.
- [x] 5.3 Run sandbox/demo unit or route tests.
- [x] 5.4 Run `pnpm --dir apps/web run types:check`.
- [x] 5.5 Run `pnpm --dir apps/web run check`.
- [x] 5.6 Run `pnpm --dir apps/web run build`.
- [x] 5.7 If practical, run the built app and smoke `GET /sandbox`, `GET /sandbox/v1/schema`, `GET /sandbox/v1/search?q=...`, and one `_ref` timeline route.

## 6. Corrective Tranche: Real Dashboard With Mock AS/RS

- [x] 6.1 Audit `/dashboard/**` pages and data clients to define the smallest typed `DashboardDataSource` seam that covers overview, records, search, grants, runs, traces, deployment, and timelines without weakening owner auth.
- [x] 6.2 Extract shared dashboard feature components for the core journey so `/dashboard/**` and `/sandbox/**` can bind the same UI to different data sources.
- [x] 6.3 Implement the live data source by wrapping the existing owner-authenticated AS/RS clients with no behavior change.
- [x] 6.4 Implement the sandbox data source over the deterministic seeded dataset and mock AS/RS response builders.
- [x] 6.5 Replace forked sandbox records/search/grants/runs/traces/deployment pages with the shared dashboard feature components bound to the sandbox data source.
- [x] 6.6 Keep `/sandbox/api-examples` and `/sandbox/walkthrough` as supporting educational surfaces, not the primary demo instance.
- [x] 6.7 Add regression tests proving the same dashboard feature components render against both live-shaped fixture data and sandbox data, and that `/dashboard/**` never falls back to sandbox data.
- [x] 6.8 Run `openspec validate add-mock-reference-demo-instance --strict`, `openspec validate --all --strict`, sandbox route tests, dashboard feature tests, `pnpm --dir apps/web run types:check`, `pnpm --dir apps/web run check`, and `pnpm --dir apps/web run build`.
