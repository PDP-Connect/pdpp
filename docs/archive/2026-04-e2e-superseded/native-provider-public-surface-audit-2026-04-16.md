# Native-Provider Public-Surface Audit

**Date:** 2026-04-16  
**Scope:** `e2e/` native-provider/public-surface boundary  
**Question:** Where do connector/polyfill semantics still leak into the native realization or public contract?

## 1. Current honest parts

- **Native mode hides the obvious polyfill-only routes.** The AS only mounts `/connectors` when `!nativeMode`, and the RS only mounts Collection Profile / reset routes when `!nativeMode`. That keeps connector registry, ingest, and state endpoints off the native public surface.  
  Refs: [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:335), [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:712)

- **Owner self-export is connector-free on the native public path.** In native mode, owner RS calls resolve to the configured native source without requiring `connector_id` in the query string.  
  Refs: [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:134), [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:537), [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:595), [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:386), [e2e/test/cli.test.js](/home/user/code/pdpp/e2e/test/cli.test.js:358)

- **Native client grants can omit public `connector_id`.** Grant initiation falls back to `opts.nativeConnectorId` and marks the binding as `provider_native`, so callers do not have to send `connector_id` in the native case.  
  Refs: [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:79), [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:84), [e2e/test/pdpp.test.js](/home/user/code/pdpp/e2e/test/pdpp.test.js:347)

- **The discovery surface is realization-neutral.** RFC 8414 and RFC 9728 metadata do not expose connector semantics. From a provider-discovery point of view, the native surface already looks like a provider, not a connector host.  
  Refs: [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:163), [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:516)

## 2. Remaining impurities

- **Grant normalization is still storage-scope-shaped under the hood.** Native mode now stores `storage_connector_id` instead of canonizing `connector_id` directly in the public binding, but the internal request still derives native scope from `opts.nativeConnectorId`. That is cleaner than before, but still means the first-class native binding is backed by a connector-keyed storage identity.  
  Refs: [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:79), [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:94), [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:116)

- **Approved grants are publicly cleaner but still persisted on connector-keyed substrate.** Native grants now serialize around `source` rather than leaking a top-level `connector_id`, but `approveGrant()` still resolves manifests and persistence through `storage_connector_id`, and the `grants` table still stores that value in its `connector_id` column.  
  Refs: [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:401), [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:451), [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:464), [e2e/server/db.js](/home/user/code/pdpp/e2e/server/db.js:24)

- **RS query resolution is publicly `source`-based but still emits internal storage identity in reference traces.** Stream listing and record queries now resolve native/public source identity through helper functions, but the event spine still carries `storage_connector_id` in query/disclosure data. That is acceptable for reference-only inspection, but it keeps the internal substrate visible.  
  Refs: [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:154), [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:163), [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:627), [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:652)

- **Storage is still entirely connector-keyed.** Records, change tracking, sync state, blobs, and version counters are all keyed by `connector_id`. That is fine as temporary substrate, but it still means native honesty depends on a resolution layer staying intact above the storage model.  
  Refs: [e2e/server/db.js](/home/user/code/pdpp/e2e/server/db.js:99), [e2e/server/db.js](/home/user/code/pdpp/e2e/server/db.js:126), [e2e/server/db.js](/home/user/code/pdpp/e2e/server/db.js:158), [e2e/server/db.js](/home/user/code/pdpp/e2e/server/db.js:181)

## 3. Single highest-leverage next cleanup

**Keep the storage schema as-is, but make the internal request/grant/query model explicitly `source`-first and connector-adapter-second.**

Concretely:

- keep `storage_connector_id` as the internal persistence key for now
- avoid reintroducing `connector_id` into native request/grant/query objects
- keep `connector_id` as a polyfill-only adapter field on the personal-server/Collection Profile path
- continue driving native AS/RS logic from `source` / provider-local helpers, with storage lookup hidden behind that layer

**Why this is the highest-leverage move:** the public native contract is already much cleaner. The remaining work is to stop older planning and future code changes from accidentally re-centering the connector substrate just because it still exists underneath.
