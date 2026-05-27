## ADDED Requirements

### Requirement: HTTP route handlers SHALL be organized by route family
The reference implementation SHALL decompose its HTTP route handlers into per-family adapter modules under `reference-implementation/server/routes/<family>.ts`. Each family adapter SHALL be a TypeScript module that registers a coherent set of routes (e.g. root and discovery, `_ref` operations, RS reads, RS mutations, AS OAuth, run interaction, web push, source webhooks, remote surface). The reference SHALL NOT keep all HTTP route handlers in a single composition module.

#### Scenario: Route adapters live beside other server-only wiring
- **WHEN** an HTTP route family is extracted from `reference-implementation/server/index.js`
- **THEN** its adapter module SHALL be placed at `reference-implementation/server/routes/<family>.ts`
- **AND** the adapter SHALL be a TypeScript module participating in the existing reference-implementation Biome `includes` and `tsconfig.json` `include` globs

#### Scenario: The composition root retains capability wiring
- **WHEN** a family adapter is mounted into the AS or RS Express-shaped app
- **THEN** `reference-implementation/server/index.js` SHALL remain the composition root that owns `buildAsApp`, `buildRsApp`, capability construction, store factories, controller wiring, and `app.use(...)` global middleware
- **AND** the composition root SHALL call the family adapter's mount function at the same point in the route-registration order as the previous inline registration

### Requirement: Route-family extractions SHALL preserve observable behaviour
A route-family extraction SHALL preserve every protocol-observable property of the moved routes: middleware order, owner-session and client-bearer authentication posture, request-id and trace-id propagation, response headers (including `Request-Id`, `Reference-Revision`, `PDPP-Version`, and the AS clickjacking defenses `X-Frame-Options` and `Content-Security-Policy: frame-ancestors 'none'`), content negotiation on the AS and RS root, response envelope shape, status codes, and spine event emission.

#### Scenario: Middleware order is preserved
- **WHEN** a family adapter registers a route that previously took ordered route-level middleware
- **THEN** the same middleware SHALL run in the same order before the route's handler
- **AND** the transport's contract-validation pre-handler (when the route's contract operation id is on the request-validation allowlist) SHALL continue to run after route-level middleware and before the handler

#### Scenario: Response envelope and status codes are unchanged
- **WHEN** a family adapter responds to a moved route
- **THEN** the response status code, headers, and envelope shape SHALL match the pre-extraction behaviour byte-for-byte for successful and well-known failure cases

#### Scenario: Content-negotiated root remains correct
- **WHEN** an AS or RS root (`/`) handler is moved into `server/routes/root-and-discovery.ts`
- **THEN** browser-shaped requests SHALL receive the existing operator/admin landing HTML
- **AND** JSON-shaped requests SHALL receive the existing discovery envelope from `executeAsDiscoveryIndex` (AS) or `executeRsDiscoveryIndex` (RS)

### Requirement: Route-family adapters SHALL NOT introduce a new layer abstraction
Route-family extractions SHALL be mechanical adapter splits over the existing operations boundary at `reference-implementation/operations/*`. They SHALL NOT introduce a router, controller, service object, repository, or domain-driven aggregate layer beyond what already exists.

#### Scenario: An adapter calls an operation directly
- **WHEN** a family adapter handles a route that previously delegated to `operations/<op>`
- **THEN** the adapter SHALL continue to call that operation directly, with the same capability arguments and the same store/controller bindings
- **AND** the adapter SHALL NOT wrap the operation in an additional indirection layer

#### Scenario: An adapter avoids new abstractions even when convenient
- **WHEN** more than one family adapter would benefit from a small helper (e.g. resolving the owner subject id from a request)
- **THEN** that helper SHALL be either a local function inside the family adapter or an exported helper from an existing module (`owner-auth.ts`, `ref-record-utils.ts`, etc.)
- **AND** the change SHALL NOT introduce a new global mount-context type unless multiple family adapters demonstrably need the same wide context bundle
