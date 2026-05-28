## Why

`define-reference-operation-environments` identifies consent and owner-device authorization storage as the right first storage proof: the data is security-sensitive, behavior is smaller than records/search, and the current SQLite implementation already has meaningful lifecycle tests.

Before extracting `ConsentStore` or `OwnerDeviceAuthStore`, the reference needs reusable conformance scenarios that pin the actual obligations: pending/approved/denied/expired state transitions, approval-id indirection, one-time exchange behavior, polling semantics, and no live secret leakage through lookup surfaces.

## What Changes

- Add a test-only conformance harness for pending consent and owner-device authorization behavior.
- Add a SQLite-backed driver that exercises the current reference auth implementation without production abstraction changes.
- Add a deliberately broken driver or negative proof so the harness is falsifiable.
- Keep all existing route-level auth/security tests; this harness complements them.
- Check off tasks only for the test harness and validation evidence.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Adds tests/helpers under `reference-implementation/test/**`.
- Does not add production stores, adapters, Postgres, or route refactors.
- Provides the evidence base for a later storage extraction proof.
