## 1. Resolver Contract

- [x] 1.1 Update the reference-server static-secret run env resolver so static-secret connectors call the store-backed resolver without a metadata precheck.
- [x] 1.2 Update controller, scheduler, and runtime comments/types so `null` means "not a static-secret connector/setup family", not "missing static-secret credential may use process env".

## 2. Tests

- [x] 2.1 Replace the controller legacy-env fallback test with a fail-closed missing-credential test that proves no child spawn.
- [x] 2.2 Add or update scheduled-path coverage for missing static-secret credentials so scheduled launches fail before child spawn rather than falling through to process env.
- [x] 2.3 Keep positive coverage for per-connection credential injection and non-static-secret connector behavior.

## 3. Validation

- [x] 3.1 Run targeted static-secret controller and scheduler tests.
- [x] 3.2 Run static-secret store/registry tests covering connector mappings.
- [x] 3.3 Run `openspec validate enforce-connection-scoped-provider-credentials --strict`.
