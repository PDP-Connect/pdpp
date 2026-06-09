# Design — version remediation disposition for retained history

## Problem statement

`version_disposition` (shipped by `add-version-disposition-for-retained-history`)
answers one question: **why does this row's retained history exist?** It does so
correctly across five classes. But the records-page notice now has a second,
unanswered question that the evidence lanes made concrete: **what does the
operator do about it?**

Today three of the four live watch rows collapse onto a single disposition that
hides three different answers:

| Watch row | `version_disposition` (today) | What the evidence proved it needs |
|---|---|---|
| `chase/statements` | `reviewed_historical_residue` | A **connector content fingerprint** (`pdf_text_sha256` + `pdf_page_count`) so the RC4/regeneration blob churn can be excluded losslessly. Dry-run removes 0 today. |
| `usaa/statements` | `reviewed_historical_residue` | Same content fingerprint (USAA already extracts text), keeping `account_id`/`account_reference` in the fingerprint so the FK backfill survives. |
| `usaa/accounts` | `reviewed_historical_residue` | A **data migration** of 11 pre-split balance observations into `account_stats` — an owner-gated decision, *not* compaction (and the only surviving copy lives here). |
| `claude-code/sessions` | `recurring_point_in_time_snapshot` | An **owner retention-policy decision** about whether to bound unbounded-growth snapshot history. May be declined. |

The disposition is right about safety and forward-correctness. The gap is that an
operator reading the notice cannot distinguish "reviewed residue that a connector
fingerprint will minimize" from "reviewed residue carrying a pending data
migration" from "expected recurring history with a retention-policy question."
The banner is *less scary* (it stopped saying "needs review") but not yet
*rational* (it cannot name the next action).

## The orthogonal axis

Disposition and remediation are genuinely orthogonal facts:

- **Disposition** = the structural reason the history exists (defect, residue,
  point-in-time, candidate, recurring snapshot). Stable contract, just shipped,
  fully tested.
- **Remediation** = the operator's available next action (nothing actionable
  here / a connector fingerprint is pending / a data migration is pending / an
  owner retention-policy decision is pending).

A given disposition does not determine remediation: `reviewed_historical_residue`
maps to `content_fingerprint_pending` for the statement rows but
`owner_migration_pending` for `usaa/accounts`. That is exactly why this is a
second field, not a finer split of the first. The four remediation values:

| Remediation | Meaning | Evidence-grounded examples |
|---|---|---|
| `none` | No action available/warranted from this surface. Already minimal, an actionable compaction candidate (its dry-run command is the action), or expected recurring history with no open decision. | `slack/workspace` candidate; `github/user` point-in-time; an already-minimal stream. |
| `content_fingerprint_pending` | Fingerprint-correct on the run clock, but non-minimal until the **connector emits a content fingerprint** that lets volatile blob/acquisition fields be excluded losslessly. Dry-run frees nothing today. | `chase/statements`, `usaa/statements`. |
| `owner_migration_pending` | Retained history is the **sole surviving copy** of real observations that must be migrated to their canonical append-keyed home before any collapse. Compaction is not the fix and could be destructive out of order. | `usaa/accounts` (11 pre-split balances → `account_stats`). |
| `owner_retention_policy` | Expected recurring history whose only lever is an **owner retention-policy decision** (e.g. bound an unbounded snapshot). No defect; may be declined. | `claude-code/sessions`, `codex/sessions`. |

## Decision: server-derived, like disposition

`version_remediation` is derived by the reference from signals it controls —
never by a connector. This is the same anti-self-declaration constraint that
governs `version_disposition`, and it is non-negotiable here: a connector that
could declare its own churn `none` would defeat the surface.

The derivation reads:

- the already-resolved `version_disposition` for the row (so remediation can
  never contradict disposition — see consistency rules below);
- three reference-maintained `(connector, stream)` lists, co-located with the
  existing disposition registries in `version-disposition.js`:
  - `CONTENT_FINGERPRINT_PENDING_STREAMS` — `chase/statements`,
    `usaa/statements`. A stream here is residue whose real fix is a connector
    content fingerprint (tracked by a separate connector/OpenSpec change).
  - `OWNER_MIGRATION_PENDING_STREAMS` — `usaa/accounts`. A stream here carries a
    pending owner-gated data migration; the retained history is the sole copy.
  - `OWNER_RETENTION_POLICY_STREAMS` — `claude-code/sessions`, `codex/sessions`.
    A stream here is a recurring snapshot with an open retention-policy lever.

The console renders the field. No re-derivation in the browser; the
evidence-grounded copy is a display-only lookup keyed by the server value.

### Why not extend the `version_disposition` enum

Splitting `reviewed_historical_residue` into `fingerprint_pending_residue` /
`migration_pending_residue` was considered and rejected:

- It mutates a contract that shipped and was validated days ago, forcing churn on
  every consumer and test for no semantic gain.
- It conflates two orthogonal facts. A future migration-pending row that is
  *not* reviewed residue (e.g. a point-in-time stream awaiting a different
  migration) would have no clean home in a disposition-only model.
- The existing precedence chain in `classifyVersionDisposition` is carefully
  ordered (recurring → point-in-time → reviewed → policy → unclassified). Adding
  branches risks the same subtle mis-precedence the design's own "correction
  adopted during implementation" note warns about.

A second additive field keeps disposition frozen and lets remediation evolve
independently.

### Why not connector-authored

Identical reasoning to disposition's Option B rejection: a connector that could
declare its own remediation could declare a needed fix away, durability is not
better than server derivation, and it grows 31 manifests for a weaker source of
the same truth. Out of scope; additive later if the owner ever wants connector
authors to *hint* a remediation the server still authoritatively derives.

### Why not guidance-copy-only in the console

Enriching only the console's per-row strings (keyed off `connector/stream` in the
browser) would re-introduce exactly the duplication
`add-version-disposition-for-retained-history` removed: the meaning of a row would
live in the bundle, not the auditable contract. A reviewer reading the reference
contract must be able to see that `usaa/accounts` carries a pending migration.

## Consistency rules (remediation never contradicts disposition)

The derivation enforces a fixed precedence and a disposition guard so the two
fields can never disagree:

1. `OWNER_RETENTION_POLICY_STREAMS` membership →
   `owner_retention_policy`, but **only if** the row's disposition is
   `recurring_point_in_time_snapshot`. (These lists are intentionally aligned;
   the guard makes the invariant explicit and regression-pinned.)
2. else `OWNER_MIGRATION_PENDING_STREAMS` membership → `owner_migration_pending`.
3. else `CONTENT_FINGERPRINT_PENDING_STREAMS` membership →
   `content_fingerprint_pending`.
4. else `none`.

An `active_defect_or_unclassified` row is always `none` — its remediation *is*
"review it," which the disposition and the existing dry-run command already
convey; we do not invent a fifth remediation for it. A
`lossless_compaction_candidate` is always `none` — its action is the dry-run
command already rendered. A `point_in_time_retained_history` row is `none` unless
it is explicitly listed as migration-pending (none are today; the list is the
extension point if a future point-in-time stream needs a migration).

## Anti-self-declaration and label-only guarantees (the quality bar)

- **No self-declaration.** Remediation has no connector input. It is derived from
  reference-maintained lists + the server-derived disposition.
- **Label-only.** Remediation never alters `risk_level`, `risk_reasons`,
  `versions_per_record`, or `risk_thresholds`. The envelope asserts
  `remediation_affects_thresholds: false`, mirroring disposition's assertion.
- **No row hidden.** Every non-normal row still appears with full counts, its
  risk chip, and its disposition. Remediation only adds a next-action cue.
- **Truthful disposition preserved.** A row never disappears and never gets a
  remediation that contradicts its disposition. `none` is honest: it means this
  surface has no further action, not that the history is absent.

## What makes the records page rational (not merely less scary)

After this change, the four watch rows read as four distinct, truthful states:

- `chase/statements` / `usaa/statements`: "reviewed residue · **fingerprint
  pending** — compaction frees nothing yet; the connector content fingerprint is
  the fix (see the statements-fingerprint change)."
- `usaa/accounts`: "reviewed residue · **migration pending** — the retained
  history holds pre-split balance observations; an owner-gated backfill to
  `account_stats` must precede any collapse. Do not compact."
- `claude-code/sessions`: "recurring snapshot · **retention policy** — expected
  growth; bounding it is an owner decision you may decline."

The operator can now answer the task's question — which row needs a fingerprint,
which needs a migration, which is a retention-policy call — directly from the
notice.

## Alternatives considered (and rejected)

- **Extend the disposition enum** — rejected; mutates a fresh contract and
  conflates orthogonal facts (above).
- **Connector-authored remediation** — rejected; self-declaration surface
  (above).
- **Console guidance-copy only** — rejected; re-introduces browser-side
  duplication of contract meaning (above).
- **A free-text `remediation_note` per row** — rejected; unauditable, untestable,
  and invites owner-voice/hosted-service drift. An enum + display-only copy map
  keeps the contract checkable and the copy in operator voice.
- **Bumping reviewed-at timestamps to re-suppress the rows** — this is what
  `bba1cfc5` did; it is the "less scary" move the task explicitly pushes past. It
  does not make the surface rational.

## Acceptance checks

- **AC-1 envelope carries remediation.** `GET /_ref/records/version-stats`
  returns `version_remediation` on every row, one of the four enum values;
  owner-only auth unchanged; no record payloads leak.
- **AC-2 thresholds and disposition untouched.** `risk_thresholds`,
  `risk_level`, `risk_reasons`, and `version_disposition` for every fixture row
  are byte-identical to before this change; `remediation_affects_thresholds`
  asserted `false`.
- **AC-3 statements are fingerprint-pending.** `chase/statements` and
  `usaa/statements` (disposition `reviewed_historical_residue`) classify
  `content_fingerprint_pending`.
- **AC-4 usaa/accounts is migration-pending.** `usaa/accounts` (disposition
  `reviewed_historical_residue`) classifies `owner_migration_pending`, distinct
  from the statement rows.
- **AC-5 sessions are retention-policy.** `claude-code/sessions` and
  `codex/sessions` (disposition `recurring_point_in_time_snapshot`) classify
  `owner_retention_policy`.
- **AC-6 default is none.** A `lossless_compaction_candidate`, a
  `point_in_time_retained_history` not on the migration list, and an
  `active_defect_or_unclassified` row all classify `none`.
- **AC-7 connector cannot set it.** No manifest field or emitted payload feeds
  remediation; the derivation reads only reference lists + the server-derived
  disposition.
- **AC-8 consistency with disposition.** A row classified `owner_retention_policy`
  always has disposition `recurring_point_in_time_snapshot`; remediation never
  contradicts disposition (regression-pinned).
- **AC-9 console renders the field.** The records-page notice renders the
  remediation cue/guidance from the server value, and the reviewed-residue rows
  render distinct copy for fingerprint-pending vs. migration-pending.

## Owner decision

- **Accept the orthogonal `version_remediation` field** (recommended) vs. a
  finer disposition enum split. The spec delta assumes the orthogonal field.
- **Naming of the four remediation values** (`none`,
  `content_fingerprint_pending`, `owner_migration_pending`,
  `owner_retention_policy`) — naming only; behavior is fixed.
- The remediation *list memberships* mirror the dispositions the owner already
  accepted; this change does not re-open those acceptance gates.

## Out of scope

- Any connector content-fingerprint implementation (the `chase/statements` /
  `usaa/statements` fingerprint work is a separate change; this only *names* that
  it is pending).
- Any data migration of `usaa/accounts` pre-split balances (separate
  owner-gated migration proposal; this only names that it is pending).
- Any bounded-retention implementation for recurring snapshots (separate
  owner-gated change; this only names the open decision).
- Any threshold change, any live compaction, any history mutation.
- Any change to `version_disposition` or the numeric churn engine.
