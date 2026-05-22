## 1. Design And Contracts

- [ ] 1.1 Promote the retained-size/data-explorer design note into this
  OpenSpec change.
- [ ] 1.2 Define retained-size measure names, units, grains, freshness fields,
  and top-N row shape.
- [ ] 1.3 Define owner-only `_ref` endpoint envelopes for dataset size and
  top-N retained-size rows.
- [ ] 1.4 Validate the OpenSpec change in strict mode before implementation.

## 2. Projection Storage

- [ ] 2.1 Add active-backend projection storage for retained-size rows at
  global, connection, stream, and optional record-family grains.
- [ ] 2.2 Add active-backend projection storage for bounded top-N rows.
- [ ] 2.3 Preserve or migrate existing dataset-summary projection behavior so
  the dashboard summary can be served from the same retained-size substrate.
- [ ] 2.4 Keep SQLite default behavior and Postgres mode behavior aligned.

## 3. Projection Maintenance

- [ ] 3.1 Update record upsert/delete paths to maintain current-record and
  history measures for affected grains.
- [ ] 3.2 Update blob insert/binding paths to maintain blob measures for
  affected grains.
- [ ] 3.3 Mark dirty rows when exact incremental maintenance is unsafe.
- [ ] 3.4 Rebuild retained-size rows and top-N rows from canonical records,
  record changes, and blobs.
- [ ] 3.5 Reconcile dirty retained-size rows without connector reruns.

## 4. Reference Reads

- [ ] 4.1 Add `GET /_ref/dataset/size` as a bounded projection read with
  global, connection, stream, and record-family grain filters.
- [ ] 4.2 Add `GET /_ref/dataset/top` as a bounded projection read with
  capped result size and finite measure/scope values.
- [ ] 4.3 Update dashboard data access to use retained-size projection rows
  where it currently performs unbounded per-connection retained-size scans.
- [ ] 4.4 Update generated reference route docs/OpenAPI if applicable.

## 5. Validation

- [ ] 5.1 Add focused tests for global, connection, and stream retained-size
  row maintenance.
- [ ] 5.2 Add focused tests for rebuild, dirty/stale metadata, and top-N cap.
- [ ] 5.3 Add Postgres-gated tests proving retained-size reads use Postgres
  projection rows and ignore stale SQLite projection rows.
- [ ] 5.4 Run relevant reference tests, typechecks, route docs checks, and
  `git diff --check`.
- [ ] 5.5 Run `openspec validate add-retained-size-read-model --strict`.
