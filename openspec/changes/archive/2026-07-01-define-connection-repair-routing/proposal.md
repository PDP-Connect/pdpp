## Why

Recent browser-session repair failures exposed a design risk: manifest hints, run assistance, connection health, and owner-action UI can blur static connector capabilities with live source state. The reference needs a durable boundary before adding more connector-specific setup or repair semantics.

## What Changes

- Define connector manifests as stable declarations of setup, automation, and repair mechanisms, not current credential/session/browser readiness.
- Require live repair state to be derived from observed runtime evidence and connection-scoped health conditions.
- Require connector/runtime repair requests to use a small bounded owner-action protocol, with provider-specific instructions carried as runtime evidence rather than manifest schema.
- Treat existing refresh-policy/auth-repair hints such as assisted-after-owner-auth as compatibility metadata until replaced by the bounded mechanism model.
- Require scheduled/unattended runs to defer owner-mediated repair and surface connection repair state instead of repeatedly opening interactive repair flows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `polyfill-runtime`: Clarifies the boundary between manifest-declared capabilities and runtime-observed repair state.
- `reference-run-assistance`: Clarifies that owner repair actions are runtime assistance/required-action events selected from bounded action surfaces.
- `reference-connection-health`: Clarifies that connection repair state is evidence-derived, connection-scoped, and closed by proof rather than by age or run-local strings.

## Impact

- Affects manifest schema interpretation, setup planning, scheduled run gating, connection-health synthesis, dashboard actionability, and browser-backed connector repair paths.
- Does not change PDPP Core semantics.
- Does not make browser automation a protocol requirement; it remains a reference/polyfill mechanism.
- Requires follow-up implementation and tests before any new manifest field or UI copy is treated as final.
