# Real-Field Version Churn As Point-In-Time Streams

Status: captured
Owner: reference implementation owner
Created: 2026-06-02
Updated: 2026-06-02
Related: design-notes/record-version-churn-and-noop-semantics-2026-05-26.md, design-notes/record-version-semantics-prior-art-2026-05-26.md, openspec/changes/register-current-churn-compaction-policies, openspec/changes/extend-usaa-real-field-churn-incidental-gates, tmp/workstreams/ri-real-field-churn-point-in-time-design-v1-report.md

## One-screen summary (for the owner)

The version-churn audit forward-fixed the current **no-op/run-clock** streams:
Gmail labels now suppress byte-identical label re-emits, and `fetched_at` (a run
timestamp, not source data) is excluded from the fingerprint on usaa/statements,
chase/accounts, slack/channel_memberships, and — as of `cd577ba7` on this
branch's base — **usaa/accounts and usaa/credit_card_billing**. Those last two
no longer churn on a no-op refresh; any real balance/APR/reward move still
re-emits.

What is left is not a bug and not a threshold problem. Four streams still version
on **genuinely changing real fields**, because one record is being asked to carry
both a stable identity and a moving observation:

| Stream | Real field that churns | Should become |
| --- | --- | --- |
| `github/user` | follower / repo / gist counts | append-keyed `user_stats` observations |
| `slack/channels` | `num_members` | append-keyed `channel_stats` observations |
| `usaa/accounts` | `balance_cents` | append-keyed `account_balances` observations |
| `usaa/credit_card_billing` | balance / available-credit / rewards | append-keyed `credit_card_balances` observations |

The proposed move is to split each volatile observation into its own
**append-keyed point-in-time stream** (one record per observation, not one new
version of one record). Stable identity and semantic state (profile, channel
name/topic/archive flags, APR, credit limit, card-holders) stay on the existing
stream. Result: identity streams go quiet and honest, every real observation is
**retained as queryable history** (nothing hidden, nothing compacted away), and
the dashboard stops alarming on data that is supposed to grow.

This note is **captured/proposed, not decided.** New manifest streams and any
dashboard-classification change are durable behavior and need an OpenSpec change
first. The owner decisions are in the section of the same name below.

## Question

How should the reference model the four streams that still version on real,
genuinely-changing fields, now that the known no-op/run-clock emit defects are
already fixed — without losing history, without raising churn thresholds, and
without hiding real changes?

## Context

- The version-churn policy audit (`register-current-churn-compaction-policies`)
  forward-fixed three no-op/run-clock streams and left four "real-field" streams
  as report-only, because excluding a real field from a fingerprint silently
  destroys source history.
- `cd577ba7` (this branch's base) then closed the **run-clock half** of the two
  USAA streams: `usaa/accounts` and `usaa/credit_card_billing` now exclude only
  `fetched_at`. A no-op refresh collapses; a real balance/APR/reward change
  still creates a fingerprint boundary and re-emits. Verified against
  `selectRemovableVersions` + parity fixtures. So the "exclude only the run
  clock" lossless fix is **done** for those two — the only residual churn is the
  real balance movement itself.
- The remaining churn is therefore **100% real-field** on all four streams:
  - `github/user` and `slack/channels` never had a run-clock component; their
    churn was always real counts.
  - `usaa/accounts` / `usaa/credit_card_billing` now churn only on the genuine
    financial observation, because the run clock is already gated out.
- Root cause (shared by all four): a **snapshot/`mutable_state` record is being
  used to carry a time series.** A point-in-time metric (a value sampled at fetch
  time) modeled as repeated *versions of one key* fights the dashboard
  (many-versions = smell), compaction (no-op detection), and `changes_since`
  (state-transition semantics). Modeled as *many records of an append key*, it
  aligns with all three. This is the dlt "merge vs append disposition per
  resource" split: identity = merge, observations = append.

### Per-stream decomposition (verified against record builders)

| Stream | Stable core (stays) | Volatile real field (moves) | Run-clock already gated? |
| --- | --- | --- | --- |
| `github/user` | `id`, `login`, `name`, `email`, `bio`, `company`, `location`, `blog`, `twitter_username`, `created_at` | `followers`, `following`, `public_repos`, `public_gists` | n/a (no run clock in body) |
| `slack/channels` | `id`, `name`, `name_normalized`, `previous_names`, kind/archive flags, `creator`, `created`, topic/purpose | `num_members` | n/a (no run clock in body) |
| `usaa/accounts` | `id`, `type`, `name`, `last_four`, `status` | `balance_cents` (+ `available_balance_cents` when non-null) | **yes** (`fetched_at` excluded, `cd577ba7`) |
| `usaa/credit_card_billing` | `id`, `account_id`, `account_nickname`, `annual_percent_rate`, `cash_advance_apr`, `credit_limit_cents`, `card_holders` | `current_balance_cents`, `available_credit_cents`, `cash_rewards_cents`, `billing_status`, `minimum_payment_met` | **yes** (`fetched_at` excluded, `cd577ba7`) |

`credit_limit_cents` is semi-stable (changes rarely, on a real credit-limit
increase). It is real semantic state, not a sampled observation — it **stays**
on the identity record so its transitions are worth a version. This is the one
non-obvious cut line (owner question 4).

## Stakes

- **Honesty.** Today the dashboard shows four `high`/`watch` chips that are
  neither bugs nor noise. They read as "something is wrong" when the truth is
  "this is a value that legitimately changes." Either reading misleads the
  operator.
- **History.** The real observations (every follower count, every balance) are
  the *product*, not noise. The wrong fix (exclude the real field, or compact
  the versions) deletes genuine source history. The brief forbids this and it is
  the correct constraint.
- **Don't paper over the next bug.** Raising the numeric churn thresholds to
  silence these four would also re-hide the *next* genuine connector regression.
  The ratio engine must stay strict; the fix must be structural, not a knob.
- **Financial correctness (USAA).** The two USAA splits move money fields.
  A `currencyToCents` regression here is a financial-data bug, so USAA sequences
  last behind the no-money github/user reference pattern.

## Current leaning

**Split each volatile observation into its own append-keyed point-in-time
stream.** It is the only option that satisfies all three constraints at once:
retain real history, stop alarming, and keep compaction safe.

Decision rule (applies to any future real-field churn):

1. **No-op / run-clock / ingest artifact** (byte-identical re-emit,
   `fetched_at`, re-normalization, repair backfill) → suppress from the connector
   fingerprint + register a mirrored compaction policy where historical cleanup
   is warranted. *Already done for the current no-op/run-clock streams.*
2. **Genuine point-in-time metric** (counts, balances, rewards sampled at fetch
   time) → **split into an append-keyed stream.** Retain history as records.
   Never compact. Never exclude-without-moving (exclusion alone loses data).
3. **Semantic-state transition** (rename, archival, APR change, credit-limit
   increase) → keep as versions on the identity stream. Low-rate, expected.
   Dashboard should classify as *expected*, not alarm. Never compact.
4. **Field redundant with another retained field** (provably derivable) →
   exclusion allowed only with an explicit redundancy proof. None of the four
   has such a field today.

Compaction is allowed only for case 1, with the proof the existing tool already
enforces (excludeKeys mirrors a connector no-op gate one-for-one, dry-run
default, per-run backup, insert==delete assertion, owner-only DB auth,
fingerprint-parity fixture). Cases 2 and 3 are never compacted.

### Why a separate stream, not just keep the field

- A point-in-time stream is **append-keyed**: record key is
  `(<entity_id>, <observation_window>)`, not `<entity_id>`. Each observation is a
  *distinct record*, so `versions_per_record` stays ~1.0 — it grows in
  `record_count` (normal growth), not in churn (a smell). History we want to keep
  becomes **records, not versions**.
- The identity stream's fingerprint then excludes the moved field, so it emits a
  new version only on a real semantic transition (rename, APR change). That is
  exactly what version history is for, at the right (low) rate.

### Dashboard honesty (proposed, not yet decided)

Two additive refinements make the dashboard honest rather than merely quiet —
**without touching the numeric thresholds**:

- A per-stream **`version_disposition`** the connector declares in its manifest
  (`semantic_state` | `point_in_time` | `snapshot`), surfaced in the
  `record-version-stats` envelope. The dashboard can then label a legitimately
  versioning identity stream *"expected: semantic state history"* and an
  append stream *"time series — growth expected,"* instead of a red chip.
- The ratio engine (`watch ≥ 5`, `high ≥ 50` v/rec) stays **unchanged**, so an
  *undeclared* high-churn stream is still caught. Disposition is metadata, not a
  threshold override.

## Promotion trigger

Promote to OpenSpec before implementation. New manifest streams and the
`version_disposition` envelope field are durable contract (manifest fields +
reference observability surface). Specifically:

- A Collection-Profile clause stating the durable principle (append-key a
  per-observation point-in-time metric rather than re-version an entity
  snapshot) — protocol-adjacent connector contract.
- Per-connector manifest deltas adding the new streams.
- A reference-implementation-architecture delta for the `version_disposition`
  field in the `record-version-stats` envelope.

The owner decides whether this is one umbrella change or per-connector lanes.

## Owner review questions

1. **Approve the append-keyed point-in-time split** as the direction for
   real-field churn (vs. accept-the-churn / raise-thresholds / do-nothing)?
   *Recommendation: approve.* It is the only option meeting all three
   constraints. — **decision pending**
2. **One umbrella OpenSpec change or per-connector changes?** Four new streams
   (`github/user_stats`, `slack/channel_stats`, `usaa/account_balances`,
   `usaa/credit_card_balances`) plus one Collection-Profile clause. — **decision
   pending**
3. **Approve the `version_disposition` manifest field + dashboard surfacing,
   with thresholds frozen?** This modifies the normative `record-version-stats`
   envelope. — **decision pending**
4. **Confirm the USAA `credit_card_billing` cut line:** `annual_percent_rate`,
   `credit_limit_cents`, and `card_holders` **stay** on identity; balances /
   available-credit / rewards **move**. This is the only non-obvious split. —
   **decision pending**
5. **Observation key granularity:** `(entity_id, observation_date)` (one
   observation/day, collapses intra-day re-syncs) vs `(entity_id, run_id)`
   (one per run). *Recommendation: date granularity* — counts/balances don't
   meaningfully move intra-day; finer is an owner call. — **decision pending**

## Implementation packet

For the eventual implementation lane(s). **Not yet authorized** — gated on
owner questions above and an OpenSpec change.

### Proposed streams and key shape

| New stream | Key shape | Disposition |
| --- | --- | --- |
| `github/user_stats` | `(login, observation_date)` | `point_in_time` |
| `slack/channel_stats` | `(channel_id, observation_date)` | `point_in_time` |
| `usaa/account_balances` | `(account_id, observation_date)` | `point_in_time` |
| `usaa/credit_card_balances` | `(account_id, observation_date)` | `point_in_time` |

### Fields moved vs stayed

| Stream | Moved to new stream | Stays on identity stream |
| --- | --- | --- |
| `github/user` | `followers`, `following`, `public_repos`, `public_gists` | everything else |
| `slack/channels` | `num_members` | name/topic/purpose, `previous_names`, kind/archive flags |
| `usaa/accounts` | `balance_cents`, `available_balance_cents` | `id`, `type`, `name`, `last_four`, `status` |
| `usaa/credit_card_billing` | `current_balance_cents`, `available_credit_cents`, `cash_rewards_cents`, `billing_status`, `minimum_payment_met` | `annual_percent_rate`, `cash_advance_apr`, `credit_limit_cents`, `card_holders` |

### Tests needed (acceptance contract per lane)

- **AC-1 identity goes quiet:** two runs, volatile metric changed, no semantic
  change → identity stream emits exactly **one** version across both runs.
- **AC-2 no data loss:** both metric values retained as **two distinct records**
  in the point-in-time stream (different keys), readable via the normal records
  path.
- **AC-3 semantic transition still versions:** change a semantic field (slack
  rename / usaa APR) with metric held constant → identity stream emits a **new
  version**.
- **AC-4 USAA coupling:** a fixture where two runs differ only in `fetched_at` +
  balance → identity record is a legitimate no-op (balance now lives in the
  split stream); the balance change is captured as a new point-in-time record,
  not dropped.
- **AC-5 dashboard honesty:** `buildRecordVersionStatsEnvelope` returns the
  identity stream `normal` + `version_disposition: "semantic_state"`, the append
  stream `normal` + `version_disposition: "point_in_time"`; numeric
  `risk_thresholds` **unchanged**.
- **AC-6 compaction safety:** no new policy excludes a real field; any new policy
  (e.g. post-split USAA run-clock residue) carries a fingerprint-parity fixture
  mirroring the connector no-op gate.

### What becomes an OpenSpec change later

| Artifact | Capability | Why |
| --- | --- | --- |
| Append-keyed point-in-time clause | collection-profile (connector contract) | durable connector-modeling principle |
| `user_stats` / `channel_stats` / `account_balances` / `credit_card_balances` stream definitions | per-connector manifest | new manifest streams = durable contract |
| `version_disposition` envelope field | reference-implementation-architecture | modifies normative `record-version-stats` envelope |

### Recommended sequencing

1. **`github/user` → `github/user_stats` first** — the pure case (no run clock,
   no semantic mixing, no money). Proves the reference pattern.
2. `slack/channels → slack/channel_stats`.
3. USAA last (highest correctness stakes; money fields). Its run-clock half is
   already gated, so the split is the only remaining work, but the
   `currencyToCents` invariant must hold under AC-2/AC-4.

Each connector is its own narrow lane with AC-1…AC-6 as its validation contract.

## Decision log

- 2026-06-02 — Captured. Current no-op/run-clock churn is forward-fixed
  (`cd577ba7` closed the two USAA real-field streams' run-clock component);
  residual churn on the four streams above is now purely real-field. Direction
  proposed: append-keyed point-in-time split, thresholds frozen, no real-field
  exclusion or compaction. Awaiting owner decisions 1–5. Not promoted to
  OpenSpec yet.
