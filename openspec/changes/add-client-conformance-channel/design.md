## Decision

The suite exposes a separate `ClientUnderTest` contract beside `TargetAdapter`. The suite owns a local AS+RS fixture, and the fixture request log is the observation surface. Client actions return only wire-level outcomes needed by cases; they do not expose client internals.

The fixture supports controlled error, cursor, expiry, and request-log responses. Each case runs once with the conforming client and once with one deliberately defective behavior. The negative run must fail the same case, which proves that the observation can discriminate the clause.

The proof client uses the PDPP MCP package's resource-server transport behavior as a small vendored adapter because the available checkout exposes the built transport but not its source package boundary. The Vana Context Gateway remains a documented stub until a gateway binding can route traffic to the fixture and expose its request log.

## Alternatives

- Reuse `TargetAdapter`: rejected because it makes client behavior an unobservable side effect of target tests.
- Inspect client internals: rejected because it would not prove the wire behavior of a client package.
- Use a real external service: rejected because deterministic injected defects and request capture require a local fixture.

## Acceptance Checks

- All eleven listed client-capture MUST clauses have matrix case IDs.
- A clean client passes all eleven cases and every injected defect fails its paired case.
- The package test, lint, typecheck, matrix, and accounting checks pass.
