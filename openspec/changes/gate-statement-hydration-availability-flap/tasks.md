# Tasks

Assumes the **structured-fingerprint** construction (design.md option (a)). If the
owner prefers the hash-cursor + sibling prior-body map (option (b)), tasks 1–2 change
shape but the spec delta and tests (3–4) are identical.

## 1. Shared cursor / statements STATE carry-forward

- [ ] 1.1 In `packages/polyfill-connectors/src/fingerprint-cursor.ts`, confirm
  `openCarryForwardCursor<T>` and the `prior(id)` surface are sufficient as-is for a
  `StatementFingerprint` carrier (they are — Codex already consumes the generic
  cursor with a structured `T`). No new primitive; add only a doc note that the
  statements connectors are a second derived-field-preservation consumer.

## 2. Connector emit changes (carry-forward of prior hydrated pointers)

- [ ] 2.1 chase `statements` (`connectors/chase/index.ts`): define a
  `StatementFingerprint` carrying the change-detection hash (or identity fields) plus
  `{document_url, pdf_path, pdf_sha256}`. Extend `readPriorStatementFingerprints` to
  decode the structured prior map tolerantly (legacy hash-only and missing maps
  decode to empty → first post-deploy run re-emits once). In `processStatementRow`,
  on `!dlResult.ok`, look up the prior hydrated pointers for `id`; if present, emit a
  carry-forward body with those pointers instead of calling the all-null
  `emitStatementIndexOnly`; if absent, keep the existing all-null index-only emit.
  Still emit the `pdf_download_failed` `SKIP_RESULT`. `note()` every observed `id`
  with the current (or carried-forward) fingerprint; keep the full-scan `pruneStale`.
- [ ] 2.2 usaa `statements` (`connectors/usaa/index.ts`): same shape in
  `emitStatementRecords` — when `hydrationSuccess(...)` is false, look up the prior
  hydrated pointers for `row.id`; carry them forward if present, else all-null. Extend
  usaa's `readPriorStatementFingerprints` to the structured map. Keep the full-scan
  `pruneStale` and the single trailing STATE write.
- [ ] 2.3 Both: persist the structured `fingerprints` map into the `statements` STATE
  cursor (replacing the hash-only map). No change to the public STATE wire — the map
  is inside the connector's opaque cursor.

## 3. Update the pinned all-null fallback tests to the carry-forward contract

- [ ] 3.1 chase `connectors/chase/integration.test.ts` "Invariant 4: index-only
  fallback when PDF download fails" (~340): split into (i) never-hydrated → all-null
  (unchanged assertion) and (ii) previously-hydrated → carried-forward
  `pdf_path`/`pdf_sha256`/`document_url` equal the prior values.
- [ ] 3.2 usaa `connectors/usaa/integration.test.ts` "failed hydration emits
  index-only record (all pdf fields null)" (~204): same split — all-null only when no
  prior hydration; carried-forward pointers when a prior cursor hydrated the same `id`.

## 4. New fingerprint/version tests (AC-1..AC-6)

- [ ] 4.1 `connectors/chase/statements-fingerprint.test.ts` and
  `connectors/usaa/statements-fingerprint.test.ts`: add cases proving
  AC-1 (hydrate→fail emits no new version + SKIP_RESULT),
  AC-2 (index-only→hydrate emits exactly one version),
  AC-3 (identity/title change re-versions),
  AC-4 (hydrate→fail→re-hydrate identical = one version total),
  and the STATE round-trip of the structured map (incl. legacy hash-only tolerance).
- [ ] 4.2 Confirm AC-6: re-run `compact-record-history-fingerprint-parity.test.js`
  for `chase/statements` and `usaa/statements` — parity holds with NO policy change,
  and the `null -> value` first hydration is still a retained boundary under `--apply`.

## 5. Validation

- [ ] 5.1 `node --test --import tsx connectors/chase/{statements-fingerprint,integration}.test.ts`
- [ ] 5.2 `node --test --import tsx connectors/usaa/{statements-fingerprint,integration}.test.ts`
- [ ] 5.3 `node --test test/compact-record-history*.test.js` (policy parity unchanged)
- [ ] 5.4 `openspec validate gate-statement-hydration-availability-flap --strict`
- [ ] 5.5 `openspec validate --all --strict`

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
