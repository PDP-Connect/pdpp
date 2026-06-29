## Why

The Overview source-attention panel now groups connection work from a shared projection, but other owner-console surfaces still read `rendered_verdict.required_actions[0]`, status pills, and legacy failure summaries through separate local helpers. That leaves room for drift: the same connection can read as urgent owner work in one surface and generic review or checking in another.

## What Changes

- Add a dashboard-local source actionability projection that exposes shared status, primary-action, owner-action, and source-work classification primitives.
- Wire Overview, Sources, Runs, and connection detail helpers to those primitives where they derive source status or owner actionability.
- Preserve surface-specific layout and run-history logic; this change does not alter server verdict synthesis, schedules, or connector execution.

## Capabilities

- Modified: `reference-connection-health`

## Impact

- Affects owner-console view-model code and tests.
- No public PDPP protocol or connector contract change.
- No database migration.
