# Tasks

Status: **implemented** (shipped on `main` as `8a5b8208` "fix(statements): carry
forward prior hydrated PDF pointers on transient failure"; the proposal landed
immediately after as `077e5625`). Verified green on `2026-06-04`; see Validation
below. Archiving is owner-gated (AGENTS.md).

The owner-chosen construction is design.md **option (b)** — a hash change-detection
cursor plus a sibling prior-body `hydration` map persisted in the same `statements`
STATE cursor — realized through the shared `openCarryForwardCursor<T>` lifecycle in a
small dedicated module (`packages/polyfill-connectors/src/statement-hydration-carry-forward.ts`).
The spec delta is satisfied by either option (a) or (b); the normative requirements
and acceptance cases are unchanged.

## 1. Shared cursor / statements STATE carry-forward

- [x] 1.1 `packages/polyfill-connectors/src/fingerprint-cursor.ts` exposes
  `openCarryForwardCursor<T>` and the `prior(id)` surface; they were sufficient as-is
  for the carry-forward consumer (no new primitive). The statement carry-forward is a
  second derived-field-preservation consumer alongside Codex; the module-level doc in
  `statement-hydration-carry-forward.ts` records that lineage and the
  `fingerprint-cursor.ts` doc comments describe the derived-field-preservation surface
  the new consumer reads.

## 2. Connector emit changes (carry-forward of prior hydrated pointers)

- [x] 2.1 chase `statements` (`connectors/chase/index.ts`): on `!dlResult.ok` in
  `processStatementRow`, the connector emits a `pdf_download_failed` `SKIP_RESULT` and
  then calls `emitStatementIndexOnly`, which now takes a `StatementHydrationCursor` and
  uses `resolveOnFailure(id)` to carry the prior `{document_url, pdf_path, pdf_sha256}`
  forward when the statement was previously hydrated, or all-null when never hydrated.
  The success path `note()`s the freshly hydrated pointers. The per-statement
  fingerprint cursor (excludes `fetched_at`) suppresses the byte-identical carried-forward
  re-emit. The full-scan `pruneStale` is preserved (run in lockstep for both cursors).
- [x] 2.2 usaa `statements` (`connectors/usaa/index.ts`): same shape in
  `emitStatementRecords` — when `hydrationSuccess(...)` is false, the resolved pointers
  come from `resolveOnFailure(row.id)`; carried forward if previously hydrated, else
  all-null. The single trailing STATE write and full-scan `pruneStale` are preserved.
- [x] 2.3 Both: the prior-body map is decoded by `readPriorStatementHydration` and
  persisted under the `hydration` key of the `statements` STATE cursor (option (b):
  the existing change-detection hash cursor is left untouched, the `hydration` map is a
  sibling key in the same opaque cursor). No change to the public RECORD or STATE wire.

## 3. Pinned all-null fallback tests reflect the carry-forward contract

- [x] 3.1 chase: the integration test "Invariant 4" (`connectors/chase/integration.test.ts`
  ~340) is the **never-hydrated** branch — it calls `emitStatementIndexOnly` with no
  hydration cursor, so the all-null assertion is still correct and intentional. The
  **previously-hydrated → carried-forward** branch is pinned by AC-1 in
  `connectors/chase/statements-fingerprint.test.ts` (carries prior pointers forward, no
  new version). Splitting the contract across the two files rather than fattening
  Invariant 4 keeps the harness-light integration test and the cursor-aware fingerprint
  test each focused; both branches are covered.
- [x] 3.2 usaa: same split — the integration test "Invariant 4"
  (`connectors/usaa/integration.test.ts` ~204, "No entry in the hydration map at all")
  is the never-hydrated all-null branch; AC-1 in
  `connectors/usaa/statements-fingerprint.test.ts` pins the previously-hydrated
  carry-forward branch.

## 4. New fingerprint/version tests (AC-1..AC-6)

- [x] 4.1 `connectors/chase/statements-fingerprint.test.ts` (40 tests) and
  `connectors/usaa/statements-fingerprint.test.ts` (30 tests) pin
  AC-1 (hydrate→fail carries pointers forward, no new version + SKIP_RESULT),
  AC-2 (never-hydrated failure stays all-null) and AC-2b/AC-2 (first hydration
  `null->value` versions exactly once), AC-3 (identity/title change re-versions — usaa),
  AC-4 (hydrate→fail→re-hydrate identical = one version total), AC-6 (a delisted /
  removed statement is pruned, never carried as a phantom), plus the STATE round-trip and
  legacy/malformed hash-only tolerance of `readPriorStatementHydration`. The dedicated
  module test `src/statement-hydration-carry-forward.test.ts` (6 tests) pins
  `resolveOnFailure`, `isHydrated`, prune, and decode tolerance directly.
- [x] 4.2 AC-6 (compaction safety): `connectors/{chase,usaa}/statements-fingerprint.test.ts`
  include a "connector fingerprint (excludes fetched_at) == compaction fingerprint over
  stored body" parity case, and `reference-implementation/test/compact-record-history*.test.js`
  is unchanged and green — parity holds with NO policy change, and the `null -> value`
  first hydration remains a retained boundary under `--apply`.

## 5. Validation

- [x] 5.1 `node --test --import tsx connectors/chase/{statements-fingerprint,integration}.test.ts` — 40/40 pass.
- [x] 5.2 `node --test --import tsx connectors/usaa/{statements-fingerprint,integration}.test.ts` — 30/30 pass.
- [x] 5.3 `node --test test/compact-record-history*.test.js` — 71 pass / 1 skip (Postgres DB test, `PDPP_TEST_POSTGRES_URL` unset; baseline).
- [x] 5.4 `openspec validate gate-statement-hydration-availability-flap --strict` — valid.
- [x] 5.5 `openspec validate --all --strict` — valid.

## Acceptance checks

- AC-1 no regression flap — task 4.1 (chase + usaa).
- AC-2 first hydration still versions — task 4.1.
- AC-3 genuine identity change still versions — task 4.1.
- AC-4 flap-back idempotent — task 4.1.
- AC-5 both connectors share the observable contract — tasks 2.1–2.2, 3.1–3.2.
- AC-6 compaction safety, no policy change — task 4.2.
- Reproduce: run tasks 5.1–5.5 from `packages/polyfill-connectors`
  (5.3 from `reference-implementation`); all green; both `openspec validate` calls
  pass `--strict`.
