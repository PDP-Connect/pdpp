## Why

Configured reference connector runs can still treat a missing per-connection provider credential as permission to use deployment-wide provider-account environment variables. That contradicts the source-scoped credential model and obscures whether a source is healthy, misconfigured, or relying on an operator-global account.

## What Changes

- Reference-server manual, scheduled, and retry launches for static-secret/provider-account connectors fail closed when the targeted connection has no active source-scoped credential.
- Non-static-secret connectors, manual-upload sources, and provider-authorization sources continue to use their existing connection-scoped setup material.
- Standalone connector execution may still read connector-declared environment variables; the removed fallback is only the configured reference-server run path.
- Tests replace the legacy "missing credential falls back to process env" expectation with "missing credential refuses launch before child spawn."

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-connector-instances`: configured connector-instance runs must use source-scoped provider-account credentials or fail closed; they must not use deployment-wide provider-account env as a substitute.

## Impact

- Affected code: reference run env resolver in `reference-implementation/server/index.js`, runtime comments/contracts, and static-secret run tests.
- Affected behavior: configured sources without a stored source-scoped credential will report a typed credential-unavailable failure instead of spawning a child that may use deployment-wide env.
- No schema or dependency changes.
