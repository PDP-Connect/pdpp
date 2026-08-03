# GATE 1 — RI authority-surface audit (from main-4:21)

**Worktree:** `/home/tnunamak/.tmp/ri-authority-audit-0802`
**Branch:** `local/ri-authority-audit-0802` (from committed HEAD `597cc0126`)
**Commits:** 2, **NOT pushed.** No deploy, no live mutation.
**Shared checkout `/home/tnunamak/code/pdpp`:** zero edits; dirty set re-verified byte-identical including the unrelated `DU` conflict on `reference-implementation/test/rendered-verdict.test.ts`.
**Live DB:** read-only reads against `pdpp`; all tests ran against a throwaway `pdpp_curtest` database.

---

## 1. FIXED — `2cf19f824` — three coupled P1 defects in the Postgres spine correlation list

`postgresListSpineCorrelations()` (`reference-implementation/lib/postgres-spine.js`) had three defects that compound:

1. **`filters.cursor` accepted, `next_cursor` emitted, cursor never applied.** Every "next page" request silently re-served page 1. This broke pagination on `/grants`, `/syncs`, and `/audit` for *every* Postgres deployment. `hasOnlyFirstPageRecentFilters()` already treated a cursor as a reason to skip the fast path, proving the parameter was meant to work — the fallback query just never consumed it.
2. **`ORDER BY last_at DESC, id ASC` contradicted the `id <` keyset comparison.** A cursor read against an opposing sort direction *silently skips* correlations sharing an identical `MAX(occurred_at)`. Now `id DESC`, matching `buildCorrelationAggregateSql()` in `lib/spine.ts`.
3. **`compareSummaryRows()`**, which orders the page-1 fast path, sorted `id` ascending and so disagreed with the SQL tiebreak. Page 1 and page 2 must share one total order or rows drop at the boundary.

The SQLite path was correct all along, which is exactly why the whole suite stayed green while the deployed backend could not paginate at all.

### Reproduced against live data (read-only)
- 1,329 distinct grant correlations — far more than one 50-row page.
- Timestamp ties are real: up to **5 grants sharing one identical `last_at`**, so defect 2 is not hypothetical.
- Tim's reported cursor `2026-08-02T13:21:42.652Z::grt_046c43f04214cc02` returns three *different* grants when the cursor is correctly applied vs. what the server serves today.

### Verification — fail-then-pass, same test file
- **Pre-fix:** 2 failures — `page 2 repeated page 1 — filters.cursor is being ignored` and `tied-timestamp correlation ..._t1 was skipped by keyset pagination`.
- **Post-fix:** 4/4 green.
- The malformed-cursor test passes *both* ways, correctly showing that behavior was never broken.

Regression test (`test/spine-correlation-cursor-postgres.test.js`) asserts **union-completeness across a full page walk** — the property an operator actually needs when auditing grants — and seeds an explicit tie block so defect 2 cannot regress unnoticed. Gated on `PDPP_TEST_POSTGRES_URL`, clean skip without live PG.

### Suites green
`event-spine` 47/47 · `aggregation-rows-conformance-postgres` 7/7 · `disclosure-spine-conformance` 9/9 · `grant-package-postgres-path` 2/2. Full RI suite running at time of writing.

**Migration effects: none.** No schema change; query-layer only.

---

## 2. `8bed121b2` — deterministic PG/SQLite parity oracle

`scripts/audit-pg-sqlite-parity.mjs` detects the generalized defect class: *a dual-backend path where one backend silently ignores a parameter the other honours.*

Validated against the known-bad tree: reports **exactly the 3 real defects, 0 false positives**. Worth noting for trust — my first version emitted **15 false positives** because `functionBody()` balanced braces starting at the `filters = {}` default-parameter brace, returning an empty body so every key looked unread. Fixed by walking the parameter list first. An oracle I can't trust is worse than none, so this was corrected before any finding was reported.

Exits non-zero on any gap; suitable as a CI regression gate.

---

## 3. NEW FINDING — needs your call, **not actioned**

**`cli_longview` holds 9,144 live owner-scoped tokens (~80% of all live tokens) but has only ever used 3.**

Spine event mix for that client:

| event_type | count |
|---|---|
| request.submitted | 9,189 |
| consent.approved | 9,173 |
| token.issued | 9,173 |
| **disclosure.served** | **3** |

It mints a fresh **full-read owner credential per invocation**, never revokes, and each is valid ~1 year (expiries land 2027-04 … 2027-08). Every other client shows a healthy used-to-live ratio (342/495, 140/174, 77/80); Longview is 3/9,144 — a total outlier.

I initially over-alarmed at "11,348 live tokens" and corrected myself: nearly all have expiries and only 10 are expired-but-unreaped. The genuine figure is **11,338 actually-live**, of which **9,976 are `owner` kind across just 8 clients**.

Related, smaller:
- **29 clients hold live tokens and have never read anything.** These are arguably *higher* risk than stale ones — a pure "last used" column sorts them to the bottom or shows blank, hiding them. They must render as "Never used" and be filterable.
- **1,362 tokens have no expiry at all** (mostly ChatGPT/Codex/Claude `client` kind).

This looks like a **credential-sprawl defect in the Longview issuance path**, not a dashboard gap. It is outside the bounded dashboard task I was given, so I have not touched it. **Tell me if you want it in scope.**

---

## 4. "Last used" needs NO migration

Confirmed derivable from data already recorded:
- **109,455 `disclosure.served` events; 100% carry `token_id`**, 97,112 carry `client_id`.
- `spine_events` indexes `grant_id`, `client_id`, and `token_id`.
- The `tokens` table has no `last_used_at` column in **either** backend (`server/db.js:324`, `postgres-storage.js:568`).

So the Tokens/Packages UI gap is a **read-model gap, not a write gap**. `/grants` already shows `MAX(occurred_at)` — that *is* the last-used signal, merely unlabeled.

Only 7,740 disclosure events carry a `grant_id` (most reads are owner-token reads with no grant), so the grant-scoped and token-scoped last-used views must be derived on different keys.

---

## Still running
Two audit lanes sweeping `server/stores/*` and the route/operations layer for the same accepted-then-dropped defect class. Reports will land in `audit-reports/`.

## UAT checklist (for your live verification)
1. Load `/grants`, click **Next** — page 2 must show different grant ids than page 1.
2. Page to exhaustion — no id may appear twice, and the count must reconcile with `SELECT count(DISTINCT grant_id) FROM spine_events WHERE grant_id IS NOT NULL` (1,329).
3. Repeat on `/syncs` and `/audit` — same shared code path.
4. Confirm a filtered list (`?status=…`) still paginates correctly.
