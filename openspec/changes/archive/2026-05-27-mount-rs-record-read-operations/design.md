## Context

`define-reference-operation-environments` established that AS/RS behavior should live behind canonical operation capsules and that hosts (Fastify, Next sandbox, tests) should adapt requests and supply environment dependencies. The `rs.streams.list`, `rs.streams.detail`, and `rs.schema.get` proofs landed that pattern. Record-read is the next slice in the sequence: deferred until the record-read conformance harness, ingest atomicity, and delete atomicity changes had pinned the harder semantics.

The current state of the two routes:

- Native Fastify `GET /v1/streams/:stream/records` and `:id` resolve auth, manifest, grant, source descriptor, and instrumentation, then call `queryRecords` / `getRecord` from `server/records.js`. Several semantic decisions live in the route body: view/fields mutual exclusion, view → fields resolution against grant, manifest-not-found error mapping, owner read-grant construction, and request-param normalization.
- Sandbox `/sandbox/v1/streams/:stream/records` and `:id` import `buildLiveRecordsList` / `buildLiveRecordDetail` from `apps/web/src/app/sandbox/_demo/builders.ts` — a website-local AS/RS implementation parallel to the native server.

This is exactly the drift class operation extraction is meant to remove for record-read paths.

## Goals / Non-Goals

**Goals:**

- Define canonical `rs.records.list` and `rs.records.get` operation modules whose semantics are independent of HTTP framework, sandbox UI, concrete database driver, and `process.env`.
- Mount each operation from the native Fastify reference server and from the Next sandbox routes.
- Move sandbox record-read fixture wiring into `_demo/operations-fixtures.ts`.
- Delete `buildLiveRecordsList` and `buildLiveRecordDetail` so the public sandbox routes cannot import a parallel record-read implementation.
- Preserve existing public JSON shapes for both native and sandbox record-read routes.

**Non-Goals:**

- Do not extract a production `RecordStore` interface. The operation accepts capability-shaped dependencies that wrap the existing `queryRecords` / `getRecord` helpers.
- Do not touch cursor, `changes_since`, projection, range filter, view, `expand[]`, grant policy, or blob-ref decoration semantics. These flow through the dependencies unchanged.
- Do not introduce Postgres, Kysely, or a generic repository.
- Do not migrate aggregate, search, blobs, runs, traces, or `_ref` routes.
- Do not refactor `server/index.js` outside the two record-read routes.

## Decisions

### 1. Operation owns request normalization, visibility, and output shape; capability owns storage

The operation owns the host-independent slice of behavior:

- view/fields mutual exclusion, applied as a truthiness test against the raw host-supplied query values so non-string parsed shapes (arrays from `qs` repeated params, objects from `qs` bracketed params) still trigger the rejection — preserving the previous native `if (req.query.view && req.query.fields)` behavior;
- view → fields resolution against the grant (and the `field_not_granted` error when a view names ungranted fields);
- field/filter validation against the manifest stream;
- owner read-grant construction (`{streams: [{name}]}`);
- manifest stream visibility (returns `not_found` when the actor's manifest does not include the stream);
- output shape (list envelope vs single record);
- `query.received` and `disclosure.served` data-block fields populated from operation result counts.

Storage- and adapter-bound concerns stay behind dependencies:

- `queryRecords` capability: takes `(stream, grant, requestParams, manifest)` and returns `{data, has_more, next_cursor, next_changes_since}` exactly as today.
- `getRecord` capability: takes `(stream, recordId, grant, manifest, options)` and returns the raw record or `null`.
- `decorateRecord` capability: applies blob-ref URL decoration before the host writes the response.

The sandbox route wires the same capabilities against fixture data; the native route wires them against the existing `server/records.js` helpers and `decorateRecordBlobRefs`.

### 2. Hosts still own auth, instrumentation, and response writing

The host adapters retain:

- token/session authentication and `requireToken`-shaped pre-checks;
- request id / trace id assignment;
- `query.received` / `disclosure.served` event emission and `rejectQuery` error mapping;
- response writing (Fastify `res.json` / Next `Response`);
- sandbox demo headers and 404 envelope shape.

Operation-thrown visibility errors carry a typed code (`not_found`) so host adapters can map them to existing error shapes without re-deriving the rule.

### 3. Sandbox fixture dependencies live in `_demo/operations-fixtures.ts`

Following the existing `rs.streams.list` / `rs.streams.detail` / `rs.schema.get` pattern. The sandbox fixture module exposes `createSandboxRecordsListDependencies` and `createSandboxRecordDetailDependencies` factories. Route handlers are thin: parse params, call the operation with fixture deps, write the live-shaped response.

### 4. Operation modules MUST NOT import host or storage concretes

Same boundary as the existing operations: no Fastify, Next, SQLite, Postgres, raw DB modules, sandbox UI, or `process` / `process.env`. The shared `operation-boundary.js` gate enumerates the operations directory and enforces the rule for every operation, including the two new ones.

### 5. Public record-read JSON shape is preserved

The change is structural, not behavioral. Native and sandbox responses MUST remain byte-equivalent (modulo the previously-documented `url` field on the native list response). Existing `/v1/streams/:stream/records*` and `/sandbox/v1/streams/:stream/records*` route tests are the regression baseline.

## Risks / Trade-offs

- Operation grows too broad → keep the operation to record-read input normalization, visibility, and output shape; reject any storage extraction in this slice.
- Native instrumentation regresses → host retains ownership of `query.received`, `disclosure.served`, and `rejectQuery`. The operation only populates the data block fields.
- Sandbox output accidentally changes → existing `routes.test.ts` cases for sandbox records list/detail are the compatibility gate; the fixture dependency mirrors the previous builder behavior.
- Worker invents architecture vocabulary → names mirror existing operations (`executeRecordsList`, `RecordsListDependencies`, `RecordDetailVisibilityError`).

## Migration Plan

1. Add the two operation modules and reference-implementation `package.json` exports.
2. Add sandbox fixture dependency factories to `apps/web/src/app/sandbox/_demo/operations-fixtures.ts`.
3. Switch the native record-read routes to mount the operations, preserving auth, instrumentation, and `decorateRecordBlobRefs`.
4. Switch the sandbox record-read routes to mount the operations with fixture deps.
5. Delete `buildLiveRecordsList` and `buildLiveRecordDetail` from `_demo/builders.ts`.
6. Add operation tests, boundary tests, and run targeted validation.

Rollback: the operation module is additive until routes are switched. If a regression is found before merge, revert the route handlers and the builders deletion.

## Open Questions

- Whether the operation should validate `expand` / `expand_limit` shape (currently passed through to `getRecord` unchanged). Decision: keep the current behavior — `getRecord` still owns expand validation. The operation accepts the raw `expand` / `expand_limit` request params and forwards them through the dependency.
- Whether the manifest stream visibility check should run before view/fields validation. Decision: preserve current native ordering — manifest visibility (owner branch only) runs before view/fields validation; view/fields validation runs against the resolved manifest stream.
