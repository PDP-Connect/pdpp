# A finished import has no way to prove what it ingested

**Status:** intake. Proposed, not built. Written 2026-08-19 after a related fix
was deliberately scoped to exclude this case.

## The state that has no honest verdict

Two sources on this instance hold real data and can never be green:

- Google Maps Timeline Import — 299,248 records
- WhatsApp — 120,042 records

Both are `source_kind='manual'`, paused, with zero runs ever and zero rows in
`connector_detail_gaps`, `run_history`, or `acquisition_batches`. They are
finished one-time file imports. Nothing will run again.

`isHealthyConditionSet` requires `SourceCoverageComplete` to be true. Coverage
evidence is produced by a collection run. No run, no evidence, no green — on a
source holding 419k records the owner can read today. The page says "Not
measured", which he reads as broken.

## Why this is not the same as the case next to it

An adjacent problem looks identical from the pill and is not. Gmail has 32
terminal gaps, each carrying `observed_size_bytes > configured_limit_bytes` —
a specific attachment, a recorded size, a recorded cap. Gmail measured its
shortfall and can enumerate it. That case is being handled by
`unfillableAccounted`, a flag whose contract requires **every** outstanding gap
to carry durable per-item evidence.

These two imports fail that contract on the facts. There is no `terminal_gap`
axis to account for, because there are no gaps. Their coverage axis is
`unknown` — never measured — not `terminal_gap` — measured and partly
impossible.

**"Measured, and this part is provably impossible" and "never measured, and
never will be" are different states and must not share a signal.** Setting the
Gmail flag for an import would assert that every outstanding gap is proven
unfillable over an empty set, inferred from the total absence of evidence.
That is the exact false-green the anti-green tests exist to catch.

An earlier framing in this work treated both as one design. That was wrong, and
the evidence above is what corrected it.

## The line that already exists, and holds

`Fresh` can be satisfied by `not_applicable` (`conditionIsSettledSatisfied`).
`SourceCoverageComplete` cannot — it is gated by `conditionIsTrue`
(`connection-health.ts:1830`). That asymmetry is deliberate, and
`source-state-truth-2026-08-18.md` states why: a completed import buys
exemption from a *freshness* proof, never from proving it ingested what it
claimed. Relaxing coverage would let any source with no evidence read as
complete.

So the fix is not to exempt coverage. It is to let an import **prove** its
coverage.

## The shape a proof would take

`connector-coverage-policy.ts` already declares a `snapshot_import_receipt`
coverage strategy alongside `checkpoint_window` and `full_inventory`. No
connector emits evidence for it. The placeholder is the design, unbuilt.

What it needs, roughly:

1. The manual-upload route writes an `acquisition_batches` receipt at import
   time recording what the file claimed to contain and what was ingested. The
   table exists and is empty for both connections.
2. The stream's manifest declares `coverage_strategy: snapshot_import_receipt`.
3. The coverage projection grows a branch that reads that receipt as proof, the
   way it reads a run's coverage report today.

Then a finished import satisfies coverage the same way a collecting source
does — by evidence, not by exemption — and the terminal label already built for
it (`Fresh: not_applicable`, "Import complete") becomes reachable.

## Cost and scope

This touches the manifest schema, the upload route, and the coverage read path.
It is a separate change from the Gmail work deliberately: bundling them would be
two problems in one story, and the Gmail fix is narrow and provable on its own.

Worth stating plainly: until this exists, these two sources stay honestly red.
That is the correct outcome. The alternative — green by exemption — would mean
the page can no longer distinguish a source that proved its completeness from
one that never tried.

## Open questions

- Does the receipt record the file's own claim (a manifest inside the export,
  a row count) or only what PDPP ingested? A receipt that only records what was
  ingested proves nothing about what was missed.
- Are existing imports retrofittable, or is this only correct for imports made
  after it ships? Both sources here predate any receipt, so they may need a
  one-time backfill with explicitly weaker provenance — and that weaker
  provenance should be visible, not silently equal to a real receipt.
- Does a partial import (an interrupted upload) produce a receipt that honestly
  reports incompleteness, or none at all?

## Related

`source-state-truth-2026-08-18.md` — the `not_applicable` design and the
deliberate decision not to extend it to coverage.
