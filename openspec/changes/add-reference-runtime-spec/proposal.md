## Why

The cleanup audit found that reference-runtime behavior is proven by tests and active program work but lacks a durable canonical OpenSpec capability. Scheduler behavior, runtime validation, browser-profile binding, filesystem bindings, connector runtime logging, and inbox/notification behavior should not graduate from `add-polyfill-connector-system` as unbounded implementation history.

## What Changes

- Create a focused follow-up change for a canonical `reference-implementation-runtime` spec.
- Inventory shipped and pending runtime behavior before writing normative details.
- Separate reference-specific runtime guarantees from root PDPP Collection Profile semantics.
- Defer product decisions to the follow-up implementation tasks rather than resolving them in cleanup.

## Capabilities

### Added Capabilities

- `reference-implementation-runtime`: canonical home for reference-specific runtime behavior after the polyfill connector program is ready to graduate.

## Impact

- No runtime behavior changes in this stub.
- Future spec work under this change may affect `reference-implementation/runtime/**`, `packages/polyfill-connectors/**`, reference tests, and runtime documentation.
