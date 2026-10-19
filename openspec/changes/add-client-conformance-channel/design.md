## Decision

The suite exposes a separate `ClientUnderTest` contract beside `TargetAdapter`. The suite owns a local AS+RS fixture, and the fixture request log is the observation surface. Client actions return only wire-level outcomes needed by cases; they do not expose client internals.

The fixture supports controlled error, cursor, expiry, and request-log responses. Each case runs once with the conforming client and once with one deliberately defective behavior. The negative run must fail the same case, which proves that the observation can discriminate the clause.

The in-package client-under-test harness drives a local fixture and exposes its outbound requests. A third-party implementation can provide its own `ClientUnderTest` adapter when it can drive the fixture and expose its requests.

## Alternatives

- Reuse `TargetAdapter`: rejected because it makes client behavior an unobservable side effect of target tests.
- Inspect client internals: rejected because it would not prove the wire behavior of a client package.
- Use a real external service: rejected because deterministic injected defects and request capture require a local fixture.

## Acceptance Checks

- All eleven listed client-capture MUST clauses have matrix case IDs.
- A clean client passes all eleven cases and every injected defect fails its paired case.
- The package test, lint, typecheck, matrix, and accounting checks pass.
