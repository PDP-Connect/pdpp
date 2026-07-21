## 1. Recovery-only evidence preservation (connector-neutral)

- [x] Add `recovery_only` to `buildRunTerminalData`'s returned data payload,
      sourced from the existing `startRecoveryOnly` local in
      `reference-implementation/runtime/index.js`.
- [x] Change `buildCollectionFacts` (`connector-gap-bounding.ts`) to return
      `null` unconditionally when the run is `recovery_only` — no exception
      for streams with emitted records, recovered gaps, DETAIL_COVERAGE
      evidence, or staged/committed STATE, since none of those prove a
      genuine list-pass inventory measurement occurred.
- [x] Verify `connector-summary-read-model.ts`'s fold requires no
      recovery-only-specific code: a recovery-only event with no
      `collection_facts` has nothing to fold, so every stream's stored
      value AND provenance stay untouched by construction.
- [x] Verify `ref-control.ts`'s classifying-run selection
      (`resolveEffectiveStreamFacts`) requires no recovery-only-specific
      code for the same reason — `collectionFacts` is `null`, so every
      stream falls through to the stored fact with its own provenance.
- [x] (Reverted) An earlier draft added overlay/restamp logic to both folds
      that preserved values but restamped provenance to the recovery-only
      run; independent audit found this falsifies provenance and it was
      removed.
- [x] Add regression tests: `buildCollectionFacts` returns `null` for a
      recovery-only run under every touched-signal shape (emitted record,
      recovered gap, DETAIL_COVERAGE, staged/committed STATE); the
      connector-summary-read-model fold leaves stored value AND provenance
      untouched by a recovery-only event, while a later genuine full-scope
      run still replaces both normally.
- [x] Add a collection-report-level test proving current gap-drain progress
      (pending count -> 0) is visible via the live gap-store inputs while
      inventory evidence and provenance stay on the prior measuring run.
- [x] Add an Amazon-shaped acceptance test reproducing
      `run_1784155457650`'s exact shape (15 detail-gap recoveries, zero
      pending gaps remaining) and assert both orders/order_items keep their
      prior evidence AND provenance untouched.
- [x] Typecheck + full store/read-model/ref-control test suites green.

## 2. Gmail attachment recovery bounded work-unit paging (Gmail-specific)

- [x] Add a Gmail-local byte-budget page planner for historical attachment
      backfill, mirroring `detail-gap-paging.js`'s budget-clamp and
      trim-to-budget-with-at-least-one-entry pattern — no EWMA/cross-page
      learning (Gmail's per-UID cost is known up front from BODYSTRUCTURE,
      and the historical pass runs at most once per run) — without
      modifying `detail-gap-paging.js` or adding Gmail fields to it.
- [x] Compute each candidate UID's cost as 0 for zero attachments, else the
      sum of known `size_bytes` plus a fixed fallback
      (`ATTACHMENT_BACKFILL_UNKNOWN_SIZE_FALLBACK_BYTES`) per attachment
      whose size is unavailable — never charging the fallback to a
      no-attachment UID, never dropping unknown-size attachments from the
      sum.
- [x] Sort probe metadata ascending by UID before trimming, and derive the
      admitted page as a positional prefix (`slice(0, admittedCount)`), not
      by comparing UID values — immune to IMAP fetch-order not being
      ascending.
- [x] Re-derive the byte budget defaults against the live incident's
      observed ~5.7 KB/s worst-case throughput: default 1 MiB (~3 min
      worst-case), min 256 KiB, max 4 MiB (~12 min worst-case, under one
      ~15-minute run cadence window), `PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES`
      override.
- [x] Confirm (no code change expected, verify only) `backfilled_through_uid`
      still advances only after the full page's attachments are attempted to
      completion — same commit-site pattern already in place.
- [x] Keep `selectAttachmentBackfillFetchRange` tests unchanged (it is
      still the coarse UID-range ceiling; only the trim/planning layered on
      top of it changed).
- [x] Add tests: byte-cost-driven page sizing; zero-attachment UID costs
      nothing; mixed known/unknown attachment sizes charge the fallback per
      attachment; a single oversized candidate still forms a complete page
      (at-least-one-entry); an out-of-order candidate list still trims
      correctly by position.
- [x] Confirm no wall-clock kill path was introduced; cancellation continues
      through `abortSignal` only.
- [x] Typecheck + full Gmail connector test suite green.

## 3. Verification

- [ ] `openspec validate fix-recovery-run-lifecycle --strict` passes.
- [ ] Full relevant test suites (SQLite + isolated Postgres where gated)
      green.
- [ ] Typecheck and lint clean on all touched files.
- [ ] `pnpm workstreams:status`-equivalent diff-check clean (no unintended
      files touched).
- [ ] Write findings/evidence to
      `tmp/workstreams/recovery-run-lifecycle-maker-0715.md`.
