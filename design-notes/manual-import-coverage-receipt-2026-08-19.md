# A finished import has no way to prove what it ingested

**Status:** superseded 2026-08-20. The premise below was wrong on the facts, and
the proposed build is unnecessary. See "What was actually true" at the end.
Written 2026-08-19 after a related fix was deliberately scoped to exclude this
case.

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

---

## What was actually true (2026-08-20)

Three of the four load-bearing claims above are false. Steps 1-3 should not be
built.

**"No connector emits evidence for `snapshot_import_receipt`" — false.** Both
connectors already emit an artifact-grounded coverage declaration, and both
manifests already declare the strategy (`google_maps.json:166,246`,
`whatsapp.json:140,208`). `google_maps` counts every point/segment element the
parser produced, at the parse site, and reports `covered < considered` when an
element had no usable id or timestamp (`finishPoints`/`finishSegments`,
hardened by `e1b92b36c` the same week this note was written). `whatsapp` counts
the archive's own file and attachment listing and subtracts media the bounded-
read policy dropped. Neither denominator is recomputed from the survivors.

**"Nothing will run again" — false, and this is the load-bearing one.** The
uploaded artifact is durable and is re-read on **every** run, not just at setup:
`ManualUploadDurableSourceBinding` carries `import_dir`/`import_dir_env_var`
specifically so they survive promotion, and the run orchestrator injects the
directory as the connector-declared env var. These connections are re-runnable
against the file already on disk.

**"Coverage evidence is produced by a collection run" — true, and sufficient.**
`connector_summary_evidence` is keyed by `connector_instance_id`, but is only
ever populated by folding a terminal run event's `collection_facts`. Zero runs
therefore means `stream_latest_facts_json IS NULL` and axis `unknown` — which is
the correct and honest reading of "never measured", not a defect.

Derivation over the exact shapes these two connectors emit, through the real
`deriveStreamCoverageCondition`:

| fact | axis |
| --- | --- |
| `considered=299248, covered=299248` (fully reconciled) | `complete` |
| `considered=299248, covered=299243` (5 elements unaccounted) | `partial` |
| whatsapp attachments, media dropped by read policy | `partial` |
| no run ever — the live state today | `unknown` |

So the proof path is built and works end-to-end, including the honest partial.
**The remedy is operational — re-run each connection once against its stored
artifact — not a receipt, a manifest change, or a read-side branch.** A backfill
would be strictly worse: it would synthesize a denominator from records already
ingested, which is the fabricated-denominator anti-pattern (`covered ==
considered` recomputed from survivors) that the coherence contract exists to
reject, and it could never produce the `partial` verdict a real re-run can.

One genuine defect did come out of this review, fixed separately: `CredentialsValid`
had no branch for a connector that authenticates to nothing, so both sources sat
at `credentials_not_probed`/`unknown` forever. That is now `not_applicable`,
derived from the manifest declaration.

What remains unprovable either way, and is worth not overclaiming: a reconciled
artifact proves the run ingested everything the *file* contained. It says
nothing about whether the file is a complete export of the owner's history —
the provider decides what goes into it, and no check on this side can see past
that.

## Related

`source-state-truth-2026-08-18.md` — the `not_applicable` design and the
deliberate decision not to extend it to coverage.
