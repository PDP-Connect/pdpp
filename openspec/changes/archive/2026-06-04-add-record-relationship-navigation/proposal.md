## Why

The reference implementation already enforces a manifest-declared, grant-scoped, one-hop `expand[]` contract on `GET /v1/streams/<s>/records[/{key}]` (see `openspec/specs/reference-implementation-architecture/spec.md` "Public record expansion" and the archived 2026-04-24 and 2026-05-28 changes). Two gaps make that contract unusable for an operator inspecting their own data:

- No first-party connector manifest declares any `relationships[]` or `query.expand[]` entries, so `expand_capabilities` is always empty on live streams and the contract has zero live coverage.
- The operator console `/dashboard/records/<connection>/<stream>/<recordKey>` page renders a record as raw JSON. Foreign-key-shaped values (for example a GitHub issue's `repository_id`) appear as unlinked text, with no path to the related record's detail page.

The reference must let an operator navigate from a record to its manifest-declared related records without inventing schema heuristics, without changing the protocol's one-hop discipline, and without claiming hosted-service semantics. Prior art (Stripe expansion, JSON:API `include` + `relationships`, PostgREST resource embedding, Airtable linked records, Notion relation properties) is captured in `docs/research/record-relationship-navigation-prior-art-2026-06-04.md`.

The existing join is parent-to-child: hydration filters the **child** stream's declared `foreign_key` against the current page of **parent** record keys (`WHERE child.<foreign_key> IN (…parent keys…)`; see `reference-implementation/server/record-expand-helpers.js` and the "Expansion pushes child-stream narrowing into SQL" scenario in the durable spec). The `foreign_key` therefore lives on the child record and holds the **parent's** key — it is not the child's own record key. This change names that field precisely so a console can build correct navigation, and it deliberately scopes the GitHub backfill to the one join that satisfies the existing manifest-validation rules.

## What Changes

- Restate that **all** navigable record relationships SHALL be manifest-declared. Loose foreign-key heuristics (any `*_id` looks like a link) remain explicitly out of scope.
- Reify relationship-target naming on `expand_capabilities` entries so a console (and any other read client) can decide, **before issuing a request**, which relations are navigable under the current grant. The current `granted`/`usable`/`reason` fields stay; this change adds two required, precisely-named fields:
  - `target_stream` — the related **child** stream the relation points at (equal to the value exposed today as `stream`).
  - `child_parent_key_field` — the field **on the child record** whose value holds the **parent** record's key (the same field the manifest declares as `foreign_key`). The reference keeps emitting `foreign_key` as a back-compat alias. This name avoids the v1 conflation that treated the child's foreign-key field as if it identified the child/target record.
- Add a normative envelope rule for "the link points at data that is not currently readable": the relation entry SHALL still appear in `expand_capabilities` with `usable: false` and a `reason` enum value (`related_stream_not_granted`, `related_stream_unknown`, `related_stream_not_loaded`) the console can render as a calm advisory, instead of being silently omitted. The `related_stream_not_granted` value matches what the server already emits today.
- Add operator-console requirements to the `reference-implementation-architecture` capability for cross-record navigation:
  - On the record detail page, a declared `has_one` relation SHALL render as a link to the related **child** record's detail page, and a declared `has_many` relation SHALL render a link to the related child stream's **list page filtered by `child_parent_key_field` = parent record key** (the children, not a single child detail URL built from the parent key).
  - A field on a child record that matches the `child_parent_key_field` of a declared forward relation SHALL render as a link to the **parent** record's detail page (the parent keyed by that field's value), as a console-only affordance.
  - Relations whose `usable` flag is `false` SHALL render as inert text with the manifest-supplied reason exposed as a tooltip-style advisory (no error toast).
  - The console SHALL discover relations from `expand_capabilities` and SHALL NOT introduce client-side heuristics over the raw payload.
- Declare the one first-party GitHub manifest relationship that the existing manifest validator accepts today: `user → user_stats` (has_many, `foreign_key=user_id`). `user_id` is a top-level, required property of the `user_stats` child schema, so it satisfies the existing rule that a relation's `foreign_key` be a required top-level child property.
- Explicitly **do not** declare `repositories → issues` or `repositories → pull_requests` in this change. Those joins would have `foreign_key=repository_id`, but `repository_id` is nullable and not a required property on the `issues`/`pull_requests` child schemas, so they fail the existing manifest-validation rule. Enabling them needs a separate change that first makes the child parent-key field required (or relaxes the rule with an explicit absent-key policy). The currently-absent `commits` stream remains undeclared.
- Keep everything else out of scope: reverse / belongs-to *server* expansion, multi-hop / dotted include paths, edge-typed metadata, cross-connector linkage, attachment byte hydration, and any backfill of other connectors (Gmail and Slack already declare their own expansions; Chase, USAA, Reddit, ChatGPT, YNAB, Claude Code remain untouched). Those become follow-up slices.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture` — adds normative requirements on `expand_capabilities` target naming (`target_stream`, `child_parent_key_field`), the unreadable-target envelope, the GitHub `user → user_stats` relationship declaration, and operator-console record-detail / record-list relationship navigation. The operator console requirements land here (next to the existing public expansion requirements) rather than in a notification-scoped capability, because record-page relationship navigation is part of the records read surface this capability already governs.

### Removed Capabilities

- None.

## Impact

- Affected public surface: `GET /v1/streams/<s>` (`expand_capabilities` shape gains required `target_stream` and `child_parent_key_field`, plus the unreadable-target presence rule). `GET /v1/streams/<s>/records[/{key}]?expand=…` request/response semantics are unchanged.
- Affected metadata surface: `packages/reference-contract/src/public/index.ts` — the `expand_capabilities` items schema (`target_stream`, `child_parent_key_field` become required; `reason` gains a documented enum). `target_stream` and `foreign_key` already exist in the schema as optional properties.
- Affected server builder: `reference-implementation/server/index.js` `buildExpandCapabilities` — emit `target_stream` and `child_parent_key_field` (mirroring `foreign_key`) and emit declared-but-unreadable entries with the `reason` enum. The current builder emits `stream`, `foreign_key`, and `reason: 'related_stream_not_granted'` for not-granted targets.
- Affected manifest surface: GitHub connector manifest `user` stream gains `relationships[]` + `query.expand[]` entries for `user_stats`. No other GitHub stream and no other connector is touched in this change.
- Affected operator console: `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` and `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx` gain a relationship-rendering helper and a relations chip strip. No new route segments. No new owner-auth surfaces.
- No new dependencies, storage tables, blob semantics, search endpoints, timeline endpoints, or new query grammar are introduced. The `has_many` console navigation reuses the existing `filter[<field>]` capability; it does not define new query grammar.
- No protocol semantics in `spec-*.md` change. PDPP Core remains a consent/disclosure protocol; this change refines reference-implementation behavior for an existing one-hop expansion contract.
