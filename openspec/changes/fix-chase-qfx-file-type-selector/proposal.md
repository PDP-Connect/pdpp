## Why

Chase `transactions` has a live pending detail gap from `qfx_download_failed`.
The failing path timed out selecting the QFX file-type control even though the
connector had already broadened selector constants for two observed Chase id
families.

## What Changes

- Reuse one QFX file-type selector family for both form-load detection and
  file-type selection.
- Add a semantic combobox fallback for the Chase file-type control.
- Add a focused regression test so the form-load wait cannot drift from the
  selection selector family again.

## Capabilities

Modified:
- `polyfill-runtime`

## Impact

- Affected code: Chase polyfill connector and tests.
- No protocol, database, or owner-dashboard contract changes.
- Live closure still requires an owner-mediated Chase retry because Chase is
  manual, OTP-likely, and not background-safe.
