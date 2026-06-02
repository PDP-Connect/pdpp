## 1. Source Capture

- [x] 1.1 Add a synthetic Chase account activity fixture that includes pending rows and current-cycle posted rows. Live current-activity capture remains pending.
- [x] 1.2 Converted to residual/live-only observation. Existing raw captures did not include a current-activity surface with native row IDs; the implementation prefers UI IDs when present and uses a documented deterministic fallback otherwise. Whether the live Chase surface exposes stable native IDs, and whether the fallback key survives pending-to-posted transitions, requires a live Chase session to confirm; this is an owner-only check outside the fixture-backed implementation scope. The architectural response (prefer native IDs, fall back conservatively, treat `current_activity` as volatile visibility data) is captured in `design.md` under Residual Risks. No code change is needed unless native IDs are discovered to exist and differ from the current key strategy.

## 2. Stream Contract

- [x] 2.1 Add `current_activity` to the Chase manifest with `mutable_state` semantics, clear display copy, primary key, searchable fields, and range fields.
- [x] 2.2 Add a Chase current activity schema with `id`, `account_id`, `account_name`, `status`, `activity_date`, `posted_date`, `amount`, `currency`, `description`, `memo`, `ui_transaction_id`, `source`, and `fetched_at`.
- [x] 2.3 Keep the existing `transactions` manifest and schema posted-only/QFX-only.

## 3. Connector Implementation

- [x] 3.1 Implement a fixture-backed parser for Chase current activity rows.
- [x] 3.2 Prefer source UI IDs for `current_activity` keys and add a deterministic fallback key for rows without UI IDs.
- [x] 3.3 Emit pending and UI-visible current-cycle rows to `current_activity` only when that stream is requested.
- [x] 3.4 Ensure pending rows are never emitted to `transactions`.

## 4. Validation

- [x] 4.1 Validate Chase manifest/schema reconciliation after adding the stream.
- [x] 4.2 Verify parser fixtures emit both pending and posted UI-visible rows into `current_activity`.
- [x] 4.3 Verify existing QFX transaction behavior remains posted-only and `account_id|fitid` keyed.
- [x] 4.4 Run the relevant connector and reference implementation checks.
