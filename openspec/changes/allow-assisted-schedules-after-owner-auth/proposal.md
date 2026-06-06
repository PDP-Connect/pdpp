## Why

Browser-backed connectors can be safe to run on a schedule after the owner has established an authenticated browser session, while still needing owner attention when that session expires. The current manifest honesty rule treats every `needs_human_auth` connector as permanently manual, which blocks explicit ChatGPT schedules even after capped live runs proved bounded progress without source pressure.

## What Changes

- Add a refresh-policy hint for assisted scheduling after owner auth is bootstrapped.
- Permit a `needs_human_auth` manifest to declare `recommended_mode: "automatic"` and `background_safe: true` only when it also declares that assisted-after-auth posture.
- Keep `needs_human_auth` connectors excluded from automatic schedule enrollment on server boot.
- Update ChatGPT to use the assisted scheduled posture with conservative interval policy and bounded owner-attention copy.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `polyfill-runtime`: Refresh policy hints gain an assisted-after-owner-auth declaration.
- `reference-implementation-architecture`: Manifest honesty and schedule enrollment rules distinguish explicit owner-enabled assisted schedules from automatic enrollment.

## Impact

- Affected manifests: `packages/polyfill-connectors/manifests/chatgpt.json`.
- Affected validation/tests: manifest validator, public-listing honesty tests, schedule control tests, run automation policy tests.
- No PDPP Core protocol surface changes.
