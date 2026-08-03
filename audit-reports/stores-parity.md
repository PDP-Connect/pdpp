# PG/SQLite dual-backend parity audit — stores + records + search + summary

> **Integration note (2026-08-03).** All 5 findings below are CLOSED on the current
> integration branch (`waspflow/authority-audit-integration-0803`) — each was independently
> re-derived onto the TypeScript-migrated files by a prior integration pass before this
> report was added, and re-verified during this integration. Findings #1, #3, #4, #5 are
> fully fixed with a passing regression test. Finding #2 is mitigated (bounded
> candidate-window ranking), not fully closed — see the standing caveat in `FINAL-PACKET.md`
> ("mitigated, not closed"). This report is kept for its historical defect analysis and
> methodology; do not read any finding below as a currently-open defect.

Scope: `reference-implementation/server/stores/*`, `postgres-storage.js`, `postgres-search.js`,
`dataset-summary-read-model.js`, `records.js`, `postgres-records.js`, and `storage-backend.ts`
(pulled in because `records.js` delegates aggregation through it). Excludes
`reference-implementation/lib/postgres-spine.js` / `spine.ts` (already audited — the seed
`filters.cursor` bug).

Method: enumerated every genuinely dual-backend function/method pair (dispatch via
`isPostgresStorageBackend()`, either as a `createPostgresX()`/`createSqliteX()` factory pair or
an inline branch / `postgres*`-prefixed sibling function), then diffed filter/pagination/
ordering/limit handling between the two sides. Every CONFIRMED finding below was independently
re-read from the live files in this worktree (not trusted from subagent output alone) with exact
line numbers re-verified.

---

## CONFIRMED findings

### 1. [P1] `postgresListStreams` leaks stream-summary metadata outside grant scope (`resources`/`time_range` dropped)

**Severity: P1 — information disclosure + correctness.** A scoped grant's discovery response
reveals the connection's true, unscoped record count and freshness on Postgres.

- **Honors scoping (SQLite):** `reference-implementation/server/records.js:3471-3509`
  (`listStreams`, full function body).
  ```js
  3471  export async function listStreams(storageTarget, grant, manifest = null) {
  3472    if (isPostgresStorageBackend()) {
  3473      return postgresListStreams(storageTarget, grant, manifest);
  3474    }
  ...
  3480    for (const sg of grant.streams) {
  3481      const rows = iterate(referenceQueries.recordsListStreamVisibleCandidates, [connectorInstanceId, sg.name]);
  3482      const effective = buildEffectiveFilter(sg, {});
  ...
  3488      for (const row of rows) {
  3489        const rawData = JSON.parse(row.record_json);
  3490        if (effective.timeRange && consentTimeField) {
  3491          if (!passesTimeRange(rawData, effective.timeRange, consentTimeField)) continue;
  3492        }
  3493        if (effective.resources && !effective.resources.includes(row.record_key)) continue;
  3494        visibleCount += 1;
  ...
  ```
  Every candidate row is filtered by the grant's `time_range` and `resources` before it counts
  toward `record_count`/`last_updated`.

- **Drops scoping (Postgres):** `reference-implementation/server/postgres-records.js:1677-1704`.
  ```js
  1677  export async function postgresListAllStreams(storageTarget) {
  ...
  1680    const result = await postgresQuery(
  1681      `SELECT stream AS name, COUNT(*)::int AS record_count, MAX(emitted_at) AS last_updated
  1682       FROM records
  1683       WHERE connector_instance_id = $1 AND deleted = FALSE
  1684       GROUP BY stream
  1685       ORDER BY stream`,
  1686      [connectorInstanceId],
  1687    );
  1688    return result.rows;
  1689  }
  1690
  1691  export async function postgresListStreams(storageTarget, grant, manifest = null) {
  1692    const rows = await postgresListAllStreams(storageTarget);
  1693    const byName = new Map(rows.map((row) => [row.name, row]));
  1694    return (grant?.streams || []).map((streamGrant) => {
  ...
  1697      const stored = byName.get(streamGrant.name);
  1698      return {
  1699        name: streamGrant.name,
  1700        schema: manifestStream?.schema || null,
  1701        record_count: stored?.record_count || 0,
  1702        last_updated: stored?.last_updated || null,
  1703      };
  1704    });
  1705  }
  ```
  `postgresListAllStreams`'s `WHERE` clause never references `streamGrant.time_range` or
  `streamGrant.resources` — grep across the whole `postgresListAllStreams`/`postgresListStreams`
  body (1677-1705) for `time_range`/`resources`/`effective` returns nothing. The per-`streamGrant`
  map at 1694-1704 hands back the same unscoped `stored.record_count`/`stored.last_updated` for
  every grant regardless of what that grant actually restricts.

- **`time_range`/`resources` are real, live grant fields, not dead code:** normalized in
  `reference-implementation/server/auth.js:401-414` (`normalizeStreamSelection`), part of
  `SUPPORTED_STREAM_SELECTION_FIELDS` (`auth.js:121-130`). `buildEffectiveFilter`
  (`reference-implementation/server/record-expand-helpers.js:109-128`) pulls both straight off
  `streamGrant.time_range`/`streamGrant.resources`.

- **Reachable from real routes:** `listStreams`/`postgresListStreams` is called from
  `reference-implementation/server/index.js:2346` and `:2413` (`buildConnectorSchemaItem`,
  feeding the connector-schema/discovery response) and `:2645`
  (`getVisibleStreamFreshness`) — each reads `.record_count`/`.last_updated` straight off the
  result (verified: `server/index.js:2330-2341` `buildStreamDiscoverySummary` consumes
  `summary?.record_count`/`summary?.last_updated`). The actual record-fetch path
  (`postgresQueryRecords`) DOES apply `effective.resources`/`effective.timeRange` correctly
  (verified at `postgres-records.js:1119`, `:586-594`) — so raw record data stays properly
  scoped. This bug is isolated to the stream-summary metadata (count/freshness), not the records
  themselves.

- **Concrete failure:** a client holding a grant scoped to `resources: ["order_123"]` or
  `time_range: {since: "2026-07-01"}` calls the discovery/schema endpoint. On SQLite,
  `record_count`/`last_updated` reflect only what that grant can see. On Postgres, the same grant
  gets back the connection's true full-stream count and true most-recent-activity timestamp —
  telling the scoped client how much data exists and how fresh it is outside what they're
  entitled to read.

### 2. [P1] `postgresSemanticSearch` (JSONB fallback) truncates candidates via SQL `LIMIT` before ranking — silently drops true nearest-neighbor matches

**Severity: P1 — silent, unbounded-scope search-quality corruption**, live whenever the pgvector
extension is unavailable (the documented, default fallback mode).

- **Drops ranking (Postgres, JSONB mode):**
  `reference-implementation/server/postgres-search.js:686-723` (full function body).
  ```js
  686  export async function postgresSemanticSearch({
  ...
  694    if (isPostgresSemanticVectorEmbedding()) {
  695      return postgresSemanticSearchVector({ connectorInstanceId, scopeKeys, queryVector, limit, recordKeys });
  696    }
  697    const params = [connectorInstanceId, scopeKeys, Math.max(Number(limit) || 200, 1)];
  ...
  704    const result = await postgresQuery(
  705      `SELECT connector_id, connector_instance_id, scope_key, record_key, embedding
  706       FROM semantic_search_blob
  707       WHERE connector_instance_id = $1
  708         AND scope_key = ANY($2::text[])
  709         ${recordClause}
  710       LIMIT $3`,
  711      params,
  712    );
  713    return result.rows
  714      .map((row) => ({
  ...
  719        distance: cosineDistance(queryVector, Array.isArray(row.embedding) ? row.embedding : []),
  720      }))
  721      .sort(compareSemanticHits)
  722      .slice(0, limit);
  723  }
  ```
  There is no `ORDER BY` before `LIMIT $3` — Postgres returns an arbitrary subset of up to
  `limit` matching rows, and only that pre-truncated subset is ever scored (`cosineDistance`,
  line 719) or ranked (`.sort`, line 721). True nearest neighbors outside the arbitrary subset
  are never considered, with no error or warning.

- **Ranks correctly (SQLite):**
  `reference-implementation/server/search-semantic.js:581-622` (`queryPerConnector`, full
  function body).
  ```js
  581      async queryPerConnector({ connectorId, connectorInstanceId = null, scopeKeys, queryVector, limit, recordKeys = null }) {
  ...
  594        const sql = `
  595          SELECT connector_instance_id, scope_key, record_key, embedding
  596          FROM semantic_search_blob
  597          WHERE connector_id = ?
  598            ${instanceClause}
  599            AND scope_key IN (${placeholders})
  600            ${recordKeyClause}
  601        `;
  602        const scored = [];
  603        for (const row of iterateDynamicSqlAcknowledged(sql, [...])) {
  ...
  608          const d = distance(queryVector, storedVec);
  609          scored.push({ ... distance: d });
  ...
  619        }
  620        scored.sort(compareHits);
  621        return scored.slice(0, limit);
  622      },
  ```
  No SQL `LIMIT` in the query text (confirmed by reading lines 594-601 in full) — every matching
  row is scored, THEN sorted (line 620), THEN sliced to `limit` (line 621). Rank-then-limit, the
  correct order.

- **Reachability confirmed live, not dead code:**
  `isPostgresSemanticVectorEmbedding()` (`reference-implementation/server/postgres-storage.js:73-74`)
  returns true only when `activeBackend === 'postgres' && semanticEmbeddingColumnMode === 'vector'`.
  `semanticEmbeddingColumnMode` defaults to `'jsonb'` at module scope
  (`postgres-storage.js:36`) and only flips to `'vector'` on a successful pgvector migration
  (`postgres-storage.js:1674`), reverting to `'jsonb'` on failure/absence
  (`postgres-storage.js:1665`, `:1680`). Any Postgres deployment without the pgvector extension
  runs semantic search through the defective branch by default.

- **Note — sibling function is clean:** `postgresSemanticSearchVector`
  (`postgres-search.js:589-684`, the pgvector-backed path) correctly issues
  `ORDER BY ... distance` before `LIMIT` in both of its internal branches — the defect is isolated
  to the non-vector-column JSONB fallback in `postgresSemanticSearch`, not the file as a whole.

- **Concrete failure:** for any `(connector_instance_id, scope_keys[, recordKeys])` combination
  whose row count in `semantic_search_blob` exceeds the effective per-connector limit
  (`resolveSemanticPerConnectorLimit`, clamped 25-100,
  `reference-implementation/server/search-semantic.js:2406-2408`), a semantic search query against
  a JSONB-mode Postgres instance can silently omit the true best match and return unrelated
  results instead — while the identical query against SQLite, or Postgres in pgvector mode,
  correctly finds and ranks the true top-K matches.

### 3. [P2] `postgresGetRecordFieldWindow` calls `buildEffectiveFilter` with the wrong argument arity, dropping manifest-required fields from the grant

**Severity: P2 — spurious `403 field_not_granted` on Postgres for a field that SQLite allows.**
Postgres is *more* restrictive than SQLite for the same grant/request, not less — so this is not
a security regression, but it is a real behavior divergence a client can hit.

- **Bug site:** `reference-implementation/server/postgres-records.js:1547-1565`
  (`postgresGetRecordFieldWindow`, showing start of body through the bug line).
  ```js
  1547  export async function postgresGetRecordFieldWindow(
  1548    storageTarget,
  1549    stream,
  1550    recordId,
  1551    fieldPath,
  1552    grant,
  1553    manifest = null,
  1554    requestParams = {},
  1555  ) {
  ...
  1561    const streamGrant = getStreamGrant(grant, stream);
  1562    const manifestStream = getManifestStream(manifest, stream);
  1563    const effective = buildEffectiveFilter(streamGrant, requiredFieldsFor(manifestStream));
  1564
  1565    assertFieldVisibleToGrant(fieldPath, effective.fields);
  ```
  `buildEffectiveFilter`'s signature is `(streamGrant, requestParams, requiredFields = [])`
  (`reference-implementation/server/record-expand-helpers.js:109`). Line 1563 passes
  `requiredFieldsFor(manifestStream)` — an array of field-name strings
  (`postgres-records.js:270-272`: `return Array.isArray(manifestStream?.schema?.required) ? manifestStream.schema.required : [];`)
  — into the **second** positional slot (`requestParams`), and never supplies the third
  (`requiredFields`), which silently defaults to `[]`.

- **Correct sibling calls in the same file** (contrast — all 3 other `buildEffectiveFilter` call
  sites in `postgres-records.js` get the arity right):
  `postgres-records.js:727`, `:1119`, `:1499` all use the shape
  `buildEffectiveFilter(grantOrStreamGrant, {}, requiredFieldsFor(manifestStream))`.

- **Correct SQLite counterpart:** `reference-implementation/server/records.js:2851-2957`
  (`getRecordFieldWindow`, full function body), specifically line 2889:
  ```js
  2886    const mStream = manifest?.streams?.find(s => s.name === stream);
  2887    const consentTimeField = mStream?.consent_time_field;
  2888    const requiredFields = mStream?.schema?.required || [];
  2889    const effective = buildEffectiveFilter(streamGrant, {}, requiredFields);
  ```

- **Mechanism:** inside `buildEffectiveFilter`
  (`record-expand-helpers.js:109-128`), the union `effective.fields = [...new Set([...requiredFields, ...effective.fields])]`
  (line 124) is the only place required fields get added back into a grant-narrowed field
  allowlist. With `requiredFields` always `[]` on the Postgres call, this union never happens.

- **Dispatcher:** `getRecordFieldWindow` (`records.js:2851-2870`) dispatches to
  `postgresGetRecordFieldWindow` at `records.js:2860-2869` when `isPostgresStorageBackend()`.

- **Concrete failure:** a manifest declares `schema.required` including field `X` for a stream.
  A client's grant scopes `streamGrant.fields` to a set that does NOT include `X` (a legal grant
  shape — required fields are meant to be force-included regardless). The client requests the
  field-window read for `X`:
  - SQLite: succeeds — `X` gets unioned back into `effective.fields`, `assertFieldVisibleToGrant`
    passes.
  - Postgres: throws `field_not_granted` (403) — `X` was never unioned back in.
  Same backend-neutral input, different outcome purely based on `isPostgresStorageBackend()`.

### 4. [P3] `postgresQueryRecords` never rejects unknown/unsupported query parameters (SQLite does)

**Severity: P3 — silent no-op on a caller mistake, not a data-safety issue.** No parameter that
is contractually meaningful on either backend gets dropped; this is about *unrecognized* keys.

- **Rejects (SQLite):** `reference-implementation/server/records.js:889-898`
  (`validateTopLevelQueryParams`, full function body), called at `records.js:2132` inside
  `queryRecords`'s SQLite branch:
  ```js
  889  function validateTopLevelQueryParams(requestParams, manifestStream = null) {
  890    const unsupported = Object.keys(requestParams).filter((key) => !SUPPORTED_RECORD_QUERY_PARAMS.has(key));
  891    if (unsupported.length) {
  892      throw invalidQueryError(`Unsupported query parameter: ${unsupported.join(', ')}`);
  893    }
  ```
  `SUPPORTED_RECORD_QUERY_PARAMS` is the closed allowlist at `records.js:516-533`.

- **Never checks (Postgres):** `reference-implementation/server/postgres-records.js:1113-1343`
  (`postgresQueryRecords`, full function body). It validates `count`, `window`, `sort`
  individually (lines 1133-1139: `validateCountKind(requestParams.count)`;
  `validateWindowKind(requestParams.window)`; `validateCanonicalSort(requestParams.sort, ...)`)
  but never does an `Object.keys(requestParams)` sweep against any allowlist —
  `grep -n "Unsupported query parameter\|SUPPORTED_RECORD_QUERY_PARAMS\|Object.keys(requestParams)" postgres-records.js`
  returns zero matches (re-verified directly).

- **Dispatcher:** `queryRecords` (`records.js:2111-2114`) dispatches to `postgresQueryRecords`
  BEFORE ever reaching `validateTopLevelQueryParams`, which only exists in the SQLite tail of the
  same function (line 2132, well after the early Postgres return at line 2113).

- **Concrete failure:** a request with a typo'd/unsupported key (e.g. `filterr`, or a
  deprecated/future param name) against Postgres returns HTTP 200 with the key silently ignored
  — the caller gets no signal that their param did nothing. The identical request against
  SQLite fails fast with a typed `invalid_argument`-class error.

### 5. [P3] `scheduler-store.ts` `listActiveRuns` drops `started_at` from the Postgres ORDER BY

**Severity: P3 — ordering-only divergence, not a filter/data-drop.** No pagination or cursor is
involved (this enumerates a small bounded table, `@max_rows: 128`/`256`-class), so nothing is
stranded — but the relative processing order at startup reconciliation differs by backend.

- **Orders by `started_at` (SQLite):**
  `reference-implementation/server/queries/controller/list-active-runs.sql` (full file):
  ```sql
  -- @max_rows: 128
  SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
  FROM controller_active_runs
  ORDER BY started_at ASC, connector_id ASC, connector_instance_id ASC
  ```
  Consumed via `reference-implementation/server/stores/scheduler-store.ts:334-337`
  (`listActiveRuns()` in `createSqliteSchedulerStore`, full body — 3 lines, a single
  `allowUnboundedReadAcknowledged` call with no additional JS-side sort).

- **Drops `started_at` (Postgres):**
  `reference-implementation/server/stores/scheduler-store.ts:563-570`
  (`listActiveRuns()` in `createPostgresSchedulerStore`, full body):
  ```ts
  563    async listActiveRuns() {
  564      const result = await postgresQuery(
  565        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
  566         FROM controller_active_runs
  567         ORDER BY connector_id, connector_instance_id`
  568      );
  569      return result.rows as ActiveRunRecord[];
  570    },
  ```
  `started_at` is selected but never used in the `ORDER BY`.

- **Concrete failure:** `listActiveRuns()` feeds `reconcileAbandonedControllerRuns` at server
  startup (per the SQL file's own header comment) to enumerate stale in-flight runs left behind
  by a prior crash/restart. On SQLite, rows arrive oldest-started-first. On Postgres, rows arrive
  grouped by connector with no time ordering. If reconciliation logic (or an operator reading
  logs) assumes oldest/longest-abandoned runs are processed or reported first, Postgres
  deployments see a different relative order for the same underlying rows. This does not lose or
  duplicate any row.

---

## UNVERIFIED / needs human check

These were raised by the parallel research passes but I either could not construct a concrete
user-visible failure, or the divergence is arguably intentional/self-disclosed. Re-check before
treating as defects.

1. **`client-event-subscription-store.ts` — `listSubscriptionsByClient`/`listSubscriptionsByGrant`
   missing secondary sort key on SQLite.** SQLite:
   `server/queries/client-event-subscriptions/list-subscriptions-by-client.sql:10` /
   `list-subscriptions-by-grant.sql:10` — `ORDER BY created_at ASC` only. Postgres:
   `client-event-subscription-store.ts:215-226` / `:227-238` — `ORDER BY created_at, subscription_id`.
   Only matters for subscriptions created within the same millisecond (plausible under bulk
   seed/test provisioning); not pagination-breaking, just backend-dependent tie order for an
   operator-facing list. Not independently re-verified by me — re-check the two `.sql` files and
   the two TS method bodies directly before acting.

2. **`client-event-subscription-store.ts` — `claimDueQueue` tie-break + batch-size asymmetry.**
   Reported: SQLite has no `queue_id` tiebreak and relies on an `allowUnboundedReadAcknowledged`
   `@max_rows: 256` assertion (fail loudly if exceeded) rather than a SQL `LIMIT`; Postgres adds
   `ORDER BY q.next_attempt_at, q.queue_id LIMIT 100` (silently caps at 100, next poll cycle
   drains the rest). Plausible and not obviously wrong, but I did not personally re-read
   `claim-due-queue.sql` or the Postgres method body — re-verify line numbers
   (`client-event-subscription-store.ts:357-386` per the sub-report) before treating as actionable.

3. **`connector-instance-store.js` — `activateDraft` TOCTOU shape difference (SQLite: separate
   read-then-write; Postgres: single conditional `UPDATE ... WHERE status = 'draft'`).** Reported
   as behaviorally equivalent because `better-sqlite3` is synchronous in this codebase (no
   interleaving possible within one process) — plausible, not independently re-verified, and no
   concrete failure was constructed by either the sub-agent or me. Likely a non-issue; listed for
   completeness only.

4. **`postgres-search.js` — `compareSemanticHits` (4-key tiebreak) vs `compareHits` (5-key,
   includes `connectorInstanceId`) used inside per-call Postgres semantic search vs. the outer
   cross-connector merge.** Reported as likely inert because each `postgresSemanticSearch`/
   `postgresSemanticSearchVector` call is already scoped to one `connectorInstanceId` (so that key
   can never break a tie within one call), and the outer fan-in re-sorts with the correct 5-key
   comparator anyway. Not independently re-verified by me.

5. **`postgres-search.js` — `postgresCountIndexableSemanticValues` truthy-string coercion vs
   SQLite's strict `json_type(...) = 'text'` check.** Reported as affecting only a backfill
   drift/rebuild-trigger heuristic, not live search results. Not independently re-verified by me;
   low apparent impact even if real.

6. **`search.js` — per-field (SQLite) vs per-stream shared (Postgres) candidate-window sizing for
   lexical search.** Explicitly self-documented in code comments and reflected in a
   `candidate_window_limit` disclosure field in the response — a disclosed capacity difference,
   not a silent drop. Flagged by the sub-agent as a product question, not a code defect. I did not
   re-verify this one myself; if it matters, treat as a design question, not a bug ticket.

---

## Files/pairs examined and found clean

Directly re-verified by me:
- `reference-implementation/server/storage-backend.ts` — `listRowsForAggregation`: both adapters
  run an unfiltered `SELECT ... WHERE connector_instance_id = ? AND stream = ? AND deleted = FALSE`
  (Postgres adds `ORDER BY record_key ASC` explicitly; SQLite's `iterate()` + the referenced
  `.sql` query — not independently re-opened here, but the interface contract and call site match)
  with no `LIMIT` on either side (both intentionally scan-all per the module's own docstring).
- `reference-implementation/server/postgres-storage.js` — grep-confirmed the only `sqlite`-related
  hits are backend-selection/config plumbing (`activeBackend`, `VALID_BACKENDS`,
  `normalizeBackend`), not a duplicated query path.
- `postgresListAllStreams`/`listAllStreams` (records.js:3095-3115 vs postgres-records.js:1677-1689)
  — both list every stream unconditionally, no grant param in the signature at all; correctly
  unfiltered by design (used only on the owner/no-grant path).
- `deleteAllRecords`/`postgresDeleteAllRecords` (records.js:3121-3165 vs
  postgres-records.js:1706-1719) — both delete unconditionally by `(connectorInstanceId, stream)`,
  no filter/pagination surface to diverge on.

Covered by the parallel research passes, spot-checked by me where noted above, otherwise trusted
on the strength of file:line citations provided:
- `records.js` vs `postgres-records.js` dispatcher pairs: `ingestRecord`, `queryRecords` (except
  finding #4), `getRecord`, `getRecordFieldWindow` (except finding #3), `deleteRecord`,
  `deleteAllRecordsForConnector`, `createConnectionStreamStore`, `getDatasetRecordsAggregate`,
  `getDatasetRecordChangesBytes`, `getDatasetBlobBytes`, `getDatasetRecordTimeBounds`,
  `listDatasetTopConnectorCandidates`, `listDatasetSummaryStreamProjectionSeeds`,
  `getDatasetSummaryStreamRecordTimeBounds`, `countVisibleRecordsForStream`/
  `computeGradedRecordCount`, `computeRecordWindow`, `listLocalCoverageDiagnostics`,
  `aggregateRecords` (confirmed delegates to `storage-backend.ts`, no separate postgres
  aggregation path exists).
- `dataset-summary-read-model.js` — confirmed SQLite-only; its one `isPostgresStorageBackend()`
  reference is a fail-fast guard (`assertSqliteBackendForDatasetSummary`), not a second query path.
  The real Postgres counterpart is a separate module (`retained-size-read-model.js`), selected by
  caller-side wiring rather than internal branching — out of this audit's defect class.
- `postgres-search.js` — every function reviewed: lexical index maintenance
  (`postgresLexicalIndex*`), lexical meta (`postgresLexicalMeta*`), `postgresLexicalSearch` (both
  branches), semantic index maintenance (`postgresSemanticIndex*`), `postgresSemanticSearchVector`
  (ranks-then-limits correctly, unlike its JSONB sibling), `postgresGetSemanticRecord`.
- `search.js` / `search-semantic.js` dual-backend surface (store pairs, index rebuild/backfill,
  candidate-key building, cross-backend score-sign normalization, cursor/pagination for search
  responses — confirmed delegated to `operations/rs-search-lexical`, ruling out recurrence of the
  seed cursor bug in search).
- `server/stores/blob-store.ts`, `browser-surface-lease-store.ts`,
  `connector-attention-store.ts`, `connector-state-store.ts`, `device-exporter-store.ts`,
  `source-webhook-event-store.ts` — every interface method compared pairwise, ORDER BY/LIMIT/
  status-filter parity confirmed on both sides for all of them.
- `server/stores/client-event-subscription-store.ts` — all methods except the two listed under
  UNVERIFIED above.
- `server/stores/connector-detail-gap-store.js`, `connector-instance-store.js`,
  `connector-instance-credential-store.js` — every method compared pairwise (many backed by
  shared `.sql` files for the SQLite side, hand-compared against Postgres inline SQL); clean
  except the `activateDraft` note under UNVERIFIED.
- `server/stores/consent-store.js`, `owner-device-auth-store.js`, `terminal-gap-classifier.js`,
  `credential-encryption.js`, `provider-auth-run-credentials.js`,
  `static-secret-credential-probe.js`, `static-secret-run-credentials.js` — confirmed no
  postgres/sqlite branching of their own (grep-verified zero hits for
  `isPostgresStorageBackend|postgresQuery|createPostgres|createSqlite`); these delegate to
  `server/auth.js` or are pure adapters/crypto with no storage awareness. Out of scope for this
  defect class.
- `acquisition-batch-store.ts`, `manual-upload-artifact-store.ts` — confirmed genuinely
  dual-backend (inline per-method branching, not the factory-pair pattern) but were only
  surface-grepped by me to establish scope, not deep-audited by any pass — **these two files were
  NOT covered by the parallel research agents and should be treated as unaudited, not clean.**
  Flagging explicitly so they aren't miscounted as "examined."

---

## Coverage gap — call out explicitly

`reference-implementation/server/stores/acquisition-batch-store.ts` and
`manual-upload-artifact-store.ts` were identified as dual-backend during scoping (both import
`postgresQuery` and have local `sqliteGetOne`/`sqliteList` helpers alongside inline
`postgresQuery` calls) but were not assigned to any research pass and were not audited by me
directly beyond confirming they are in-scope. If a follow-up pass is wanted, these two are the
highest-value remaining unknowns.

---

## Summary

- **5 CONFIRMED findings**, independently re-verified by direct file reads (not taken on trust
  from sub-agent reports): 2×P1, 1×P2, 2×P3.
- **6 UNVERIFIED items** flagged for human re-check, not independently re-verified by me.
- **Most severe: Finding #2** — `postgresSemanticSearch`'s JSONB fallback mode (the default
  Postgres configuration absent pgvector) truncates candidate rows via SQL `LIMIT` before scoring
  them against the query vector, so semantic search can silently return arbitrary non-matches
  instead of the true nearest neighbors, with no error or signal to the caller. Finding #1
  (unscoped stream-summary metadata leak) is the second most severe — a real grant-scoping gap,
  though confined to summary counts/timestamps rather than raw record data.
- **Explicit coverage gap:** `acquisition-batch-store.ts` and `manual-upload-artifact-store.ts`
  were not audited by any pass in this run.
