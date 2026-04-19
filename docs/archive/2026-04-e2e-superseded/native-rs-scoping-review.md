# Native RS Scoping Review

**Date:** 2026-04-16  
**Purpose:** Define the smallest safe implementation path to let native deployments avoid public `connector_id` while preserving explicit polyfill behavior.

## Bottom line

The safest first cut is:

> **keep `connectorId` as an internal storage/runtime key, but resolve it at the RS edge instead of requiring it in the native public contract**

That means:

- native deployments expose provider-local RS routes with no public `connector_id`
- personal-server/polyfill deployments keep explicit source scoping
- `e2e/server/records.js` stays unchanged for now
- `e2e/cli/commands/owner.js` splits native owner UX from polyfill owner UX instead of forcing one connector-shaped contract everywhere

This is the smallest safe path because the current connector assumption is concentrated in the RS route layer and owner CLI, while the query engine is already clean enough to treat `connectorId` as an internal source key.

---

## Current seam

The current public leak is at the RS boundary in [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:299):

- owner `GET /v1/streams` requires `connector_id`
- owner `GET /v1/streams/:stream` requires `connector_id`
- owner `GET /v1/streams/:stream/records` requires `connector_id`
- owner `GET /v1/streams/:stream/records/:id` requires `connector_id`
- owner delete/reset paths require `connector_id`

The internal query/storage layer in [e2e/server/records.js](/home/user/code/pdpp/e2e/server/records.js:279) is still keyed by `connectorId`, but that is acceptable for now. It is an implementation detail, not the public RS contract.

The owner CLI in [e2e/cli/commands/owner.js](/home/user/code/pdpp/e2e/cli/commands/owner.js:1) mirrors the leak by hard-requiring `--connector-id` for all owner commands.

So the first correction should happen at:

- RS route scoping resolution
- owner CLI argument/URL construction

Not at:

- record tables
- query planner
- versioning/change tracking

---

## Smallest safe path

## 1. Add one RS scoping resolver at the server boundary

Introduce one small helper in the RS app layer that resolves the effective source scope from deployment mode and request context.

It should return something like:

```js
{
  sourceKey,
  publicScope: 'native' | 'polyfill',
}
```

Behavior:

- `native` deployment:
  - ignore `req.query.connector_id`
  - return the fixed provider-local internal source key, e.g. `northstar_hr`
- `polyfill` deployment:
  - require explicit `req.query.connector_id` on owner paths
  - continue using that as the internal source key
- client-token paths:
  - continue deriving source key from `grant.connector_id` for now

This keeps the public RS contract clean for native deployments without forcing any immediate grant or storage rewrite.

## 2. Limit the code change to RS route wiring

Apply the resolver in [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:299) before calling:

- `listAllStreams`
- `listStreams`
- `getManifest`
- `queryRecords`
- `getRecord`
- `deleteAllRecords`
- `deleteRecord`

The route family can stay the same:

- `GET /v1/streams`
- `GET /v1/streams/:stream`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`

The difference is only:

- native path resolves source internally
- polyfill path keeps explicit source scoping

## 3. Do not touch `records.js` yet

Do **not** rename `connectorId` across the query/storage substrate in the first cut.

That would create avoidable churn in:

- query logic
- change tracking
- deletes/reset behavior
- state tables

For the first native-provider seam, `connectorId` can remain an internal lookup key. The public contract is what needs to change first.

## 4. Split owner CLI UX by realization

Update [e2e/cli/commands/owner.js](/home/user/code/pdpp/e2e/cli/commands/owner.js:1) so that:

- native provider mode does **not** require `--connector-id`
- polyfill mode still does

The cleanest first implementation is:

- native RS base URL implies provider-local owner access
- personal-server RS base URL continues to require `--connector-id`

That keeps CLI behavior honest:

- native: `pdpp owner streams --rs-url https://northstar.example`
- polyfill: `pdpp owner streams --rs-url https://ps.example --connector-id gusto_payroll`

Do not fake a unified UX by silently defaulting `--connector-id` in the CLI. The distinction is real and should remain visible where the realization is genuinely multi-source.

---

## What not to do in the first cut

- Do not add native-only alternate routes like `/v1/native/streams`
- Do not introduce a new generic `source` query param on both realizations just to hide the word `connector`
- Do not refactor grant serialization yet
- Do not rewrite storage tables away from `connector_id`
- Do not make the personal-server path implicitly scoped; that would make multi-source owner access ambiguous

Those moves are broader than necessary for the first honest native seam.

---

## Top 3 regression risks and tests

## 1. Native owner paths still fail without `connector_id`

### Risk

The route resolver gets applied inconsistently, so one or more native owner endpoints still return:

- `400 invalid_request`
- `connector_id required`

### Test

Add native-provider owner tests for:

- `GET /v1/streams`
- `GET /v1/streams/:stream`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`

with:

- owner token
- no `connector_id`

Expected:

- success
- correct native-provider stream metadata and records

## 2. Polyfill owner paths become ambiguously scoped

### Risk

In making native mode implicit, the personal-server path accidentally becomes permissive or silently defaults one source, breaking the explicit multi-source model.

### Test

Keep owner tests on the polyfill path asserting:

- missing `connector_id` still fails
- the right source returns the right stream inventory
- a mismatched source does not leak records from another source

This is the main honesty check for the personal-server realization.

## 3. Native and polyfill query semantics diverge

### Risk

The native seam gets fixed only for route selection, but projection, `changes_since`, view resolution, or record lookup behave differently because manifest/source resolution was not wired consistently.

### Test

Add paired tests across native and polyfill realizations for the same stream-level operations:

- list streams
- query records with projection
- query records with `changes_since`
- get record by id

Expected:

- same RS behavior
- same response shape
- only the source-scoping contract differs

This ensures the reference demonstrates one PDPP RS model, not two subtly different ones.

---

## Recommendation

The first implementation should:

1. add one RS scoping resolver in `e2e/server/index.js`
2. keep `records.js` untouched
3. split owner CLI behavior by realization
4. add native-path no-`connector_id` tests plus polyfill explicit-scoping regression tests

That is the smallest safe cutline that makes the native provider path honestly connector-free in public while leaving the personal-server/polyfill path explicit and intact.
