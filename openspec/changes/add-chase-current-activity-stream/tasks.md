## 1. Source Capture

- [x] 1.1 Add a synthetic Chase account activity fixture that includes pending rows and current-cycle posted rows. Live current-activity capture remains pending.
- [ ] 1.2 Determine whether the live Chase activity surface exposes stable UI transaction IDs in DOM attributes or network payloads. Existing raw captures/traces did not include a current-activity surface with row IDs; implementation therefore prefers UI IDs when present and otherwise uses documented fallback keys.

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
