## 1. Playground Overlay Wiring

- [x] Add server-side CDP field snapshot polling using the package detector expression.
- [x] Add WebSocket messages for form-field snapshots and overlay commit operations.
- [x] Add a playground UI toggle for form overlay mode.
- [x] Render local native overlay controls over detected remote fields.
- [x] Execute overlay commit plans through adapter text/key operations.

## 2. Telemetry and Tests

- [x] Label overlay-committed per-character telemetry as `overlay-commit`.
- [x] Extend acceptance coverage for overlay-off and overlay-on journeys.
- [x] Rebuild generated package output.

## 3. Acceptance Checks

- [x] `openspec validate wire-remote-surface-form-overlay-playground --strict`
- [x] `pnpm --filter @opendatalabs/remote-surface playground:verify`
- [x] `pnpm --filter @opendatalabs/remote-surface verify`
- [x] Headed live smoke for overlay email, password, OTP, backspace, mid-edit, and paste.
