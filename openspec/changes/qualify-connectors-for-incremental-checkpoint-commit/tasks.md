## 1. Establish the qualification standard (this tranche)

- [x] 1.1 Frame the checkpoint contract as a qualification standard rather than
      a failed design, and state that fleet-wide adoption is not a goal.
- [x] 1.2 Adopt the covered-intervals representation, with debt derived from the
      gaps, and specify no storage or compaction layer so the terminal form is
      an additive migration.
- [x] 1.3 Define claim granularity and the closed-unit rule, so a connector with
      a coarse cursor is judged on whether it can prove a coarse unit complete.
- [x] 1.4 Record the disqualification criteria for unordered scans, including
      that coarsening does not rescue them and that an emitted-only watermark
      does not establish a prefix.

## 2. Measure the coarse-granularity question

- [x] 2.1 Re-test `heb` `orders` at day granularity by reading
      `packages/polyfill-connectors/connectors/heb/index.ts`. Verdict:
      **qualifies at day granularity, under a closed-day rule**.
- [x] 2.2 Identify the frontier hazard: `runForwardScan` tracks
      `newestOrderDate` as a running max (`:901-903`) while orders within a day
      sort by full timestamp, so the newest day observed may be partially
      enumerated. Answered by claiming a day only once a strictly older day has
      been observed.
- [x] 2.3 Identify the `dateDropped` hazard: an order whose date does not parse
      is recorded as considered-but-not-covered (`:849-852`) and has no day to
      be attributed to, so it is a hole of unknown position. Answered by
      withholding the whole run's claim when `dateDropped` is non-empty.
- [x] 2.4 Confirm truncation is expressible rather than blocking:
      `MAX_LIST_PAGES = 50` (`:64`) and `maxPage` exhaustion (`:919-921`) end a
      walk early, which under covered intervals is simply a smaller covered set.
- [x] 2.5 Confirm `CHECKPOINT_OVERLAP_DAYS = 60` (`:70`) is a freshness device
      via `resumeBoundary` (`:1064-1073`), not part of the safety argument.
- [x] 2.6 Re-confirm `slack` disqualification:
      `grep -c "ORDER BY" connectors/slack/index.ts` returns `0` on this branch.
- [x] 2.7 Check whether `fix/slack-emitted-watermark-0821` changes that.
      It does not: `grep -c "ORDER BY"` on that branch's
      `connectors/slack/index.ts` also returns `0`. The fix corrects
      emitted-vs-iterated watermark advance and removes the global-floor
      `COALESCE`, but adds no ordering.

## 3. Correct the redo-cost statement

- [x] 3.1 Verify by content that no mid-run commit path exists: `newState` is
      in-memory (`reference-implementation/runtime/index.ts:2762`, assigned at
      `:4237`) and `commitState` has exactly two call sites (`:5278`, `:5322`),
      both inside the DONE gate at `:5266`.
- [x] 3.2 Correct the wording in the research entry
      `ai/research/pdpp/the-checkpoint-protocol-must-carry-a-proven-boundary-...md`
      §5, from "work done since the last checkpoint is redone" to redo since the
      last *committed* cursor.
- [x] 3.3 Record the correction in this change's `design.md` so the corrected
      cost-benefit is visible to a reviewer who does not read the corpus.
- [x] 3.4 Confirm the wording does not appear in any other OpenSpec artifact,
      branch design note, or research entry.

## 4. Record the ideal-compatibility rule

- [x] 4.1 State the rule in `design.md` with its placement justification.
- [x] 4.2 Restate it as a requirement in the `polyfill-runtime` spec delta so it
      survives archival into `openspec/specs/`.
- [x] 4.3 Decide against `openspec/README.md`: that file is scoped to OpenSpec
      process, not to program-specific engineering constraints.

## 5. Validation

- [x] 5.1 `openspec validate qualify-connectors-for-incremental-checkpoint-commit --strict`
      passes.
- [x] 5.2 `openspec validate --all --strict` shows the same 11 pre-existing
      failures as the baseline captured before this change, with this change
      passing.

## 6. Deferred to later tranches

- [ ] 6.1 Add the optional `checkpoint_claim` field to
      `packages/polyfill-connectors/src/connector-runtime-protocol.ts`.
- [ ] 6.2 Implement the runtime decision procedure at the `STATE` handler.
- [ ] 6.3 Claim in `gmail` `messages` first.
- [ ] 6.4 Owner-authorized live confirmation of the `heb` day-granularity
      verdict. Deferred here because a `heb` run costs the owner a real OTP, and
      both rules fail closed so the cost of a misreading is a withheld commit.
