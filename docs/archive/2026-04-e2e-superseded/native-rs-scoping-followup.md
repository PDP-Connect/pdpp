# Native RS Scoping Follow-up

**Date:** 2026-04-16  
**Purpose:** Review the current `e2e/server` and `e2e/cli` owner-path surfaces for connector-scoping assumptions and define the smallest safe code cut for a native provider mode.

## Bottom line

The smallest safe cut is still:

- keep `connector_id` as an internal storage/runtime key for now
- remove the **public** `connector_id` requirement only from **native owner RS query surfaces**
- keep explicit `connector_id` on the personal-server/polyfill owner path

That means the first change should live almost entirely in:

- `e2e/server/index.js`
- `e2e/cli/commands/owner.js`
- `e2e/cli/index.js`

and **not** in:

- `e2e/server/records.js`
- `e2e/server/db.js`
- Collection Profile ingest/state routes

## Current owner-path assumptions

### Server: query/read surfaces

The current owner RS contract is connector-scoped at the route layer in [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:1):

- `GET /v1/streams`
  - owner path requires `req.query.connector_id`
- `GET /v1/streams/:stream`
  - owner path accepts `grant?.connector_id || req.query.connector_id`
  - in practice this means owner access still needs explicit connector scoping
- `GET /v1/streams/:stream/records`
  - owner path requires `req.query.connector_id`
  - synthesizes a full-access owner grant using that connector
- `GET /v1/streams/:stream/records/:id`
  - owner path requires `req.query.connector_id`
  - synthesizes a full-access owner grant using that connector

### Server: owner mutation/runtime surfaces

These are also connector-scoped in [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:1), but they should remain out of scope for the first native RS cut:

- `DELETE /v1/streams/:stream/records`
- `DELETE /v1/streams/:stream/records/:id`
- `POST /v1/ingest/:stream`
- `GET /v1/state/:connectorId`
- `PUT /v1/state/:connectorId`

These are operational/polyfill/runtime surfaces, not the native query contract we are trying to clean up first.

### CLI

The owner CLI mirrors the same assumption in [e2e/cli/commands/owner.js](/home/user/code/pdpp/e2e/cli/commands/owner.js:1):

- `owner streams` hard-requires `--connector-id`
- `owner query` / `owner records` hard-require `--connector-id`
- `owner get` hard-requires `--connector-id`
- `owner export` hard-requires `--connector-id`

The global help text in [e2e/cli/index.js](/home/user/code/pdpp/e2e/cli/index.js:1) also hardcodes `--connector-id` into every owner command example.

## Smallest safe code cut

## 1. Add one owner-source resolver at the RS edge

Add one small helper in `e2e/server/index.js` that resolves the effective source key for **owner query/read routes**:

- native mode:
  - ignore `req.query.connector_id`
  - resolve one provider-local internal source key, e.g. `northstar_hr`
- polyfill mode:
  - require `req.query.connector_id`
  - keep using it as the internal source key

This helper should be used only on:

- `GET /v1/streams`
- `GET /v1/streams/:stream`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`

It should **not** be applied yet to ingest/state/delete routes.

## 2. Keep internal records/query substrate unchanged

Do not rename or refactor `connectorId` inside:

- `e2e/server/records.js`
- `e2e/server/db.js`

The current storage and query layer can continue to treat `connectorId` as an internal source key for the first native-provider cut. The problem is the public RS contract, not the internal key name.

## 3. Split CLI owner UX by realization

Update `e2e/cli/commands/owner.js` and `e2e/cli/index.js` so:

- native owner mode does **not** require `--connector-id`
- polyfill owner mode still does

The smallest safe CLI behavior is:

- if `--connector-id` is provided, send it
- if `--connector-id` is omitted, allow the request and let the RS decide whether the target is native or polyfill

This keeps the CLI honest without inventing new mode flags too early.

## Exact touch points

### Must-touch files

- [e2e/server/index.js](/home/user/code/pdpp/e2e/server/index.js:1)
  - `GET /v1/streams`
  - `GET /v1/streams/:stream`
  - `GET /v1/streams/:stream/records`
  - `GET /v1/streams/:stream/records/:id`

- [e2e/cli/commands/owner.js](/home/user/code/pdpp/e2e/cli/commands/owner.js:1)
  - remove unconditional `--connector-id` requirement
  - conditionally append `connector_id` only when present

- [e2e/cli/index.js](/home/user/code/pdpp/e2e/cli/index.js:1)
  - update owner help examples so `--connector-id` is optional, not mandatory
  - note that polyfill realizations still require explicit source scoping

### Probably do not touch in the first cut

- [e2e/server/records.js](/home/user/code/pdpp/e2e/server/records.js:1)
- [e2e/server/db.js](/home/user/code/pdpp/e2e/server/db.js:1)
- [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:1)
- [e2e/server/metadata.js](/home/user/code/pdpp/e2e/server/metadata.js:1)

Metadata may eventually want to advertise scoping mode, but that is not required for the smallest safe native read-path cut.

## Top regression risks

## 1. Polyfill owner access becomes ambiguously scoped

If the server starts defaulting an owner source in polyfill mode, owner self-export can silently read the wrong source.

What to protect:

- personal-server/polyfill owner reads must still fail without `connector_id`
- no silent default source in polyfill mode

## 2. Native owner reads are fixed only partially

One or more owner query/read routes can still demand `connector_id`, especially:

- `GET /v1/streams/:stream`
- `GET /v1/streams/:stream/records/:id`

What to protect:

- native owner token, no `connector_id`, all four read routes succeed

## 3. Operational/polyfill-only routes get swept into the native cut

If ingest/state/delete routes are changed at the same time, the cut gets larger and riskier than necessary.

What to protect:

- `POST /v1/ingest/:stream`
- `GET/PUT /v1/state/:connectorId`
- owner delete/reset routes

should stay explicitly source-scoped until the native runtime story is intentionally designed.

## 4. CLI silently papers over server differences

If the CLI invents a default connector locally, it hides the real realization boundary and makes debugging worse.

What to protect:

- CLI should stop hard-requiring `--connector-id`
- CLI should not silently synthesize one
- RS remains the source of truth for whether the target is native or polyfill

## Recommendation

Implement native owner scoping as a route-layer resolution change plus a small CLI relaxation. Keep everything below the RS edge connector-keyed for now, and keep runtime/polyfill operational routes explicitly source-scoped until the native runtime model is designed on purpose.
