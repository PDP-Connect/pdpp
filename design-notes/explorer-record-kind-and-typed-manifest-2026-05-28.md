# Explorer record-kind tags and the typed-manifest-schema gap

Status: captured
Owner: reference implementation owner
Created: 2026-05-28
Updated: 2026-05-28
Related: openspec/changes/archive/2026-05-28-add-dashboard-records-explorer/design.md, apps/web/src/app/dashboard/lib/record-kind.ts, apps/web/src/app/dashboard/lib/record-preview.ts, apps/web/src/app/dashboard/lib/timeline-summaries.ts, docs/voice-and-framing.md

## Question

The designer's Explorer dispatched type-aware record cards (message / money /
photo / event / titled / generic) from per-field schema signals. The reference
cannot do that faithfully today because the public read contract does not carry
typed manifest field schemas. What is the honest interim, and what would the
full version require?

## Context

`add-dashboard-records-explorer/design.md` deferred type-aware cards with the
rationale: "Today's `ConnectorManifest.streams` is `Array<{ name, [k: string]:
unknown }>` - manifests carry stream names but not the typed-field schema the
dispatch needs. Building cards on top of inferred field names would lock the
dashboard into connector-specific heuristics."

That deferral left the Explorer feed as flat rows whose one-line summary came
from `timeline-summaries.ts`. In practice the summarizer's fallback was too
narrow: demo and real connectors that label money fields `amount_cents` /
`gross_pay_cents` and the counterparty `merchant` (rather than `amount` /
`description` / `payee_name`) fell all the way through to `firstString`, which
picked the record's ISO timestamp. The sandbox Explorer therefore rendered
`fabrikam_bank_demo transactions 2026-04-22T13:42:00Z` - a bare timestamp as
the "summary" - which is the most visible reason `/explore` did not look like
the design.

This lane closed the visual gap without a backend change:

- `apps/web/src/app/dashboard/lib/record-kind.ts` (mirrored to `apps/console`)
  derives a coarse `kind` from signals every feed row already has: the
  `connector::stream` pair and, when the lens holds the record body (recency /
  time-range), its field names. Search hits carry only a snippet, so their kind
  is stream-name-only and degrades to `generic`. A strong money-field signal
  (`*_cents`, `amount`) overrides a weak stream-name guess; a title/message
  field only promotes an otherwise-unclassifiable stream.
- The Explorer row renders a type-aware card with a small left-rail accent and
  a kind-specific body when the record body is already in hand: money rows can
  lead with amount + merchant, message rows with author + body, event rows with
  time + title, and titled rows with a primary title. Search hits and
  unclassifiable rows fall back to the existing one-line summary.
- `timeline-summaries.ts` broadened its money/title fallback so money and
  titled rows surface their identifying fields (amount + merchant, document
  kind, provider name) instead of a timestamp. This also improves the shared
  timeline and search summaries by construction.
- `record-preview.ts` is the presentation-only seam for these cards. It reads
  only the record body that the recency/time-range feed already fetched, writes
  nothing back, and degrades to absent whenever it cannot extract a useful
  preview.

`kind` is presentation metadata only. It is never written back, never sent to
the resource server, and never treated as a manifest field. It is the same
class of hand-picked heuristic the one-line summarizer already used - a "what
is this record" read, not a protocol claim.

## Stakes

The interim is honest but heuristic. It cannot:

- distinguish field-level shapes the design used for richer cards (a `currency`
  field vs. a generic number, a `person` vs. a `string`, a `blob`/image);
- render the design's photo tiles, money cards with debit/credit affordances,
  or message bubbles, because those need declared field types and the record
  body, neither of which is uniformly available (search hits have no body);
- power "type"-based facets or grant-scoped field projection.

The full version the design assumed requires typed manifest stream schemas:
`stream.schema.fields[]` with a declared `type` (`currency`, `timestamp`,
`person`, `blob`, ...) and - for the owner-facing grant-projection demo, which is
out of scope for the operator console - a per-field `granted` flag. Notably the
**sandbox demo manifests already carry** `type` and `semantic_class` per field;
the live `ConnectorManifest.streams` type and real connector manifests do not.
That asymmetry is the concrete contract gap.

A typed field schema is a durable manifest/read-contract change. It would let
the reference replace the `record-kind.ts` heuristic with a declared
`field.type`, support real type-aware cards, and align the live surface with the
shape the sandbox already encodes. It touches the manifest schema, the `_ref`
manifest surface, and the canonical public read contract - so it must go through
OpenSpec, not UI code.

## Current Leaning

Keep the heuristic `record-kind.ts` as the operator-console interim. It is
robust by construction (derives from stream/field signals, generalizes to
unknown connectors, degrades to `generic`) and adds no backend surface.

Promote a typed-manifest-stream-schema change to OpenSpec when the Explorer
needs declared field types, type facets, photo/blob cards, grant-scoped field
projection, or any card behavior that cannot be derived from a body the feed
already holds. Scope it as: declare `streams[].schema.fields[]` with a `type`
enum on the manifest, expose it through the `_ref` manifest surface and the
canonical read contract's capability discovery, and migrate `record-kind.ts` /
`record-preview.ts` consumers to the declared type with the heuristic as a
fallback for connectors that have not yet declared a schema. Align the live
`ConnectorManifest` type with the schema the sandbox demo manifests already
use.

## Promotion Trigger

Promote to OpenSpec before implementing any of:

- a `type` (or equivalent) field on manifest stream-field declarations;
- exposing per-field types through `_ref` or the public read contract;
- type-aware record cards, type-based facets, or grant-scoped field projection
  in any Explorer surface that relies on declared (not inferred) field types or
  requires fetching new fields/relations solely for presentation.

The heuristic kind/card preview shipped in this lane is explicitly NOT a
promotion trigger: it invents no contract noun and reads only data the feed
already has.

## Decision Log

- 2026-05-28: Captured after closing the Explorer visual-alignment gap. Shipped
  a heuristic `record-kind.ts` kind tag + broadened money/title summaries in
  `apps/web` and `apps/console` (no backend change). Identified typed manifest
  stream-field schemas as the durable contract gap that blocks the fully
  designed type-aware Explorer, with the sandbox demo manifests already carrying
  the `type`/`semantic_class` shape the live manifest type lacks. Left as
  `captured` pending owner prioritization; not promoted to OpenSpec in this lane
  because no contract was changed.
- 2026-05-29: Extended the same presentation-only seam from kind tags into
  structured card previews for recency/time-range rows in `apps/web` and
  `apps/console`. The live and sandbox Explorer still use only existing read
  responses; search hits still fall back to snippets. This remains below the
  OpenSpec promotion threshold until declared field schemas, type facets,
  relation fetches, or new read capabilities are introduced.
