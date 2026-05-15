## 1. Source Capture

- [ ] 1.1 Capture or locate a Chase account activity fixture that includes pending rows and current-cycle posted rows.
- [ ] 1.2 Determine whether the live Chase activity surface exposes stable UI transaction IDs in DOM attributes or network payloads.

## 2. Stream Contract

- [ ] 2.1 Add `current_activity` to the Chase manifest with `mutable_state` semantics, clear display copy, primary key, searchable fields, and range fields.
- [ ] 2.2 Add a Chase current activity schema with `id`, `account_id`, `account_name`, `status`, `activity_date`, `posted_date`, `amount`, `currency`, `description`, `memo`, `ui_transaction_id`, `source`, and `fetched_at`.
- [ ] 2.3 Keep the existing `transactions` manifest and schema posted-only/QFX-only.

## 3. Connector Implementation

- [ ] 3.1 Implement a fixture-backed parser for Chase current activity rows.
- [ ] 3.2 Prefer source UI IDs for `current_activity` keys and add a deterministic fallback key for rows without UI IDs.
- [ ] 3.3 Emit pending and UI-visible current-cycle rows to `current_activity` only when that stream is requested.
- [ ] 3.4 Ensure pending rows are never emitted to `transactions`.

## 4. Validation

- [ ] 4.1 Validate Chase manifest/schema reconciliation after adding the stream.
- [ ] 4.2 Verify parser fixtures emit both pending and posted UI-visible rows into `current_activity`.
- [ ] 4.3 Verify existing QFX transaction behavior remains posted-only and `account_id|fitid` keyed.
- [ ] 4.4 Run the relevant connector and reference implementation checks.
