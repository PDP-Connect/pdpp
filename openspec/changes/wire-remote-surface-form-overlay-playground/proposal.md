## Why

The remote-surface package already has form-overlay core logic and CDP form-field detection helpers, but the acceptance playground still drives text through the legacy proxy path. That leaves the native local input path unproven against a live browser.

## What Changes

- Add a toggleable form-overlay mode to the remote-surface playground.
- Stream detected remote form-field rectangles from the playground CDP driver to the browser client.
- Render local native controls over the video frame and commit edits through the existing overlay planner.
- Mark overlay-committed per-character telemetry with the `overlay-commit` input path.
- Extend playground acceptance coverage to exercise the form journey with overlay mode on and off.

## Capabilities

Added:
- `remote-surface-playground`

## Impact

- Scope is limited to `packages/remote-surface/` package playground, tests, and generated package output.
- No protocol semantics, hosted-service behavior, or connector runtime behavior changes.
