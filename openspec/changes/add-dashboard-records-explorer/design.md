# Design — Dashboard records explorer

## Classification under `canonicalize-public-read-contract`

The Explorer is a **consumer / diagnostic surface**, not a backend contract author. It must consume the canonical public read contract — identity, envelopes, warnings, capability discovery — and never invent backend nouns of its own.

The canonical contract explicitly states: "No Explorer-specific backend identifiers, peek keys, or UI tabs as public contract nouns." It also names this change as the consumer that must simplify once search hits carry connection identity directly.

Implications for this change:

- The peek-key shape (`<connector>::<stream>::<id>`) and the chip URL params (`connection=`, `stream=`) are Explorer-internal UI state, not PDPP protocol nouns. They MUST NOT be promoted into the public read contract or `_ref` surface.
- Connection identity on rows and chips MUST flow from the canonical `connection_id` (with `connector_instance_id` only as a deprecated alias during the migration window), not from Explorer-side inference. Once the canonical contract's identity work lands end-to-end, the Explorer's post-fetch attribution scaffolding should simplify (`tasks.md` item 6.1 in `canonicalize-public-read-contract` tracks this).
- The Explorer SHOULD consume canonical envelopes (`data` / `links` / `meta` / `has_more`) and surface `meta.warnings` to the operator when present, rather than treating warnings as silent.
- Backend / API gaps listed below (typed manifest schemas, stream `view` ids, cross-connection recent feed, record-time as first-class read field) remain design-note material; if any are promoted, they belong in `canonicalize-public-read-contract` (or a follow-on canonical change), not in this consumer surface.

No requirements are added or removed here. The Explorer remains a UI slice over canonical primitives.

## Context

A design bundle (`/tmp/designs/pdpp-explorer/`) proposed a single-canvas, query-driven explorer for the data-owner audience: chip+text filter bar runs the whole app, results reshape into a unified feed across every granted stream, type-aware cards dispatch from schema signals, and a peek pane shows the exact `GET /v1/streams/.../records/<id>` URL the dashboard used to read each record. The prototype is built on inline React+Babel against mocked grant/connection/schema data and assumes the owner has many granted connections.

That direction is right for a future data-owner Explorer product, but the design bundle invented several backend contracts the reference does not currently support (grant-scoped field projection, per-record schema fields with `granted: boolean`, in-stream `view`s as tabs, capability dispatch from typed schema fields). Those gaps are surfaced in `### Backend / API gaps surfaced` below as design-note material rather than implemented in the UI.

The honest first slice for the operator console is a records-only browsing surface keyed on the contracts we already have:

- `_ref/connectors` (connection summaries with connection identity preserved)
- `/v1/search`, `/v1/search/hybrid`, `/v1/search/semantic` (text retrieval)
- `/v1/streams`, `/v1/streams/:stream/records`, `/v1/streams/:stream/records/:id` (per-connection record read)
- `listConnectorManifests` from the polyfill-connectors package (declared streams and timestamp/cursor metadata)

## Decision

A new route at `/dashboard/records/explorer` rendering a server-component page with:

1. A query input that submits as a GET form (`?q=...`). Same shape as `/dashboard/search`, but the result rendering is records-only.
2. A "scope" facet line: chips for `connection` (one chip per `connection_id` in the current owner's `_ref/connectors` response, labeled by `display_name` falling back to `connector_id`) and `stream` (the union of stream names present in those connections). Chips are encoded as repeated `connection=<id>` and `stream=<name>` URL params.
3. A record feed: list of search hits when a query is present, otherwise a "recent across all visible connections" feed sourced from `listConnectorSummaries` + a small fan-out of `queryRecords(connector, stream, { limit: N })` for the last-touched streams of each visible connection. The fan-out is intentionally bounded (`MAX_FEED_CONNECTIONS * MAX_FEED_STREAMS_PER_CONNECTION`) so empty-query loads remain cheap.
4. Each feed row links to the existing `routes.record(connectorId, stream, recordId)` page. Selecting a row via `?peek=<connector>::<stream>::<id>` opens an inline peek panel showing the record JSON, the exact GET URL the dashboard used, and a link to the full record page.
5. Existing dashboard shell, brand tokens, primitives (`PageHeader`, `Section`, `DataList`, `Pager`, `FilterSummary`). No new design tokens.

The page is responsive: on mobile the peek replaces the feed (one column), on desktop ≥1280px the layout splits into feed + sticky peek (`SplitLayout`).

## Why a new route and not folding into `/dashboard/search`

`/dashboard/search` is the cross-artifact spine: it returns `traces`, `grants`, `runs`, and a single flat lexical record list. Owners use it to jump by ID. The records-only explorer is a different mode of use — broad scanning across connections, recency-first when empty, faceted by connection and stream. Folding the two would force the search page to grow modes, which contradicts the operator console's per-route specialization (overview / search / traces / grants / runs / records / schedules / deployment).

The Records subnav already has `Connectors` and `Timeline`; adding `Explorer` keeps records-shaped tools where owners look for them.

## Why connection-first

Owners can have multiple connections of the same connector type (two Gmail accounts, two GitHub orgs). The existing records index keys on `connection_id ?? connector_instance_id ?? connector_id`, and the `_ref/connectors` summary returns `connection_id`, `display_name`, and `connector_display_name` per row. The explorer reuses that shape: facet chips list each distinct connection, not each distinct connector. Search-hit rows show `connector_id · stream`, with the connection inferred when the user adds a connection chip.

## Why no record-card dispatch in this slice

The design bundle's type-aware cards (message / money / photo / event / activity / reader / location / generic) depend on per-stream schema fields with declared `type` (e.g. `currency`, `timestamp`, `person`, `blob`) and per-field `granted` flags. Today's `ConnectorManifest.streams` is `Array<{ name, [k: string]: unknown }>` — manifests carry stream names but not the typed-field schema the dispatch needs. Building cards on top of inferred field names (`amount`, `from`, `subject`) would lock the dashboard into connector-specific heuristics and contradict the design bundle's own principle ("no connector branches").

The first slice therefore renders a generic record row (timestamp · connector · stream · snippet/summary) and the existing `summarize()` helper in `apps/web/src/app/dashboard/lib/timeline-summaries.ts`. Card dispatch is a follow-on once typed manifest schemas exist (design-note candidate, captured below).

## Why no inline field projection / grant chip

The design bundle's grant chip ("viewing as `client_id` · expires in 14d · projected to 6 fields") is owner-perspective: it dramatizes what a third-party client would see. The operator console reads as the owner under an owner token, not under a grant; there is no client to project for. Surfacing a fake projection toggle here would mislead. The grant-projection demo belongs in a future data-owner-facing Explorer that consumes a real client-scoped grant, not in the operator console.

## What is in scope for this slice

- `/dashboard/records/explorer` route, server-component page.
- `RecordsExplorerView` client/server-shared view component.
- `RecordsExplorerPeek` panel (server component, sourced from `getRecord`).
- Subnav entry under the existing `Records` group.
- Connection-aware facet chips encoded as URL params.
- A targeted test for: route resolves, query-param round-trips preserve connection identity, peek URL exposes the exact `GET` path used.

## What is out of scope

- Type-aware record cards (needs typed manifest schema).
- Stream `view` tabs (needs `_ref` or RS surface that exposes manifest-declared `view` ids; not present today).
- Inline blob rendering / image cards (needs `fetch_blob` integration; out of scope for the operator console, deferred to a future data-owner Explorer).
- Semantic-only retrieval mode toggle (the dashboard already runs a hybrid+semantic uplift in `/dashboard/search`; duplicating it here would expand surface for marginal value in v1).
- Grant chip and field projection toggle (no owner-side grant context).
- Day-strip heatmap, "On this day" memory cards, entity rails (Immich Faces) — all depend on schema metadata the manifests do not yet declare.

## Backend / API gaps surfaced

Captured here as design-note material; promote to OpenSpec only when actionable:

1. **Typed manifest stream schemas.** The design bundle assumes `stream.schema.fields[].type` (`currency`, `timestamp`, `person`, `blob`, etc.) and `field.granted` flags. Manifests today declare `consent_time_field` / `cursor_field` per stream but not a full typed schema. Card dispatch, "type"-based facets, and grant projection all depend on this.
2. **Stream-level `view` ids.** MCP exposes `query_records({ view })`; the RS supports it; manifests do not yet advertise the available views in a machine-readable shape the dashboard could render as tabs.
3. **Cross-connection aggregate count.** The empty-query "recent" feed has to fan out per-connection. A cheap `_ref/records/recent?limit=N` over all owner-visible connections would replace the bounded fan-out cleanly. Not blocking.
4. **Record-time as first-class read field.** The existing search route already builds a `searchTimestampMetadata` lookup to pick `consent_time_field` over `emitted_at`. The explorer reuses that helper rather than duplicating it.

These belong in a future `design-note` under `design-notes/`, not in this change's spec delta.

## Acceptance checks

- `/dashboard/records/explorer` renders the shell with `active="records"` and the new subnav entry highlighted appropriately.
- Empty query renders a recent-records feed sourced from existing `_ref/connectors` + bounded `queryRecords` fan-out, with one facet chip per distinct `connection_id`.
- A non-empty query routes through `searchRecordsHybrid` when advertised, falling back to `searchRecordsLexical`. The Explorer does not call any RS endpoint not already used by `/dashboard/search`.
- Selecting a feed row sets `?peek=<connector>::<stream>::<recordId>` and renders the peek panel with the exact GET URL.
- Connection chips are URL-stable: copying the URL of a filtered view restores the same chips.
- `pnpm -C apps/web run types:check` passes.
- `openspec validate add-dashboard-records-explorer --strict` passes.
