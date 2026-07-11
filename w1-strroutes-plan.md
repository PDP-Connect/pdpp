# w1-strroutes decomposition plan

## Target and gates

Target: `reference-implementation/server/streaming/routes.js`.

The quality-ratchet configuration uses `maxAllowedComplexity: 5`. An isolated
Biome run reproduces the orchestrator's baseline exactly: 27 diagnostics and
236 excess cognitive-complexity mass. This is a semantic defect, not only a
large-file metric: one registration closure currently braids mint policy,
browser-surface selection, companion ownership, telemetry, SSE lifecycle,
input dispatch, and an HTTP/WebSocket reverse proxy.

Implementation remains blocked by the red covering baseline recorded in
`w1t-report.md`. Orchestrator approval of this design does not waive the PIN
gate: the covering tests must first run green with the mandated command.

Hard constraints:

- Preserve the `registerStreamingRoutes` export, dependency object, returned
  `invalidateForInteractionResolved`, `handleUpgrade`, and `_internal` shape.
- Keep every route path, auth middleware placement, response status/body/header,
  SSE event name/payload/order, proxy behavior, and timeline event unchanged.
- Preserve `runtime/browser-surface/remote-surface-optional.ts` exactly. It
  remains the sole optional runtime seam for `@opendatalabs/remote-surface/leases`.
  No extracted module will import that shim or the leases package directly.
- Keep the static `@opendatalabs/remote-surface/protocol` import in `routes.js`;
  protocol parsing/building is not made optional and the existing reference
  boundary assertion continues to hold.
- Route declarations stay in `routes.js`. Extracted modules provide behavior;
  the reference server continues to own the `/_ref` and `/neko` HTTP surface.
- No test expectation changes without stopping for orchestrator approval.

## Chosen seams

### 1. Pure mint policy: `server/streaming/stream-mint-policy.js`

This module owns the rules for deciding whether an interaction may mint a
stream and which ready leased surface, if any, satisfies that request. It will
contain pure functions that interpret timeline events and validate a supplied
lease/surface snapshot. Decisions return data:

- success: interaction kind plus an optional companion target;
- failure: `{ status, code, message, param }`;
- effect request: the identifiers needed to read events or a surface.

`routes.js` remains the effectful apply layer: it calls
`controller.getPendingInteraction`, `listRunEventsPage`, and the injected lease
manager, then feeds the results back to the pure decisions and converts a
failure decision to the existing `pdppError` response.

Why this is a real boundary: assistance-event interpretation and lease/surface
invariant matching are policy over plain data. They change when assistance or
allocation semantics change, independently of Fastify, SSE, proxying, or
companion lifecycle. The module will not import `routes.js`, Fastify, the lease
package, or the optional-dependency shim. It replaces the current implicit
policy/effect braid rather than moving the `resolveMintScope` closure intact.

Current attributable mass: 35. Expected residual mass in this module: at most
12, using guard clauses, a terminal-event set, and explicit decision records.

### 2. Per-session runtime ownership: `server/streaming/companion-runtime.js`

This module owns mutable state keyed by `browser_session_id`: companion
instances, remote-telemetry unsubscribe handles, and the input telemetry ring.
Its cohesive facade will expose only the operations the routes need:

- inspect the companion map/get a companion (including the existing `_internal`
  compatibility exposure);
- ensure a companion exists for a minted session;
- dispatch parsed input while recording received/dispatched/error telemetry;
- read telemetry since a cursor;
- destroy a companion and all associated best-effort resources.

The module will decide the telemetry records as data first, then apply the
best-effort pushes and companion effects. `routes.js` retains token
authorization, wire parsing, HTTP error mapping, and response construction.

Why this is a real boundary: the three mutable resources have the same
lifetime and ownership key and must be created/cleaned together. Hiding that
lifecycle makes cleanup locally provable and prevents routes from coordinating
three maps/rings manually. This is deeper than a one-call wrapper: one small
lifecycle API hides creation, replay reuse, remote-sink wiring, dispatch
instrumentation, and teardown. It will not know route paths or response shapes.

Current attributable mass: 44. Expected residual mass: at most 18, mainly from
best-effort effect boundaries that remain explicit.

### 3. SSE transport lifecycle: `server/streaming/sse-channel.js`

This module owns one attached EventSource connection: header setup, wire-event
serialization, frame/event subscriptions, frame acknowledgement, keepalive,
per-connection cleanup, terminal teardown, companion startup/backend settling,
and the opened/resolved timeline effects supplied by the caller.

Its handler receives an already-attached session and companion. Therefore
token authorization and the `companion_unavailable` HTTP decision stay in
`routes.js`; after hijacking, the SSE module owns the transport lifecycle. The
existing distinction between a socket close (connection-only cleanup) and a
terminal failure (session invalidation and companion destruction) remains an
explicit invariant.

Why this is a real boundary: SSE connection lifetime is independent of mint
policy and n.eko proxying, and it has its own resource invariants. The module
replaces a substantial transport state machine with a small `open` interface;
it is not a renamed route callback. Protocol payload builders are passed in
from `routes.js`, preserving the protocol import and avoiding a reverse import.

Current attributable mass: 24. Expected residual mass: at most 12 after pure
frame/event decisions and guard-clause cleanup.

### 4. n.eko reverse-proxy transport: `server/streaming/neko-proxy.js`

This module owns the n.eko-specific boundary end to end: allowed-origin
validation, stream-cookie handling, target URL rewriting, request header/body
projection, embed HTML transformation, HTTP forwarding, upgrade forwarding,
viewer entry/config, and status probing. A factory returns the route handlers
and upgrade handler; `routes.js` binds those handlers to the unchanged paths.

The refactor will split decisions from effects:

- pure decisions build validated origin/path/header/body/config/error data;
- effectful apply functions set cookies, write Fastify/raw HTTP responses,
  open upstream requests/sockets, and pipe bodies;
- status-code/reason mappings become tables rather than nested ternaries.

Why this is a real boundary: it is a complete HTTP/WebSocket gateway with a
distinct security policy and transport lifecycle. Its proxy rules change with
n.eko embedding/deployment, not with stream mint or SSE semantics. The module
will receive `streamingSessions`, `getCompanion`, and configuration explicitly;
it will not import `routes.js`, lease infrastructure, or remote-surface. The
factory hides roughly 400 lines of coherent gateway behavior behind handlers,
so this is a deep module rather than relocation into a helper bag.

Current attributable mass: 89. Expected residual mass: at most 30 after the
decision/apply split, guard clauses, and table-driven forwarding rules.

## What stays in `routes.js`

- The exported composition root and dependency validation.
- All literal route declarations and owner-auth middleware placement.
- `pdppError`, run-id decoding, stream-reach input clamps, and the timeline
  emitter adapter.
- Mint orchestration: read external state, invoke pure mint decisions, call the
  session store, and construct the existing response.
- Stream-reach beacon validation/response.
- Token authorization and HTTP mapping for SSE, input telemetry, input dispatch,
  and viewport routes.
- Viewport normalization/backend dispatch and the public invalidation hook.
- The static remote-surface protocol import and all wire-contract construction.

Small repeated auth/error branches stay local unless a table can flatten them;
I will not create a shallow `session-auth` module merely to improve the score.

## Expected mass movement

The 236 baseline partitions as follows:

| Concern | Current excess | Destination / treatment |
| --- | ---: | --- |
| n.eko gateway | 89 | `neko-proxy.js`, reduced to <=30 |
| mint policy | 35 | `stream-mint-policy.js`, reduced to <=12 |
| companion runtime + input telemetry | 44 | `companion-runtime.js`, reduced to <=18 |
| SSE lifecycle | 24 | `sse-channel.js`, reduced to <=12 |
| route composition/contracts | 44 | stays in `routes.js`, then locally flattened |
| **Total** | **236** | **expected combined touched-file mass <=120** |

Extraction alone is not counted as improvement. The gate measures
`routes.js` and every extracted module together. Expected `routes.js` mass is
below 60 (hard requirement: below 100); expected combined mass is at most 120,
a material reduction of at least 116. If a module merely inherits its source
mass, that step fails review and is revised rather than committed.

## Planned coherent steps after sign-off and a green PIN

1. Extract and verify `stream-mint-policy.js`; keep effects and wire responses
   in `routes.js`.
2. Extract and verify `companion-runtime.js`; preserve replay reuse, telemetry
   best-effort behavior, teardown order, and `_internal.companions` identity.
3. Extract and verify `sse-channel.js`; preserve emitted bytes/event ordering
   and connection-only versus terminal cleanup.
4. Extract and verify `neko-proxy.js`; preserve the optional remote-surface seam
   and all HTTP/WebSocket/cookie behavior.
5. Flatten the remaining route callbacks with guard clauses and tables, without
   introducing another module.

Each bounded mechanical step will go to the requested cheaper Codex worker only
after sign-off. I will review its actual diff, run the covering suite and
complexity measurement, read every touched file, and commit the coherent step
as `Tim Nunamaker <tnunamak@gmail.com>`.

## Test expectations

No expectation change is planned for
`test/run-interaction-stream-routes.test.js`; its existing cases cover mint
policy, managed-surface scoping, replay, SSE, input, viewport, reach failure,
n.eko HTTP/status, and invalidation behavior.

One existing expectation is already suspect and currently makes the PIN red:
`test/remote-surface-reference-boundary.test.js` reads the removed
`packages/remote-surface/README.md`. The likely oracle repair is to assert the
external optional-dependency boundary through
`runtime/browser-surface/remote-surface-optional.ts` instead. Per protocol, I
will not make or propose an exact expectation diff during implementation; the
orchestrator must approve that oracle change separately. The first boundary
test's expectation that `routes.js` imports
`@opendatalabs/remote-surface/protocol` is intentionally preserved.
