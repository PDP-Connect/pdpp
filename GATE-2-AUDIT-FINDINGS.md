# GATE 2 — RI audit findings (from main-4:21)

**Worktree:** `/home/tnunamak/.tmp/ri-authority-audit-0802` · **Branch:** `local/ri-authority-audit-0802`
**Commits:** 2, NOT pushed. No deploy. **No live mutation of any kind** — every DB touch was a read-only `SELECT`; tests ran against throwaway databases.
**Shared checkout:** zero edits, dirty set byte-identical including the unrelated `DU` conflict.

## Suite status
**Full RI suite: 638 files, 6,792 tests, 0 failures, exit 0.**

> Correction worth recording: my first full-suite run reported "exit 0" but had actually executed only **39 tests from 1 file** — a stale `PDPP_TEST_POSTGRES_URL` in my shell confined the per-file runner. Exit status alone was misleading. The 638-file number above is from a clean re-run with the env unset. I would have shipped a false "all green" claim if I had trusted the exit code.

---

## Audit method

Seeded two lanes with the **validated** defect signature from the fixed cursor bug, plus a deterministic oracle (`scripts/audit-pg-sqlite-parity.mjs`, commit `8bed121b2`) that reproduces the known bug with 0 false positives.

Coverage: all 49 `server/routes/*.ts`, ~60 `operations/*/index.ts`, all `server/stores/*`, `postgres-storage.js`, `postgres-search.js`, `postgres-records.js`, `records.js`, `dataset-summary-read-model.js` (~37k lines).

**I independently re-verified all four highest-severity findings by direct file read** rather than trusting the subagent reports. All four checked out exactly as described.

---

## CONFIRMED FINDINGS

All share the defect class of the original bug: **a dual-backend path where Postgres silently drops what SQLite honours.** Every one is invisible to the existing suite because the SQLite path is correct.

### P1 — `postgresListStreams` drops grant scoping (metadata leak) ✅ *verified by me*
`server/postgres-records.js:1691-1704` vs `server/records.js:3471-3509`

SQLite iterates records applying `effective.timeRange` and `effective.resources` to compute a **scoped** `visibleCount`. Postgres returns `stored.record_count` — the raw unscoped total — and never calls `buildEffectiveFilter` at all.

**Failure:** a client holding a narrow grant (subset of resources, or a time range) calls stream discovery and learns the connection's **true total record count and freshness**, not its own scoped view. Raw record data stays correctly scoped (`postgresQueryRecords` filters properly), so this is a *metadata* leak, not a record leak — but it discloses the existence and volume of data outside the grant.

### P1 — `postgresSemanticSearch` limits before ranking (silent wrong results) ✅ *verified by me*
`server/postgres-search.js:686-723` vs `server/search-semantic.js:581-622`

The JSONB fallback — **the live default whenever pgvector is not enabled** — issues `SELECT … LIMIT $3` and only *then* computes `cosineDistance` and sorts. Ranking is applied to an arbitrary N rows, not to the corpus.

**Failure:** with more than `limit` (default 200) rows in scope, the true nearest neighbours are frequently never fetched. Semantic search returns plausible-looking but arbitrary non-matches. No error, no warning. SQLite scores → sorts → limits, correctly.

This is the most severe finding: it silently corrupts answer quality on the read path users trust most.

### P2 — `postgresGetRecordFieldWindow` wrong-arity call (spurious 403) ✅ *verified by me*
`server/postgres-records.js:1563`

`buildEffectiveFilter(streamGrant, requiredFieldsFor(manifestStream))` against signature `buildEffectiveFilter(streamGrant, requestParams, requiredFields = [])` (`record-expand-helpers.js:109`). The required-fields array lands in the **`requestParams`** slot; the real `requiredFields` silently defaults to `[]`.

**Failure:** `403 field_not_granted` on Postgres for fields SQLite correctly permits.

### P2 — MCP `resource` param validated then dropped ✅ *verified by me*
`server/routes/as-oauth.ts:120-149` → `server/index.js:3030-3070`

`resource` is parsed, required, and validated as an absolute URL with path `/mcp` — then **never used again**. It is not passed to `consentStore.initiateGrant` (only `client_id`/`authorization_details`), never stored on the grant, and the `tokens` table has no resource/audience column. No RFC 8707 resource-indicator binding exists anywhere in the token model.

**Assessment:** an unfinished stub, not a regression — shape validation was written, audience binding never was. Only one valid resource value exists in this deployment, so no practical exploit today. But the code *implies* a security check it does not perform, which is how real audience-confusion bugs get introduced later.

### P3 — `postgresQueryRecords` accepts unknown query params
`server/postgres-records.js` vs SQLite `validateTopLevelQueryParams` (`server/records.js:889-898`). A caller typo silently no-ops on Postgres instead of erroring.

### P3 — `scheduler-store.ts listActiveRuns` ORDER BY drift
Postgres side (lines 563-570) omits `started_at` from `ORDER BY`. Changes startup-reconciliation ordering between backends; no data loss.

---

## Clean
Zero findings across the 8 factory-pattern `.ts` stores, `connector-detail-gap-store.js`, `connector-instance-store.js`, `connector-instance-credential-store.js`, `dataset-summary-read-model.js` (confirmed SQLite-only, not genuinely dual-backend).

No other pagination/filter/sort parameter in the audited surface reproduced the cursor defect's shape — all cursor/limit/offset/status/since/until params trace to genuine application sites on both backends.

## Coverage gap (stated, not hidden)
`acquisition-batch-store.ts` and `manual-upload-artifact-store.ts` are genuinely dual-backend but were **not** deep-audited this run. Highest-value follow-up for full coverage.

---

## Longview — report only, per your directive
**Not actioned. Nothing revoked, migrated, expired, or mutated.**

`cli_longview` holds **9,144 live owner-scoped tokens** (~80% of all live tokens) yet its spine shows **3 `disclosure.served` events ever**. Event mix: `request.submitted` 9,189 · `consent.approved` 9,173 · `token.issued` 9,173 · `disclosure.served` 3. Each credential is full-read owner scope, valid ~1 year (expiries 2027-04 … 2027-08). Every other client shows healthy reuse (342/495, 140/174, 77/80).

Corrected figures (I initially over-alarmed at the naive count): **11,338 tokens are genuinely live**, not 11,348 — only 10 are expired-but-unreaped. Of the live set, **9,976 are `owner` kind across just 8 clients**. Separately, **1,362 tokens carry no expiry at all**, and **29 clients hold live tokens yet have never read anything**.

**Decision options (your call, no action taken):**
1. Fix the issuance path so Longview reuses a credential instead of minting per invocation.
2. Shorten owner-token lifetime from ~1y for machine clients.
3. Add a revoke-superseded sweep on issuance.
4. Accept as-is and surface it in the dashboard so it is at least visible.

---

## Dashboard task — remaining scope
"Last used" needs **no migration**: 109,455 `disclosure.served` rows, **100% carry `token_id`**, 97,112 carry `client_id`, all indexed on `spine_events`. The `tokens` table has no `last_used_at` in either backend, so this is a **read-model gap, not a write gap**. `/grants` already renders `MAX(occurred_at)` — that *is* last-used, merely unlabeled.

Design note carried forward: **29 never-used-but-live clients** mean a bare "last used" column would sort the highest-risk credentials to the bottom or show them blank. They must render as **"Never used"** and be filterable, or the cleanup UI hides exactly what matters.

Only 7,740 disclosure events carry a `grant_id` (most reads are owner-token reads with no grant), so grant-scoped and token-scoped last-used must key differently.
