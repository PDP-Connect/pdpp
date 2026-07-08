## Context

RBS prior art used CDP field detection plus invisible local inputs to let the local browser and IME own typing while the remote stream catches up. The remote-surface package now contains the pure overlay planner and CDP detector expression, but no playground I/O shell drives those pieces live.

## Design

The playground server polls CDP for `RemoteSurfaceFormFieldSnapshot` values using the package detector expression. It emits snapshots only when the detected field list changes, matching the RBS changed-hash pattern without adding a new transport dependency.

The playground client owns the DOM overlay shell. It reconciles snapshots through `reconcileFormOverlayFields`, positions native inputs against the current contained stream rectangle, and runs text edits through `planFormOverlayValueCommit` and `planFormOverlaySpecialKeyCommit`. The planner remains the source of truth for append, deletion, replacement, submit, and composition deferral.

Overlay mode is a playground toggle. When disabled, the existing direct keyboard-proxy path remains the A/B baseline. When enabled, the scripted playground actions and real local typing use overlay controls and commit through the same WebSocket command path.

Overlay commit telemetry is labeled at the playground boundary by rewriting committed input traces to `overlay-commit`. This keeps the package adapter telemetry intact while making the acceptance panel prove which path the user exercised.

## Alternatives Considered

- Put DOM overlay code in the package client export now. Rejected for this tranche because the existing pure core is still being live-driven for the first time; the playground shell is the smallest place to expose live bugs before promoting a deeper reusable browser controller.
- Evaluate fields from the browser client. Rejected because the client should not receive raw CDP endpoint authority; the server-side FieldDetectionSource is the safer boundary for this playground.

## Acceptance Checks

- `openspec validate wire-remote-surface-form-overlay-playground --strict`
- `pnpm --filter @opendatalabs/remote-surface playground:verify`
- `pnpm --filter @opendatalabs/remote-surface verify`
- Headed playground smoke with overlay enabled: email, password, OTP, backspace, mid-edit replacement, and paste commit correctly.
