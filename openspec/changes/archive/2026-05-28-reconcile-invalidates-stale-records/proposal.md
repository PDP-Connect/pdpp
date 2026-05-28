## Why

`pdpp seed` registers reference fixture manifests under the same `connector_id` as the shipped polyfill manifests (e.g. `spotify`, `github`, `reddit`) and emits seed/fake records into the resource server. On the next reference startup, polyfill manifest reconciliation overwrites the persisted manifest with the polyfill version — but the seed-emitted records are never invalidated. They linger in the RS under seed IDs (`spotify:artist:0L8ExT028jH3ddEcZwqJJ5` "Taylor Swift", `seedowner/personal-site`, etc.), interleaved with whatever real records arrive from the real polyfill connector once an operator runs it.

A reviewer or operator looking at the dashboard cannot tell which records are seed-fake and which are real. The reference is meant to be honest — fake fixture data must not be advertised as fresh real data. This is a trust failure for the audience the reference targets (investors, engineers, standards reviewers).

The fix must be narrowly targeted at the seed → polyfill transition. Ordinary polyfill manifest evolution (description tweaks, schema additions, new `semantic_fields`, version bumps with the same stream set) is the common case and **must not** delete real owner records as a side effect.

## What Changes

- Compute a stable `(version, sorted-stream-names)` fingerprint for both the persisted manifest and the shipped polyfill manifest, plus the manifest in `reference-implementation/manifests/<id>.json` (the fixture served by the deterministic seed connector).
- During reconciliation, when the persisted and shipped manifests are not structurally equal, only invalidate records when **both** of these hold:
  1. The persisted manifest's fingerprint matches the reference-fixture fingerprint for that `connector_id`.
  2. The shipped polyfill manifest's fingerprint differs from the reference-fixture fingerprint.
- That criterion fires exactly on the `pdpp seed` → polyfill transition. Every other manifest diff (description, semantic_fields, view additions, polyfill version bumps) re-registers the manifest and **preserves** records.
- Invalidation removes records, record_changes, version counters, blob bindings, and lexical/semantic indexes for the affected connector. The next real connector run repopulates from source.
- Log every invalidation so the operator can audit the contract that fired.
- Leave manifests with custom or third-party `connector_id`s alone (reconciliation already scopes itself to shipped polyfill ids).

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: adds the requirement that startup manifest reconciliation invalidates records exactly on the reference-fixture → polyfill transition and preserves records on every other manifest diff.

## Impact

- `reference-implementation/server/polyfill-manifest-reconcile.ts` — adds fingerprint loading and the narrow transition predicate, invokes the new invalidation hook only on the gated branch.
- `reference-implementation/server/auth.js` — already the registration entry point; reconciliation continues to call it after invalidation (or directly, on ordinary diffs).
- `reference-implementation/server/records.js` — adds `deleteAllRecordsForConnector(connectorId)` helper.
- `reference-implementation/test/polyfill-manifest-reconcile-invalidation.test.js` — new test covering the seed flip, four preservation cases, and the existing no-op / first-registration / direct-register cases.
- No protocol wire-format change. No client-visible API change beyond the operator log line.
