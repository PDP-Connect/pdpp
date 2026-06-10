# Design — split USAA balances into append-keyed observation streams

This change applies the Family-2 observation-stream construction accepted in
`split-point-in-time-observation-streams` to `usaa/accounts` and
`usaa/credit_card_billing`. The keying, idempotency, and entity-fingerprint
rules are identical to `github/user_stats`, `slack/channel_stats`, and
`ynab/account_stats`. Two facts are USAA-specific: the runs are full dashboard
scans (so the entity cursors keep pruning, unlike YNAB's delta-sync), and
`credit_card_billing` has a wider field surface whose split line needs a
documented rationale.

## Scope

| Stream | Sampled metric fields → observation | Entity / identity / settings fields → entity | Construction |
| --- | --- | --- | --- |
| usaa / accounts | `balance_cents`, `available_balance_cents` | `id`, `type`, `name`, `last_four`, `status` | fingerprint entity (full-scan prune); append-key stats |
| usaa / credit_card_billing | `current_balance_cents`, `available_credit_cents`, `cash_rewards_cents`, `billing_status`, `minimum_payment_met` | `id`, `account_id`, `account_nickname`, `credit_limit_cents`, `annual_percent_rate`, `cash_advance_apr`, `card_holders` | fingerprint entity (full-scan prune); append-key stats |

## Observation-stream keying

Both `_stats` records use the composite key `{entity_id}:{YYYY-MM-DD}` (UTC
date), exactly as the prior Family-2 streams. The record key is the connector
runtime's `data.id`, so the builders set `id = "${entityId}:${observedOn}"`,
where `entityId` is the same id the entity record uses (`buildAccountRecord`'s
`id` for accounts, `buildCreditCardBillingRecord`'s `id` for cards). This gives:

1. **Time series preserved** — one record per entity per calendar day.
2. **Idempotent within a day** — a same-day re-run with identical balances
   produces the same key and the same content; the runtime byte-equivalence
   check collapses the re-emit to zero new versions.
3. **Real change preserved** — a balance move on the same day overwrites the
   day's record with the new value; a move on a later day appends a new record.

Each `account_stats` record carries `account_id`; each
`credit_card_billing_stats` record carries `card_id` and `account_id` so the
observation series stays joinable back to the entity stream and `accounts`.

`observed_on` is derived from `nowIso().slice(0, 10)` at emit time, the same UTC
date source the other Family-2 connectors use. Tests pass `observedOn`
explicitly to the builders so assertions never depend on system time.

## Entity-stream fingerprinting (unchanged gate, narrower body)

After the split the entity records no longer carry any moved field. The existing
per-record fingerprint cursors (`excludeFromFingerprint: ["fetched_at"]`,
established by `extend-usaa-real-field-churn-incidental-gates`) remain in place
and are correct over the narrowed body: the entity record now re-emits only when
an identity or settings field actually changes. No new cursor wiring is needed
on the entity side — only the record body shrinks.

Both USAA entity streams are **full dashboard scans** (every account/card the
dashboard lists is re-extracted every run), so their cursors keep calling
`pruneStale()`: a disappeared account/card is dropped from the fingerprint map so
its re-appearance re-emits. This is the structural difference from
`ynab/accounts`, whose `server_knowledge` delta-sync forbids pruning. The
observation `_stats` streams are append-keyed and never pruned — a daily record
is history, not current-scan state.

## Field classification for credit_card_billing (the ambiguous part)

`credit_card_billing` has eleven non-`id`/non-`fetched_at` fields. Three are
unambiguously volatile balances and three are unambiguously settings; the rest
needed a decision. The rule applied: a field belongs in the **observation**
stream iff its value is *sampled at polling frequency and moves on ordinary
account activity*; it belongs in the **entity** stream iff it changes only on a
*discrete account event a human or the bank takes* (a limit increase, an APR
change, a nickname edit, an authorized-user change).

| Field | Disposition | Rationale |
| --- | --- | --- |
| `current_balance_cents` | observation | Moves on every purchase/payment. Canonical point-in-time balance. |
| `available_credit_cents` | observation | `credit_limit − current_balance`; moves whenever the balance moves. |
| `cash_rewards_cents` | observation | Accrues with spend; ticks continuously between redemptions. |
| `billing_status` | observation | The per-cycle "Minimum payment met / due" string; flips each statement cycle and as payments post. A cycle status, not account identity. |
| `minimum_payment_met` | observation | Derived from `billing_status` (`/met/i`); same cadence, so it tracks the same stream to stay internally consistent. |
| `credit_limit_cents` | **entity** | Changes only on a discrete credit-limit decision by the bank/cardholder — a real account event, rare, worth one entity version each time. Not a polling-frequency sample. |
| `annual_percent_rate` | **entity** | APR changes are discrete repricing events (promo expiry, rate change notice), not daily ticks. Stored as a display string. |
| `cash_advance_apr` | **entity** | Same class as `annual_percent_rate`. |
| `account_nickname` | **entity** | User-chosen label; changes only on a deliberate edit. |
| `card_holders` | **entity** | Authorized-user roster; changes only on an add/remove event. |
| `account_id` | **entity** | Relationship/identity foreign key. |

The borderline cases are `billing_status` / `minimum_payment_met` (cycle state,
not a number) and `credit_limit_cents` (a balance-adjacent integer that is
nonetheless a settings value). Decisions:

- **`billing_status` + `minimum_payment_met` → observation.** They change at
  statement-cycle frequency and on payment posting — closer to a sampled metric
  than to durable card identity. Putting them on the entity stream would
  re-version the card on every cycle flip even though nothing about the card's
  identity changed; that is exactly the point-in-time churn this change removes.
  A consumer wanting the *current* cycle status reads the latest
  `credit_card_billing_stats` record, the same way it reads the current balance.

- **`credit_limit_cents` → entity.** A credit-limit change is a genuine account
  event and is rare. Keeping it on the entity means a limit increase produces one
  honest entity version. It is *not* recomputed from the balance, so it does not
  inherit the balance's polling cadence. Keeping it out of the observation stream
  also avoids implying a daily limit time-series that does not exist.
  Consequence: `available_credit_cents` (observation) and `credit_limit_cents`
  (entity) live in different streams; a consumer reconstructing "credit
  utilization on day D" joins the day's `credit_card_billing_stats` to the
  current entity `credit_limit_cents`. This is acceptable — the limit is
  effectively constant across the window between limit-change events.

If a future maturity decision wants `credit_limit_cents` history, it can be
added to the observation stream without removing it from the entity; that is a
separate, additive change and is out of scope here.

## Worked trace (credit_card_billing, card CC1, full scan)

1. Run 1 (cold): dashboard lists CC1. Entity emits (no prior fp). Stats emits
   `CC1:D1` with the day's balance/rewards/status. Cursor stores fp(CC1).
2. Run 2 same day, balance moved: dashboard lists CC1. Entity fingerprint
   unchanged (no settings field moved) → **entity skipped**. Stats emits
   `CC1:D1` again with the new balance → runtime overwrites the day's record.
3. Run 3 next day, balance moved again: entity skipped. Stats emits `CC1:D2` →
   new day, new record.
4. Run 4, credit limit raised: entity fingerprint changed (`credit_limit_cents`)
   → **entity re-emits** one genuine version. Stats emits the day's record.
5. Run 5, CC1 closed and gone from dashboard: entity loop runs zero times for
   CC1; `pruneStale()` drops CC1 from the entity fingerprint map so a
   re-appearance re-emits. Stats for CC1 are not touched (history is kept).

The net effect: balance/rewards/cycle-status ticks accumulate as a daily time
series in the observation streams and never version the entity record; identity
and settings edits still version the entity record exactly once each.

## Backwards compatibility

The entity records drop the moved fields. This is an intentional field-level
breaking change, mirroring the github/user, slack/channels, and ynab/accounts
splits, mitigated by:

1. The new `_stats` streams carrying the same data, keyed for time series.
2. Both entity and `_stats` streams declared in the manifest.
3. The moved fields removed from the entity schemas and their `range_filters` so
   the break is explicit, not a silent `null`. A reader that needs a current
   balance reads the latest `_stats` record for the entity.

`usaa/accounts` and `usaa/credit_card_billing` are not in any shipped profile's
stream list except the default (all-streams) selection, and the `reconciliation`
profile includes neither entity, so no profile view needs rewiring.

## Acceptance checks

- `node --test --import tsx packages/polyfill-connectors/connectors/usaa/account-stats.test.ts`
- `node --test --import tsx packages/polyfill-connectors/connectors/usaa/credit-card-billing-stats.test.ts`
- `node --test --import tsx packages/polyfill-connectors/connectors/usaa/accounts-fingerprint.test.ts` (entity gate still green over narrowed body)
- `node --test --import tsx packages/polyfill-connectors/connectors/usaa/credit-card-billing-fingerprint.test.ts` (same)
- `node --test --import tsx packages/polyfill-connectors/bin/reconcile-manifests.test.ts` (manifest/schema/emit alignment for the four streams)
- `node --test --import tsx packages/polyfill-connectors/connectors/usaa/parsers.test.ts`
- `node --test --import tsx packages/polyfill-connectors/connectors/usaa/integration.test.ts`
- `pnpm --dir packages/polyfill-connectors run typecheck`
- `openspec validate split-usaa-account-balance-observation-streams --strict`
- `git diff --check`

## Out of scope

- Other USAA streams (`transactions` balance_after_cents is a per-transaction
  field on an append-style stream, not entity-version churn; `statements`,
  `inbox_messages` carry no sampled metric).
- `credit_limit_cents` history (additive, deferred — see classification above).
- Compaction of historical pre-split entity records (owner-gated separately;
  `register-current-churn-compaction-policies` /
  `extend-usaa-real-field-churn-incidental-gates` own the Family-1 policies for
  the entity streams, which stay valid for the narrowed bodies).
- Production live `--apply` compaction.
- Live browser re-capture / fixture regeneration (owner-only; the new builders
  are pure and unit-tested without a browser).
