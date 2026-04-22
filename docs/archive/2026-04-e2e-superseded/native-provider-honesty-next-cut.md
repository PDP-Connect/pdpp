# Native Provider Honesty: Next Cut

Date: 2026-04-16

## 1. Current honest native strengths

The native-provider path is already materially more honest than the earlier polyfill-first shape.

- Native mode hides connector-registry and Collection Profile operational routes from the public surface.
  - `POST /connectors` and `GET /connectors/:connectorId` only exist when `!nativeMode` in [e2e/server/index.js](/e2e/server/index.js:335).
  - `POST /v1/ingest/:stream`, `GET /v1/state/:connectorId`, and `PUT /v1/state/:connectorId` are also hidden behind `!nativeMode` in [e2e/server/index.js](/e2e/server/index.js:712).
- Owner reads against the native provider do not require public `connector_id`.
  - `resolveOwnerConnectorScope()` auto-resolves the native backing store when `nativeConnectorId` is configured in [e2e/server/index.js](/e2e/server/index.js:134).
  - Owner `/v1/streams` and `/v1/streams/:stream/records` both rely on that implicit native scope in [e2e/server/index.js](/e2e/server/index.js:536) and [e2e/server/index.js](/e2e/server/index.js:582).
- Client grants against the native provider can be requested without a public `connector_id`.
  - The request normalizer falls back to `opts.nativeConnectorId` and marks the binding as `provider_native` in [e2e/server/auth.js](/e2e/server/auth.js:79).
  - The consent surface suppresses the connector label when `binding_kind === 'provider_native'` in [e2e/server/index.js](/e2e/server/index.js:380).
- The test suite already proves the two most important public-native behaviors:
  - hidden connector/runtime routes in [e2e/test/pdpp.test.js](/e2e/test/pdpp.test.js:319)
  - client grants without public `connector_id` in [e2e/test/pdpp.test.js](/e2e/test/pdpp.test.js:347)
  - owner queries without public `connector_id` in [e2e/test/pdpp.test.js](/e2e/test/pdpp.test.js:386)
- Northstar HR has a native-feeling domain model already.
  - `pay_statements` is a plausible first-party payroll stream in [e2e/manifests/northstar-hr.json](/e2e/manifests/northstar-hr.json:1).

## 2. Remaining impurities

These are the places where the native path still fundamentally thinks in connector-shaped terms.

- The native request normalizer still resolves native identity through `connector_id` and stores it as a connector binding.
  - `resolvedConnectorId = detail.connector_id || opts.nativeConnectorId` in [e2e/server/auth.js](/e2e/server/auth.js:79)
  - `realization_binding.connector_id = resolvedConnectorId` in [e2e/server/auth.js](/e2e/server/auth.js:101)
- Native grants are still persisted as connector-bound grants and the public grant object still includes `connector_id`.
  - Grant object includes `connector_id` in [e2e/server/auth.js](/e2e/server/auth.js:410)
  - Grants table insert still writes `connector_id` in [e2e/server/auth.js](/e2e/server/auth.js:421)
  - Client-token introspection returns the full stored `grant`, which therefore still carries `connector_id`, in [e2e/server/auth.js](/e2e/server/auth.js:739)
- The RS query path still treats native reads as connector-scoped internally, not provider-scoped.
  - Owner full-access grants synthesize `grant = { connector_id, streams: [...] }` in [e2e/server/index.js](/e2e/server/index.js:603)
  - Client token paths still pull `connectorId = grant.connector_id` in [e2e/server/index.js](/e2e/server/index.js:608) and [e2e/server/index.js](/e2e/server/index.js:695)
  - Stream listing for client tokens still calls `listStreams(grant.connector_id, grant)` in [e2e/server/index.js](/e2e/server/index.js:546)
- The manifest/catalog lookup for native mode still goes through the connector registry table.
  - `startServer()` auto-registers `opts.nativeManifest` using `registerConnector()` in [e2e/server/index.js](/e2e/server/index.js:796)
  - `getManifest(connectorId)` is still the only catalog lookup path in [e2e/server/auth.js](/e2e/server/auth.js:249)
- The owner CLI still presents the native provider as a special case of connector-scoped access rather than a clean provider-scoped mode.
  - Help text: `--connector-id is required for polyfill/personal-server owner access and optional for native-provider owner access` in [e2e/cli/commands/owner.js](/e2e/cli/commands/owner.js:74) and [e2e/cli/index.js](/e2e/cli/index.js:32)
- The reference inspection surface still assumes every manifest is a connector manifest.
  - `renderManifest()` outputs `connector_id` as the primary manifest identity in [e2e/cli/commands/inspect.js](/e2e/cli/commands/inspect.js:53)

## 3. Single best next implementation cut

### Recommendation

Introduce a **connector-neutral source binding** for grants and RS lookups, then use it to remove `connector_id` from the native public/grant path.

In practical terms, the next cut should do this:

- keep the existing record storage keyed by the current native backing id internally for now
- but stop treating that id as the native provider’s public identity
- change native grant normalization and native owner/client query resolution to use a provider-scoped source reference, e.g. `source_ref` / `provider_ref` / `native_store_ref`, instead of `connector_id`
- stop emitting `grant.connector_id` for native grants
- stop synthesizing owner full-access native grants with `connector_id`
- add one internal resolver that maps native provider scope -> current backing store id before calling `getManifest`, `listStreams`, `queryRecords`, and `getRecord`

### Why this is the best next cut

It fixes the deepest remaining dishonesty in one place:

- today, the native path is mostly a routing illusion over a connector-shaped internal contract
- hiding more routes or polishing more copy will not change that
- once the grant/query identity path becomes connector-neutral, Northstar HR will stop reading like “a connector-backed provider with nicer public URLs”

### Why not something else first

- Not CLI copy cleanup first: useful, but cosmetic.
- Not catalog-table refactoring first: internal-only and lower leverage.
- Not a richer Northstar stream set first: improves the specimen world, but does not fix the contract leak.

The best next cut is the one that changes what the native provider **is**, not just how it looks.
