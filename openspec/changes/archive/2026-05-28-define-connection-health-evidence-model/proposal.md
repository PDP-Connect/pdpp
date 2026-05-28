## Why

The reference implementation can collect data successfully while still presenting the owner with ambiguous or stale health. The recent GitHub failure showed the gap: a rejected token surfaced as a generic connector failure, and a later successful run was still overshadowed by stale scheduler backoff. That is not a presentation-only problem. The backend needs a typed evidence model that preserves the essential facts before deriving UI, CLI, API, or MCP status.

## What Changes

- Introduce a reference connection-health evidence model with three layers: raw facts, typed conditions, and derived projections.
- Make readiness, credential validity, runtime availability, schedule state, owner attention, source coverage, outbox/backlog, and projection reliability first-class conditions.
- Require safe diagnostic and remediation metadata for owner-facing failures without leaking secrets.
- Require currentness rules so stale scheduler or runtime facts cannot override newer successful collection evidence.
- Require dashboard, CLI, and owner-control-plane APIs to consume the same health projection instead of each reinterpreting run history.

## Capabilities

### New Capabilities

- `reference-connection-health`: Defines typed connection health evidence, condition derivation, shared projections, and owner remediation semantics for the reference implementation.

### Modified Capabilities

- None.

## Impact

- Affects reference server health/readiness projection, connector run failure diagnostics, scheduler state interpretation, and operator-console connection health UI.
- Does not change the PDPP core protocol, grant enforcement, or grant-scoped records APIs.
- Enables a single implementation tranche to replace ad hoc failure labels with auditable, testable evidence.
