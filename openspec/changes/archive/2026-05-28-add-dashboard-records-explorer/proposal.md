## Why

The reference dashboard exposes records through two narrow surfaces: a connector index (`/dashboard/records`) and a per-stream table (`/dashboard/records/[connector]/[stream]`). Both are vertical: pick a connector, then a stream, then read rows. Owners who want to look across connections — "what happened today across all my data," "what does Gmail and Slack look like for this person," "what records carry the word _payroll_" — have to reverse-engineer the navigation, and the unified search page (`/dashboard/search`) collapses results into a single text-snippet list with no shape, no faceting, and no connection-aware framing.

The owner needs a query-driven canvas that treats every owner-visible stream as one searchable substrate, surfaces facets (connection, stream, recency), keeps record peek inline so they can keep scanning, and stays honest about which records came from which connection — not which connector type.

## What Changes

- Add a new operator-console page at `/dashboard/records/explorer` rendering a query-driven records canvas.
- Add a `Records` subnav entry pointing to the new page (alongside `Connectors` and `Timeline`).
- The page reads exclusively through existing typed wrappers in `apps/web/src/app/dashboard/lib/rs-client.ts` and `ref-client.ts`: connection summaries via `listConnectorSummaries`, lexical/hybrid search via `searchRecordsLexical` / `searchRecordsHybrid` (with capability probe), record reads via `getRecord`, and connector manifests via `listConnectorManifests`.
- Connection identity is preserved: facets and result rows are keyed on `connection_id`, never collapsed to connector type. Multiple Gmail or GitHub connections appear as distinct rows.
- A right-side peek surface renders the selected record's payload alongside the exact GET URL the dashboard used to read it, mirroring the `_ref` honesty pattern already used by the timeline peek.
- The page degrades gracefully: empty query renders a "recent across all connections" feed sourced from existing connection summaries plus a stream/connection facet line. No new RS endpoints are introduced.
- The Explorer does not replace `/dashboard/search` (which carries artifact spine results — traces/grants/runs) or the per-stream record table; it sits between them as the records-only browsing surface.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects the live `/dashboard` operator console only. No change to the sandbox shell, the protocol, the public RS contract, or `_ref` surface.
- Ships in both `apps/web` and `apps/console`. The default compose service is still named `web` for compatibility, but `docker-compose.yml` builds the root `Dockerfile` target `console`, which packages `apps/console` and powers the reference deployment at `pdpp.vivid.fish`. Therefore the Explorer source must live under `apps/console` for the page to reach the live operator console. The duplication mirrors the existing dashboard pattern until the planned shared `packages/operator-ui` extraction (tracked under `split-public-site/operator-console`) lands.
- Uses existing RS endpoints (`GET /v1/search`, `GET /v1/search/hybrid`, `GET /v1/streams/:stream/records/:id`) and existing `_ref` connection summaries.
- No new owner-token scope, no new connector-side behavior, no new manifest fields.
