# FINAL PACKET — RI authority-surface audit + dashboard task

**Worktree:** `/home/tnunamak/.tmp/ri-authority-audit-0802`
**Branch:** `local/ri-authority-audit-0802` (from `597cc0126`)
**Not pushed. Not deployed. No live-state mutation of any kind.**

Shared checkout `/home/tnunamak/code/pdpp`: **zero edits**, dirty set byte-identical throughout, including the unrelated `DU` conflict on `reference-implementation/test/rendered-verdict.test.ts`.

Live DB `pdpp`: **read-only `SELECT`s only.** All tests ran against throwaway databases (`pdpp_curtest`, `pdpp_parity`, and per-lane databases). Per your directive, **no Longview token was revoked, expired, migrated, or otherwise mutated.**

---

## Integration order

| # | SHA | What | Status |
|---|-----|------|--------|
| 1 | `8bed121b2` | Static PG/SQLite parity oracle | **REVISE closed by #8** — land only as a local diagnostic |
| 2 | `2cf19f824` | **Postgres keyset cursor fix** (the `/grants` Next bug) | **LAND** — your gate's verdict |
| 3 | `b6c611826` | Audit reports | docs |
| 4 | `f783b3f16` | Last-used + never-used console surface | dashboard task |
| 5 | `1b1f7a8ce` | MCP resource-binding **spec packet** (not an implementation) | decision below |
| 6 | `3f2ca6bd7` | P2: `buildEffectiveFilter` arity in `postgresGetRecordFieldWindow` | fix + parity test |
| 7 | `0dbdff452` | P3: `listActiveRuns` ORDER BY matched to SQLite | fix + parity test |
| 8 | `c1b7270bd` | **Executable cross-backend parity test** — closes the oracle false-negative | **the parity authority** |

Two P1 lanes (`postgresListStreams` grant scoping, `postgresSemanticSearch` rank-before-limit) were still running at the time of writing; their SHAs append after #8.

---

## 1. The original bug, fixed and independently gated

`postgresListSpineCorrelations()` accepted `filters.cursor`, emitted a `next_cursor`, and never applied it. Clicking **Next** re-served page 1 forever on `/grants`, `/syncs`, and `/audit` for **every Postgres deployment**. The SQLite path was correct all along, which is exactly why 6,792 tests stayed green while the deployed backend could not paginate.

Three coupled defects, all reproduced against your live data (1,329 grant correlations; timestamp ties up to 5 rows):
1. Cursor never applied.
2. `ORDER BY … id ASC` contradicted the `id <` keyset comparison → tied-timestamp rows **silently skipped**.
3. `compareSummaryRows()` (page-1 fast path) sorted `id` ascending, disagreeing with the SQL tiebreak.

Proven fail-then-pass: 2 failures pre-fix → 4/4 green post-fix, same file. Your independent gate re-derived this on its own disposable Postgres and additionally survived SQL-injection payloads, malformed cursors, empty sets, and filtered pagination. **Verdict: LAND.**

## 2. The REVISE, closed by construction

Your checker did not speculate — it **built** a false-negative: `if (false && filters.since)` leaves the token `filters.since` in the source, so the static oracle reports "no gaps found" while Postgres genuinely leaks a pre-cutoff row.

I did not patch the regex. `test/spine-correlation-filter-parity-postgres.test.js` seeds **identical data into both backends**, runs the same filter matrix through each, and diffs observable row **sets**. Nothing is inferred from source text, so dead code, comments, and tokens-in-strings cannot hide.

Side by side on your exact mutation:
- static oracle → `no gaps found`, exit 0 (misses it, as proven)
- executable test → **fails**, naming leaked rows `old1`/`old2` and reporting *"Postgres returned MORE rows: filter likely accepted then dropped"*

It also caught a second case your gate did not test (`since + clientId`). The test asserts its own fixture discriminates, so a non-selective `since` cannot make the matrix vacuously green. `8bed121b2` now documents its real guarantee in-file and is explicitly **not** unattended CI authority.

## 3. Dashboard task — complete

**Pagination:** fixed by #2 above (this was the actual cause of the broken `?cursor=` URL).

**Last-used / never-used:** derived from `disclosure.served` spine events — **no migration**. On your live DB that is 109,455 events, **100% carrying `token_id`**, 97,112 carrying `client_id`, all indexed. There is no `tokens.last_used_at` column in either backend, so this was a **read-model gap, not a write gap**. One grouped read per page, both backends.

The null case is load-bearing: **29 clients hold live tokens and have never read anything.** Rendering null as a blank cell would sort the most-revocable credentials to the bottom and read as "no data" rather than "no reads". It renders **"never used"**, sorts **first**, and the count is called out above the list. Issuance order is the wrong default for a page whose job is revoking stale credentials.

Verified read-only against your live DB: 8 owner clients — 4 sort to the top as NEVER USED (`Codex RI owner`, `bambam`, 2 MCP smoke clients, all holding live tokens with zero reads), 4 show real timestamps.

> **Near-miss worth recording.** My first invariants test PASSED against a deliberately broken page, because the regex matched a code *comment* containing "never used". A guard that cannot fail certifies a regression as safe. Hardened to strip comments and attribute values, then verified to discriminate: 9/9 pass → 2 failures with the regression injected → 9/9 restored.

## 4. MCP resource binding — spec packet, deliberately not implemented

`resource` is parsed, **required**, and validated as an absolute URL with path `/mcp` at `as-oauth.ts:120-149` → `index.js:3030-3070` — then never used again. It is not passed to `initiateGrant`, never stored on the grant, and no audience column exists in either backend.

RFC 8707 + the current MCP spec (2026-07-28) give an unambiguous **what** (servers MUST validate token audience and reject mismatches), but neither they nor PDPP's own spec resolve the **how** across three real policy axes: which of the three `pdpp_token_kind` values get audiences (notably the PDPP-specific `mcp_package`, which has no RFC analog), refresh-token behavior (`exchangeOAuthRefreshToken` has zero `resource` handling today), and whether the single-tenant pathname check should generalize to canonical-URI matching.

Implementing under that ambiguity would mean inventing product policy while appearing to ship spec compliance — a partial check that looks like a security control without being one. **Delivered a spec packet instead.** No live exploit today (only one legal resource value exists), but this becomes load-bearing the moment a second resource server appears.

## 5. Longview — report only, untouched

`cli_longview` holds **9,144 live owner-scoped tokens** (~80% of all live tokens) yet its spine shows **3 `disclosure.served` events ever**. It mints a full-read owner credential per invocation, never revokes, each valid ~1 year (expiries 2027-04 … 2027-08). Every other client shows healthy reuse (342/495, 140/174, 77/80).

Corrected figures — I over-alarmed initially and checked: **11,338 tokens genuinely live** (not 11,348; only 10 expired-but-unreaped), of which **9,976 are `owner` kind across 8 clients**. Separately, **1,362 tokens carry no expiry at all**.

Options, your call: (1) fix issuance to reuse rather than mint; (2) shorten machine-client owner-token lifetime; (3) revoke-superseded sweep on issuance; (4) accept and surface in the dashboard.

---

## Verification summary
- Full RI suite: **638 files, 6,792 tests, 0 failures.**
- Console: view-models 134/5/12 green; tokens invariants 9/9.
- RI typecheck clean; console typecheck clean.

> **Methodology warning for your CI.** My first full-suite run reported **exit 0** having executed only **39 tests from 1 file** — a stale `PDPP_TEST_POSTGRES_URL` confined the per-file runner. Always assert the file/test counts; `run-tests.js` exits 0 either way. Run it with `env -u PDPP_TEST_POSTGRES_URL -u PDPP_DATABASE_URL -u PDPP_STORAGE_BACKEND`.

## Coverage gap (stated, not hidden)
`acquisition-batch-store.ts` and `manual-upload-artifact-store.ts` are genuinely dual-backend but were **not** deep-audited. Highest-value follow-up.

## UAT checklist
1. `/grants` → **Next** shows different ids than page 1.
2. Page to exhaustion: no repeats; total reconciles with `SELECT count(DISTINCT grant_id) FROM spine_events WHERE grant_id IS NOT NULL` (1,329).
3. Same on `/syncs` and `/audit` (shared code path).
4. Filtered list (`?status=…`) still paginates.
5. `/deployment/tokens`: never-used credentials sort first and read "never used", not blank.
