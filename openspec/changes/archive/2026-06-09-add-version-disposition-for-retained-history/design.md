# Design — version disposition for retained history

## Problem statement

The version-churn audit is structurally complete: every avoidable churn path is
gated at the connector emit layer or the storage no-op layer, the four real-field
streams are split, and the console banner already says "no review needed" when no
row is unclassified. What remains is an **observability honesty gap**, not a
churn defect:

1. **Disposition lives in the wrong place.** The reference server's owner-only
   `GET /_ref/records/version-stats` envelope returns only numeric facts
   (`versions_per_record`, `risk_level`, `risk_reasons`, projection freshness).
   The *meaning* of a `watch`/`high` row — is this a defect, expected residue,
   point-in-time history, an actionable compaction candidate? — is computed in
   the browser, in `version-churn-summary.ts`, against hardcoded
   `(connector, stream)` lists. Those lists duplicate two server-side
   registries: `COMPACTION_POLICIES` (in `compact-record-history.mjs`) and the
   `POINT_IN_TIME_REAL_FIELD_STREAMS` guard set (in the script's regression
   test). A reviewer reading the reference contract cannot see why a row is safe;
   only the console knows.

2. **One legitimate disposition is unmodeled.** `claude-code/sessions` (and
   `codex/sessions`) re-version on every real session-growth pass. Each re-emit
   is a distinct real snapshot — the file mtime gate (`index.ts:826-830` in the
   claude_code connector) skips unchanged session files, so there is no
   byte-identical no-op churn. But unlike `github/user → user_stats`, you cannot
   append-split a session: the entire record (`message_count`, `last_event_at`,
   …) *is* the moving observation, not a metric carried alongside a stable
   identity. So these streams are not real-field split candidates. They DO carry
   a registered compaction policy (the exact-stable-JSON family) — but only as
   the regression catch for a broken mtime gate; under normal growth there is
   nothing to remove. The console today parks them in the reviewed-residue map,
   so the reviewed-at timestamp guard re-alarms them as
   `lossless_compaction_candidate` every time new session history is written. The
   guard is doing its job, but the label is wrong: this is expected, retained
   history that no compaction would usefully remove, and it should not read as an
   actionable candidate.

The deliverable is the smallest durable construction that lets the records page
read "no review needed" **without** asserting "no retained history exists," while
preserving re-alarm on genuine regressions and keeping the numeric churn visible.

## The five dispositions

The task and the prior reports converge on exactly five operator-meaningful
classes. Mapping the task's vocabulary to the console's current classes and the
new one:

| # | Disposition (this change) | Console today | Needs review? | Compactable? | Re-alarms on growth? |
|---|---|---|---|---|---|
| 1 | `active_defect_or_unclassified` | `unclassified` | **Yes** | unknown (dry-run diagnoses) | n/a |
| 2 | `reviewed_historical_residue` | `reviewed_compaction_residue` | No | yes, but `removableVersions = 0` | yes → demotes to #4 |
| 3 | `point_in_time_retained_history` | `point_in_time_real_field` | No | **No** (would delete real history) | no |
| 4 | `lossless_compaction_candidate` | `lossless_compaction_candidate` | No | yes (`removableVersions > 0`) | n/a |
| 5 | `recurring_point_in_time_snapshot` | *(missing → falls to #4)* | No | **No** (each version is real) | **No** |

Disposition #5 is the new construction. It is the only change to operator
behavior: `claude-code/sessions` stops re-alarming as a compaction candidate and
reads as expected recurring history.

## Decision: `version_disposition` is correct, and it is server-DERIVED

`version_disposition` is the right construction. The open design fork is **where
the disposition is authored**. Two options were considered.

### Option A — server-derived disposition (RECOMMENDED, specified here)

The reference computes `version_disposition` from signals it already trusts,
applied with a fixed precedence (recurring-snapshot → point-in-time →
reviewed-residue → compaction-policy → unclassified):

- **recurring point-in-time snapshot list** — a reference-maintained list of
  evolving session streams (`claude-code/sessions`, `codex/sessions`) whose whole
  record is the moving observation. Checked FIRST so the registered compaction
  policy these streams carry does not pull them into the candidate bucket;
- **point-in-time split list** — the residual entity streams of a real-field
  split (`github/user`, `slack/channels`, `ynab/accounts`), whose volatile metric
  now lives in a sibling append stream. These have NO compaction policy;
- **owner-reviewed residue evidence** — the
  `REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT` map (moved server-side), compared
  against the ground-truth `last_history_at`;
- **registered compaction policy presence** — the `COMPACTION_POLICIES` registry
  in `compact-record-history.mjs`, resolved via `findPolicy`, which the script
  already treats as authoritative.

The console drops its hardcoded lists and renders the field. Classification is
computed once, in the auditable contract, from the same registries the
compaction tool uses.

> **Correction adopted during implementation.** The first draft of this design
> derived `recurring_point_in_time_snapshot` from "`mutable_state`, **no
> registered compaction policy**, no split sibling." That rule is wrong: the
> motivating streams `claude-code/sessions` and `codex/sessions` BOTH carry a
> registered compaction policy (the exact-stable-JSON family in
> `compact-record-history.mjs` — kept as the regression safety net for a broken
> mtime no-op gate, exactly as the "Anti-self-declaration" section below relies
> on). Applied literally, the draft rule would classify the very example streams
> it named as `lossless_compaction_candidate`. The implemented derivation
> instead keys disposition #5 on **explicit membership in the recurring-snapshot
> list, evaluated with precedence over the policy signal**. `semantics` is not
> used at all (every relevant stream is `mutable_state`, so it carries no
> distinguishing information — see "Why not `semantics` alone"); the explicit
> lists do the work. This is a derivation-rule correction within the approved
> Option A, not a change of approach.

**Why recommended:**

- **It cannot be gamed.** A connector cannot self-declare its churn away — there
  is no connector input to the disposition. This is the explicit quality-bar
  constraint ("do not create a mechanism that lets connectors self-declare away
  bad churn without evidence").
- **It removes duplication.** The console lists are a known drift hazard: the
  module's own comments say "keep the two lists in sync" with the script. Moving
  derivation server-side makes the registry the single source of truth.
- **It is connector-agnostic and manifest-grounded** where it can be (it reads
  `semantics`), and registry-grounded where `semantics` is insufficient.
- **Smallest blast radius.** No connector manifests change. No new manifest
  field to validate across 31 manifests. The numeric path
  (`classifyRecordVersionChurn`) is untouched.

### Option B — connector-authored manifest field

Connectors declare `version_disposition` per stream in the manifest, next to the
existing `semantics` field; the envelope echoes the declared value.

**Why rejected (but recorded for the owner):**

- **Self-declaration risk.** A connector could declare `point_in_time` on a
  stream that is actually emitting genuine no-op churn, silencing the very signal
  the audit exists to catch. Mitigating this requires an airtight guardrail
  (declared value relabels only; ratio engine still re-alarms; undeclared
  high-churn still surfaces) — which is exactly the derivation Option A already
  performs server-side, making the manifest field redundant work plus a new
  attack surface.
- **Durability is not actually better.** The design note framed decision 3 as "a
  per-stream `version_disposition` the connector declares in its manifest," but
  the reference has since shipped the *derivation* in the console without any
  manifest field. The manifest field would be a second, weaker source of the
  same truth.
- **Larger surface.** 31 manifests gain a field; manifest-honesty tests grow; the
  contract validator must enforce the enum per stream.

Option B remains viable if the owner later wants connector authors to
self-document disposition as a hint (with the server still deriving the
authoritative value). That is additive on top of Option A and is **out of scope
here**.

### The one owner decision

This change specifies Option A. The single owner-gated fork is whether the
author-location is acceptable as server-derived, or whether the owner wants the
manifest-authored hint (Option B) layered on later. The spec delta is written for
Option A; adopting B later is an additive manifest delta, not a rewrite. See
"Owner decision" below.

## Why not `semantics` alone

The manifest already has a per-stream `semantics` field, so the obvious question
is "just surface `semantics`." It is insufficient as the disposition output:

- Across all manifests there are **three** distinct values (`mutable_state` ×106,
  `append_only` ×19, `append` ×5 — note the `append`/`append_only` inconsistency,
  evidence that the field is loosely governed).
- `claude-code/sessions`, `usaa/accounts`, and `github/user` are **all**
  `mutable_state`, yet they need three different dispositions
  (`recurring_point_in_time_snapshot`, `reviewed_historical_residue`,
  `point_in_time_retained_history`). `semantics` describes how a record *updates*
  (append vs. overwrite), not whether its retained churn is *legitimate*.

So `semantics` is a useful **input** to the derivation (an `append`/`append_only`
stat stream is structurally a clean append key) but never the field the operator
reads.

## Anti-self-declaration and re-alarm guarantees (the quality bar)

The construction is specifically shaped to satisfy the lane's hard constraints:

- **No self-declaration.** Disposition has no connector input. The only
  owner-authored signal is the reviewed-at evidence map, which is an explicit
  acknowledgement (per its docstring: connector is fingerprint-correct, dry-run
  showed `removableVersions = 0`).
- **Re-alarm preserved.** `reviewed_historical_residue` requires
  `last_history_at <= reviewed_at`. When history grows after review, the row
  demotes to `lossless_compaction_candidate` (re-alarm), exactly as today. The
  new `recurring_point_in_time_snapshot` deliberately does **not** re-alarm on
  growth — but that is because growth is its expected, non-removable signal; a
  genuine regression on a session stream (e.g. byte-identical no-op re-emit if
  the mtime gate were removed) would raise `removableVersions > 0` and a
  connector-level test catches it before it reaches the dashboard.
- **Numeric visibility preserved.** `risk_level`, `risk_reasons`,
  `versions_per_record`, and all counts are unchanged and still returned. Every
  non-normal row still appears in the table with its full numbers. Disposition
  only changes whether the row counts toward the "needs review" headline.
- **Thresholds frozen.** `risk_thresholds` is unchanged; the envelope asserts
  this explicitly so a future reader cannot mistake disposition for a threshold
  knob.

## What makes the records page read "no review needed"

Precisely: the headline counts only `active_defect_or_unclassified` rows. The
page reads "no review needed" **iff** every non-normal row classifies into one of
the four expected dispositions (#2–#5). It never hides a row and never asserts the
history is absent — the table still shows `claude-code/sessions` at its real
`versions_per_record` with its `watch` chip, labeled "recurring point-in-time
snapshots — expected retained history." The single behavior change that gets
the owner's instance there today is disposition #5 reclassifying `claude-code/sessions`
out of the re-alarming compaction-candidate bucket.

## Alternatives considered (and rejected)

- **Raise the numeric thresholds** to silence the four rows. Rejected by the
  design note and the lane charter: it re-hides the next genuine regression.
- **Compact the residue.** Dry-run shows `removableVersions = 0` for all four
  residue/session rows; compaction frees nothing and is owner-gated/Postgres-only
  anyway.
- **Exclude the volatile field from the fingerprint.** Silently destroys real
  history; forbidden.
- **A console-only label for disposition #5.** Would fix the owner's instance but keep
  the meaning in the browser and grow the duplication this change is removing.

## Acceptance checks

- **AC-1 envelope carries disposition.** `GET /_ref/records/version-stats`
  returns `version_disposition` on every row, one of the five enum values;
  owner-only auth unchanged; no record payloads leak.
- **AC-2 thresholds untouched.** `risk_thresholds` in `meta` is byte-identical to
  today; `risk_level`/`risk_reasons` for every fixture row are unchanged by this
  change.
- **AC-3 unclassified still needs review.** A `high`/`watch` row on an unknown
  `(connector, stream)` classifies `active_defect_or_unclassified` and counts
  toward the headline.
- **AC-4 reviewed residue re-alarms on growth.** A reviewed-residue row whose
  `last_history_at` is after `reviewed_at` classifies
  `lossless_compaction_candidate`, not `reviewed_historical_residue`.
- **AC-5 sessions are recurring snapshots.** `claude-code/sessions` and
  `codex/sessions` classify `recurring_point_in_time_snapshot` (via explicit
  recurring-snapshot list membership, which takes precedence over their
  registered compaction policy), do not count as needs-review, and do not
  re-alarm when `last_history_at` advances.
- **AC-6 point-in-time is never compactable.** A split residual entity stream
  (`github/user`, `slack/channels`, `ynab/accounts`) classifies
  `point_in_time_retained_history` and is offered no compaction command.
- **AC-7 connector cannot set it.** No manifest field feeds disposition; a
  connector manifest change cannot alter a row's `version_disposition` (regression
  pinning that the derivation reads only server registries + reviewed map +
  ground-truth, not connector-authored values).
- **AC-8 console parity.** The console renders the server-derived field and the
  existing `version-churn-summary.test.ts` behavioral expectations hold against
  the relocated logic (no double source of truth).

## Owner decision

- **Author-location:** Accept disposition as **server-derived** (Option A,
  recommended), or request the **manifest-authored hint** (Option B) be layered
  on as a follow-up. The spec delta here assumes A; B is additive.
- **Disposition #5 naming:** `recurring_point_in_time_snapshot` vs. an alternative
  the owner prefers (e.g. `recurring_session_snapshot`). Naming only; behavior is
  fixed.

## Out of scope

- Any connector manifest change (Option B).
- Any threshold change.
- Any live compaction or history mutation.
- The implementation itself beyond what this change authorizes (this is
  proposal/packet work; the implementation lane is sequenced in `tasks.md`).
