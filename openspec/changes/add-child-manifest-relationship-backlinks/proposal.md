## Why

The companion change `add-record-relationship-navigation` defines operator-console relationship navigation entirely in terms of `expand_capabilities` returned by `GET /v1/streams/<parent>`. That envelope is only populated for the three first-party streams that enable `query.expand[]` (`gmail.messages`, `github.user`, `slack.messages`) — every other declared relationship is a child-side belongs-to edge the reference engine cannot serve forward (see the archived `2026-05-28-expand-first-party-parent-child-relations` audit, which classifies Chase, USAA, YNAB, ChatGPT, Anthropic, Claude Code, Codex, Amazon, DoorDash, HEB, Loom, WhatsApp, and the Slack belongs-to edges as reverse/belongs-to, "the current engine cannot serve them," "left as descriptive metadata").

Concretely: a Chase `transactions` record carries `account_id` (the parent `accounts` record key) via a manifest-declared `has_one` relationship on the **child** `transactions` stream. The `accounts` stream declares no `query.expand[]`, so it emits no `expand_capabilities`, so the spec-described back-link path (`findParentBackLink`, which reads parent-stream metadata) produces nothing. The operator inspecting a Chase transaction has no path to the related account record.

The reference implementation already closes this gap in code (commit `00a66cdd`, `childHasOneBackLinksFromManifest`): the operator console reads the **child stream's own declared `relationships[]`** from the bundled manifest and renders a link from the declared `foreign_key` value to the parent record's detail page. This affordance is shipped, unit-tested (18/18 in `apps/console/src/app/dashboard/records/lib/relationships.test.ts`), and manifest-grounded — it consults only declared relationships, never raw payload heuristics. But it is **not described by any OpenSpec change**, and it sits in tension with the companion change's normative clause that the console "SHALL discover these renderings exclusively from `expand_capabilities`." This change writes the affordance up so the contract matches the shipped reference behavior.

## What Changes

- Add a normative operator-console requirement: a child record's field that matches a `foreign_key` declared by a `has_one` relationship **on that child stream's own manifest entry** SHALL render as a link to the related parent record's detail page. The relationship structure SHALL come from the manifest declaration; the link target SHALL be the parent record keyed by the child field's value (the `foreign_key` value is the parent's record key, by the same key-field semantics the companion change establishes).
- Constrain the affordance to preserve the no-heuristics discipline: only manifest-declared `has_one` relationships with a non-empty `stream` and `foreign_key` produce links; `has_many` child relationships are not navigated this way (parent → filtered child list remains the `has_many` path); a field that is not covered by a declared `has_one` relationship renders as plain text.
- State explicitly that this is a **console-only** affordance and does **not** define server-side reverse expansion: `GET /v1/streams/<child>/records?expand=<parent_relation>` continues to fail with `invalid_expand`. It mirrors the companion change's D6 symmetric-linking principle, extended to relationships declared on the child rather than discovered from a parent's `expand_capabilities`.
- Record that this requirement **relaxes** the companion change's "exclusively from `expand_capabilities`" wording: child-to-parent links MAY also be sourced from the child stream's own declared `relationships[]`. The two changes touch the same capability; at archive time the companion change's "Operator console SHALL render manifest-declared parent links on the child record page" requirement and this requirement SHALL be folded into the durable spec as one coherent contract that names both sources (parent `expand_capabilities` and child-declared `relationships[]`).
- Pin the owner's Chase `transactions.account_id -> accounts` example as the proving scenario. The rule is generic; other connectors that declare child-side `has_one` relationships (USAA, YNAB, ChatGPT, Anthropic, Claude Code, Codex, Amazon, DoorDash, HEB, Loom, WhatsApp, Slack) ride the same rule without per-connector spec pins. No manifest is changed by this slice — the relationships already exist as declared descriptive metadata.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture` — adds one operator-console requirement for child-declared `has_one` parent back-links on the record detail page, alongside the relationship-navigation requirements introduced by the companion change `add-record-relationship-navigation`. No server, contract, or manifest behavior changes.

### Removed Capabilities

- None.

## Impact

- Affected operator console: `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx` and `apps/console/src/app/dashboard/records/lib/relationships.ts` (`childHasOneBackLinksFromManifest`). Both already implement this behavior at HEAD; this change documents the existing contract and adds no code.
- Affected manifest surface: none. The child-side `has_one` `relationships[]` entries (e.g. Chase `transactions -> accounts`) already exist as declared descriptive metadata and are unchanged.
- Affected public surface: none. `GET /v1/streams/<s>` `expand_capabilities`, `GET /v1/streams/<s>/records[/{key}]?expand=…`, and the grant model are unchanged. The affordance issues no `expand[]` request.
- No new dependencies, storage tables, blob semantics, search endpoints, query grammar, or owner-auth surfaces.
- No protocol semantics in `spec-*.md` change. PDPP Core remains a consent/disclosure protocol; this change documents reference-implementation operator-console behavior over manifest-declared relationships.
- Reconciliation note: this change and the un-archived `add-record-relationship-navigation` modify the same capability. Archive order does not matter for validation (both deltas are additive `## ADDED Requirements`), but the durable-spec fold SHALL merge the two child-to-parent requirements so the durable spec names both link sources.
