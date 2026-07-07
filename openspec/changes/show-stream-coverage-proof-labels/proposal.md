## Why

Source detail rows can show a stream as complete while the count line reads like a shortfall, for example `9 / 52 collected`. That is confusing when the stream is complete because a declared coverage strategy and committed checkpoint prove the boundary.

## What Changes

- Render strategy-backed complete streams by naming the proof (`checkpoint covered`, `inventory covered`, etc.) instead of rendering a collected/considered fraction.
- Preserve collected and considered counts in the hover/title text.
- Keep non-strategy streams on the existing collected/considered and covered/considered labels.

## Capabilities

- Modified: `reference-connection-health`

## Impact

- Owner-console Sources/detail stream rows become clearer for connector streams whose coverage is proved by checkpoint, inventory, snapshot, singleton, or parent-detail strategy.
- No server API, connector, or database contract changes.
