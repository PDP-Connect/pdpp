## Why

The durable requirement "Operator console SHALL render manifest-declared parent links on the child record page" (in `reference-implementation-architecture`) establishes that a child → parent back-link's target is "the parent record keyed by the value the child record carries in **the relation's** parent-key field" — i.e. a link per declared relation. But its dedup constraint is written one notch too coarse:

> When a child-declared `has_one` link and a parent-`expand_capabilities`-derived link resolve to the same parent **stream**, the console SHALL render a single link for that parent stream (deduplicated), not two.

That sentence was written for the cross-source case: the *same* edge is discoverable both via a parent's `expand_capabilities` and via the child's own declared `has_one`, and the two discoveries must collapse to one link. Read literally, though, it also collapses two **distinct** declared relations that happen to target the same parent stream via **different** fields — which point at **different** parent records and must both render.

A YNAB `transactions` record declares two `has_one -> accounts` edges, `account_id` (the posting account) and `transfer_account_id` (the other leg of a transfer). Both are top-level schema properties; their values are different account keys. The reference console was deduplicating by parent stream alone and silently dropping the `transfer_account_id -> accounts` link, so the operator had no path to the transfer's counterpart account — a manifest-declared, navigable relationship was invisible.

The reference console is fixed at HEAD (commit `11b03402`): the merge/dedup now keys on `(parent stream, parent-key field)` via a pure `mergeParentBackLinks` helper, so distinct edges to the same parent stream both render while the same-edge cross-source case still collapses. This change tightens the requirement's wording to match, removing the literal reading that mandated the bug.

## What Changes

- MODIFY the dedup constraint on the child → parent back-link requirement so it deduplicates by the pair `(parent stream, parent-key field)` — not by parent stream alone. Two declared relations to the same parent stream via different parent-key fields both render (they resolve to different parent records); the same edge discovered via both manifest sources still collapses to a single link, metadata-derived preferred.
- Add a scenario pinning the YNAB `transactions` two-edges-to-`accounts` case (account_id and transfer_account_id) as the proving example, and a scenario affirming the unchanged same-edge cross-source collapse.
- No code change ships with this change: the reference console already implements the tightened rule at HEAD. This change documents the existing contract so spec and code stay in lockstep.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture` — refines the dedup constraint of the existing "Operator console SHALL render manifest-declared parent links on the child record page" requirement to key on `(parent stream, parent-key field)`. No server, contract, wire, manifest, or grant behavior changes.

### Removed Capabilities

- None.

## Impact

- Affected operator console: `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx` and `apps/console/src/app/dashboard/records/lib/relationships.ts` (`mergeParentBackLinks`, `parentBackLinkDedupKey`). Both already implement the tightened rule at HEAD (`11b03402`); this change adds no code.
- Affected manifest surface: none. The two YNAB `has_one -> accounts` edges already exist as declared descriptive metadata and are unchanged. The rule is generic; any child stream declaring two `has_one` to the same parent via different fields rides it without per-connector spec pins.
- Affected public surface: none. `GET /v1/streams/<s>` `expand_capabilities`, the records-read endpoints, and the grant model are unchanged. The affordance issues no `expand[]` request; the back-links are drawn from values already present in each record's payload.
- No new dependencies, storage tables, blob semantics, search endpoints, query grammar, or owner-auth surfaces.
- No protocol semantics in `spec-*.md` change. PDPP Core remains a consent/disclosure protocol; this change documents reference-implementation operator-console rendering over manifest-declared relationships.

## Residual Risks

- **Owner-only live render check.** Confirming a deployed YNAB `transactions` detail page renders both the `account_id` and `transfer_account_id` account links is owner-gated (it needs an instance with YNAB transfer data). It is recorded here as a residual risk rather than an open task, per `AGENTS.md`. The contract proof is the unit tests in `relationships.test.ts` (the two-distinct-fields case is mutation-verified); the live check only confirms operator-visible rendering, which is bundled-manifest-derived and deploy-revision-independent.
- **Same-stream label disambiguation.** When two links to the same parent stream render, they are distinguished by the parent-key field name shown in the row (`accounts · account_id → parent` vs `accounts · transfer_account_id → parent`). This is sufficient for the operator console's compact list; richer labels are a follow-up polish, not a contract concern.
