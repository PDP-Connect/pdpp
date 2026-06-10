# Design — clarify parent back-link dedup key

## Problem

The child → parent back-link requirement renders one link per declared relation, sourced from either a parent stream's `expand_capabilities` (`findParentBackLink`) or the child stream's own declared `has_one` (`childHasOneBackLinksFromManifest`). The two sources can describe the **same edge** (same parent stream, same field), so the requirement mandates a dedup. The dedup was written as "same parent **stream** → one link," which is correct for the cross-source same-edge case but wrong for two **distinct** relations that share a parent stream.

Concretely the manifest already declares this shape today:

```
ynab.transactions
  has_one(account_id)          -> accounts
  has_one(transfer_account_id) -> accounts
```

Both fields are top-level schema properties. A transfer row carries different values in the two fields — they identify two different `accounts` records (the posting account and the transfer counterpart). Deduplicating by parent stream alone drops one, hiding a real, navigable, manifest-declared relationship.

## Decision

Deduplicate child → parent back-links by the pair **`(parent stream, parent-key field)`**, not by parent stream alone.

- The parent-key field is `child_parent_key_field` for the `expand_capabilities` source and `foreign_key` for the child-declared source. The requirement already states both name "the relation's parent-key field," so the pair is the natural identity of the *edge*, not the *target stream*.
- Two declared relations to the same parent stream via different fields produce different `(stream, field)` keys → both render.
- The same edge discovered via both sources produces the *same* `(stream, field)` key → collapses to one link. The metadata-derived link is preferred (it is listed first in the merge), preserving prior behavior for the cross-source case.

This is the minimal tightening that removes the literal reading mandating the bug, while leaving the cross-source collapse — the only case the original sentence was written to serve — byte-for-byte unchanged.

## Why not dedup by resolved href / parent record key

`(parent stream, parent-key field)` and `(parent stream, parent record key)` agree for every case the console renders, because within a single child record a given field has a single value. Keying on the **field** (rather than the runtime value) keeps the dedup a property of the *declared relations*, not of the particular record's data, which is consistent with the requirement's manifest-declaration-first framing and is trivially testable without record fixtures. The pure helper and the React list key both use the `(stream, field)` pair.

## Why no broader contract change

- No new manifest field, wire field, endpoint, query parameter, or `expand_capabilities` entry. The two YNAB edges are already declared; this only stops the console from collapsing them.
- No server-side reverse expansion: `GET /v1/streams/<child>/records?expand=<parent_relation>` still fails with `invalid_expand`. The back-links are drawn from values already present in each record's payload; the console issues no `expand[]` to draw them.
- The forward (`has_many` → filtered child list) and reverse (parent → filtered child list) paths are untouched; this change is scoped to the child → parent back-link dedup only.

## Alternatives considered

- **Leave the spec as-is, fix code only.** Rejected: the requirement's normative dedup sentence, read literally, mandates the buggy behavior. A future reviewer reconciling code against spec would see a discrepancy. `AGENTS.md` forbids drive-by edits to the durable spec; the correct path for a normative-meaning change is a proper MODIFY delta.
- **Dedup by parent record key (runtime value).** Equivalent in outcome but couples the dedup to record data rather than declared relations; less testable and less aligned with the requirement's manifest-first framing.
- **Render every relation with no dedup.** Rejected: the cross-source same-edge case would then render two identical links for the streams that have both a parent `expand_capabilities` `has_many` and a child-declared `has_one` (the original sentence exists precisely to prevent this).

## Acceptance checks

1. `apps/console/.../lib/relationships.test.ts` covers: two distinct `has_one` to the same parent stream via different fields both render to different hrefs; the same `(stream, field)` edge from both sources collapses to one link with the metadata-derived link preferred. (Mutation-verified: reverting the dedup key to parent-stream-only fails exactly the two-distinct-fields test.)
2. `pnpm --filter pdpp-console run types:check` is clean.
3. `openspec validate clarify-parent-backlink-dedup-key --strict` passes.
4. The durable-spec MODIFY restates the full requirement, changing only the dedup constraint sentence and adding two scenarios; all other clauses and prior scenarios are byte-identical.
