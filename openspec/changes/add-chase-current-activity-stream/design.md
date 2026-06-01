## Context

The Chase connector currently treats QFX/Web Connect as the canonical transaction export. Its `transactions` stream is `append_only`, keyed by QFX `FITID`, and documented as posted-only. Recent live testing showed a mismatch: Chase's account activity UI displayed pending and recent activity while the QFX download flow returned a no-activity confirmation.

That mismatch is expected for pending rows and may also occur for very fresh posted rows. The correct response is not to weaken `transactions`; it is to expose a separate stream whose semantics match the source surface.

## Goals / Non-Goals

**Goals:**

- Preserve `transactions` as a posted-only QFX ledger stream.
- Expose fresh Chase UI-visible activity in a separate `current_activity` stream.
- Include pending rows only in `current_activity`.
- Make the new stream honest about volatility, identity limits, and double-counting risk.
- Use fixtures from live Chase surfaces before relying on selectors.

**Non-Goals:**

- Do not reconcile pending UI rows into QFX `FITID` records in this change.
- Do not claim `current_activity` is a settled accounting ledger.
- Do not change PDPP core stream semantics.
- Do not add broad bank-wide pending-transaction semantics beyond Chase reference behavior.

## Decisions

### Keep QFX transactions posted-only

`transactions` remains the canonical posted ledger because QFX provides stable `FITID` values and append-only semantics. Pending UI rows do not have the same durability guarantee.

Alternative considered: insert pending rows into `transactions` with synthetic IDs and later update them. This was rejected because it contradicts append-only semantics and risks duplicate or mutated ledger records.

### Add `current_activity` as a sibling stream

`current_activity` represents the Chase account activity table visible at scrape time. It may include pending rows and recently posted rows. Consumers can opt into freshness without mistaking those rows for settled QFX transactions.

Alternative considered: add a narrower `pending_transactions` stream. This was rejected for the initial reference implementation because the relevant UI surface can include both pending and posted current-cycle rows.

### Use mutable-state semantics

The stream uses `mutable_state` semantics because UI-visible activity can change amount, descriptor, date, status, or disappear. The reference implementation should upsert by primary key and can later emit tombstones if it implements full current-snapshot reconciliation.

### Prefer source IDs, fall back conservatively

If Chase exposes a UI/native transaction ID, use `account_id|ui_transaction_id`. If not, use a deterministic fallback scoped to account, status, visible date, amount, and normalized description. The fallback is stable for identical scrape input, but it does not promise pending-to-posted identity continuity.

## Risks / Trade-offs

- UI selector churn can under-collect current activity. Mitigation: require fixture-backed parser work before accepting implementation.
- Fallback IDs may not preserve identity across pending-to-posted transitions. Mitigation: document `current_activity` as visibility data and keep durable posted identity in QFX `transactions`.
- Consumers may double count if they combine `current_activity` and `transactions` naively. Mitigation: stream descriptions and fields must clearly label status and source.
- Pending bank data may change after collection. Mitigation: include `status`, `source`, and `fetched_at`; do not advertise rows as settled.

## Open Questions

- Should the reference implementation emit tombstones for current activity rows missing from a later scrape, or rely on `fetched_at` freshness initially?
- Should a later cross-bank capability define generic pending/current financial activity semantics, or should this remain connector-specific until more banks are implemented?

## Residual Risks

### Stable native ID availability (live-only, owner-gated)

Existing raw Chase captures and network traces did not include a current-activity surface with native row IDs. The fixture-backed implementation therefore operates under the assumption that stable UI or network transaction IDs may not be reliably present, and uses a deterministic fallback key scoped to `account_id`, `status`, visible date, amount, and normalized description.

Whether the live Chase account activity surface exposes stable native IDs (in DOM attributes, JSON payloads, or XHR responses), and whether such IDs survive pending-to-posted transitions, has not been confirmed. This requires a live Chase session, which is an owner-only check outside the fixture-backed implementation scope.

**Architectural response already in place:** The connector prefers `account_id|ui_transaction_id` when a UI ID is present, and falls back to the deterministic composite key otherwise. The `current_activity` stream is modeled as `mutable_state` volatile visibility data, not as a settled ledger. Durable posted identity remains in QFX `transactions` keyed by `account_id|fitid`.

**Action if native IDs are discovered:** If a live investigation confirms that Chase exposes stable native transaction IDs for the current-activity surface, the connector key strategy in `packages/polyfill-connectors/` should be updated to prefer those IDs, and this residual risk should be retired. No protocol or schema change is required — the `ui_transaction_id` field already exists in the schema to hold such a value.
