# The fused source status line — why it wasn't there, and what it cost

2026-08-22

The owner asked on 2026-08-19 why the console has no product-standard fused
status string — the "Last updated 3 hours ago / Syncing now" line every mature
sync product shows — and asked for the underlying design problem explained
rather than patched over. This is that explanation, and the design that shipped.

## What the owner saw

On `/sources`, each row showed one colored glyph (`●◐⊘○◌⏸`) and nothing else
about state. The status *text* existed but was `sr-only` — announced to screen
readers, invisible to eyes. Freshness never reached the row at all. Whether a
source was syncing right now was used only to disable buttons and set a polling
interval; it was never displayed.

So the row could not answer any of the three questions an owner actually has:
what is this source's state, when did it last update, and is it working right
now?

## Why this is not a one-line fix

The tempting fix is to concatenate three fields. That fails because **these are
three independent axes that routinely disagree**, and the disagreements are
exactly the cases that matter:

| Situation | Freshness | Activity | Verdict | What the owner needs to hear |
|---|---|---|---|---|
| Sync running against a broken connector | stale | syncing | blocked | **Blocked** — the run will not save it |
| Healthy source mid-refresh | fresh | syncing | healthy | Working, syncing now |
| Stale because every run fails | stale | idle | blocked | Blocked, and here is how long |
| Paused with a stale in-flight run flag | stale | "syncing" | n/a | **Paused** — it is not syncing |
| Never connected | none | idle | unknown | Never updated |

A source can be fresh and failing. It can be stale and syncing. It can look busy
and be dead. Any fused string has to *resolve* those conflicts, and the
resolution rule is the entire design — not the concatenation.

## What the code actually did: last-writer-wins

`deriveRenderedSourceStatus` in `apps/console/src/app/(console)/lib/source-actionability.ts`
resolves the conflict by returning early:

```ts
if (running) {
  return { dot: "◌", freshnessNote: null, kind: "pending", label: "Syncing", tone: "muted" };
}
```

An in-flight run **erased both the freshness note and the health verdict**. A
source that was blocked, stale, and had a doomed retry in flight rendered as
`"Syncing"` in a muted tone — the calmest thing on the page.

That is the fabricated-green defect class this program exists to kill, in
miniature. Nobody wrote "pretend it is fine"; the most reassuring axis just
happened to be evaluated last and win the single available slot. **Fabricated
green is usually an architecture accident, not a lie somebody typed.** One slot
plus three axes forces a silent choice about which truth to discard, and the
convenient one wins by default.

## The rule that shipped

> **Activity is additive, never substitutive.**

"Syncing" is something a source is *doing*, not something it *is*. So:

- The **state slot** always holds the worst honest verdict.
- **Freshness** gets its own slot and is never erased by activity.
- **Syncing** is appended as a separate clause and owns no color of its own.

The line therefore reads `Blocked · Last refreshed 6 days ago · Syncing now` —
which is uncomfortable, and correct. The old rendering of that same source was
the single word `Syncing`.

Implementation: `apps/console/src/app/(console)/lib/fused-source-status.ts`.
Axes are ranked worst-to-best (`SEVERITY_BY_KIND`) and the worst wins the slot
by comparison, not by branch order — so adding a state later cannot silently
reintroduce last-writer-wins.

### Recovering the discarded verdict

Because `deriveRenderedSourceStatus` throws the verdict away on `running`, the
fused line needs it back. `deriveSourceVerdictStatus` re-derives the
verdict-only status, and `projectSourceActionability` passes it as
`verdictFallback` — but **only for the `running` collapse**. `revoked`,
`paused`, and `pending` are lifecycle facts that outrank any verdict: a revoked
source is revoked no matter how its last verdict read. Passing the fallback for
those would let a stale "Blocked" overwrite "Revoked".

### Honest absence

A missing freshness note is not "fine". When a source has never had a
successful run, the line says `Never updated` rather than omitting the slot —
omission reads as "not applicable", which is a stronger claim than the evidence
supports. When a source *has* succeeded but carries no annotation, the slot is
genuinely absent rather than guessed.

The server already folds activity into its own freshness annotation
(`rendered-verdict.ts` emits `"Refreshing now."` when `badges.syncing`). That
phrasing is dropped here and re-added from the real activity flag, so the
activity slot has exactly one owner and cannot double up.

## What is guarded

`fused-source-status.test.ts` pins the disagreement cases, and the rule is
mutation-proven three ways: restoring last-writer-wins, inverting the severity
comparison, and letting paused/revoked show as syncing each fail tests that name
the specific dishonesty.

CSS state rules change **color only** — the geometry-bearing rules are
state-independent — so the list never reflows as sources change health. This is
enforced by the pre-existing "status state does not create separate row
geometry" invariant.

## Coordination note

This work deliberately does **not** restructure
`apps/console/src/app/(console)/lib/connection-evidence.ts`, which the
`labels-naming-0822` lane is changing. The fused line *composes* the label
strings that module and the server verdict produce; it defines no owner-facing
label vocabulary of its own beyond the two connective strings `"Syncing now"`
and `"Never updated"`. If that lane renames a pill label, the fused line picks
it up with no change here.

## What is not addressed

- Freshness granularity is still the server's day-level prose
  (`"3 days ago"`), not minute-level. Mixing the client's `formatRelative`
  (minutes/hours) with the server's day buckets would read inconsistently, so
  one source of truth was kept. A finer server annotation would improve this.
- The detail page still renders the axes separately. Only the `/sources` list
  row is fused so far.
