# Chase index.ts lost-edit memory - 2026-05-15

This is a memory-only reconstruction. I do not have a recoverable diff for the
lost pre-session local edits to `packages/polyfill-connectors/connectors/chase/index.ts`.
Treat this as evidence for what to re-derive, not as an instruction to blindly
recreate code.

## Data-loss incident summary

- Confirmed data loss: Worker B's `git checkout HEAD --` on
  `packages/polyfill-connectors/connectors/chase/index.ts`, after ENOSPC, wiped
  pre-session local edits.
- Current file state, per report: HEAD plus Worker B's mechanical migration
  only.
- No recovery surface was found in git fsck, reflog, stash, transcripts, or
  editor backups.
- Worker B's technical work itself sounds valid and should not be discarded by
  default:
  - New `playwright-download.ts` helper.
  - Chase and USAA migrated to that helper.
  - Three new tests.
  - 1007/1007 passing.
  - Fixture capture added at the save-failed branch.
- Process memory recorded elsewhere:
  `feedback_worker_uncommitted_edits.md`.
- Future workers must never blind-restore over a modified file. Before any
  checkout/reset/restore, they must inspect `git status`, preserve diffs, and
  ask the owner if the file is modified.
- Worker E was still running on SLVP connector health UX research at the time
  of the report.

## What I remember was in flight on chase/index.ts

High confidence:

- The lost work was primarily about Chase current activity, not OTP.
- The direction was to collect fresh Chase activity that appears in the web UI
  even when the download/export path says no activity matched the selected date
  range.
- This came from the owner's observation that Chase showed pending and posted recent
  card activity in the UI while a different Chase download/activity surface
  returned no matched activity.
- The intended behavior was not to pretend the QFX/download surface was
  complete if it omitted pending/fresh activity.
- The connector needed to treat current activity as separate from historical
  QFX transactions and statement PDFs.
- The parser work for MDS activity rows was already committed in
  `connectors/chase/parsers.ts`; the fragile part was wiring
  `connectors/chase/index.ts` to the right live Chase surface and attribution
  behavior.

Medium-high confidence:

- I was working around the mismatch between two Chase surfaces:
  - Dashboard or account overview, which visibly showed recent/pending rows.
  - Account activity/download path, which sometimes said there was no matching
    activity.
- The desired next patch in `index.ts` was likely to stop relying solely on the
  account activity/download path for `current_activity`.
- The likely implementation shape was:
  - Navigate or warm to `https://secure.chase.com/web/auth/dashboard#/dashboard/overview`.
  - Capture the DOM around the visible current/recent activity table.
  - Parse MDS rows through `parseCurrentActivityDom(html, referenceDateIso)`.
  - Emit `current_activity` records when attribution is safe.
  - Emit a known gap instead of false success when attribution is ambiguous or
    no rows are parseable.
- For one-account cases, dashboard overview rows could be attributed to the
  single known account.
- For multiple-account overview cases, the safer behavior was to emit a known
  gap such as ambiguous multi-account overview unless a per-account surface or
  account-specific marker made attribution reliable.
- There was a live-run mismatch after earlier parser work: the code still
  reported "opening Chase account activity" and produced a selector-pending gap
  saying no parseable current activity rows were found in "Chase account
  activity DOM." That suggested the `index.ts` routing/wiring was not yet
  correctly using the overview MDS path the owner had observed.

Medium confidence:

- The lost local edits may have touched the branch that handles
  `wantsCurrentActivity` after QFX/balance/transaction collection.
- The edits likely affected helper naming or message text around:
  - `current_activity`
  - `ambiguous_multi_account_overview`
  - current-activity DOM capture labels
  - "no parseable current activity rows found" gap wording
- There may have been an attempt to make current activity opportunistic:
  collect it when requested and safe, but do not block statements/QFX on it.
- There may have been capture additions near current activity, but Worker B's
  reported save-failed capture work is separate and should be preserved.

Low confidence:

- I do not remember exact selectors beyond the committed parser's MDS row shape
  using `tr` rows with `data-values`.
- I do not remember exact URL fragments beyond the dashboard overview route.
- I do not remember whether the lost local edit had already fully replaced the
  account-activity path or only added a fallback/guard.
- I do not remember exact variable names or line numbers.

## What I do not remember

- I do not remember a line-for-line patch.
- I do not remember any uncommitted OTP selector work in `index.ts`; OTP fixes
  were in `src/auto-login/chase.ts` and committed.
- I do not remember a completed fix for QFX/PDF download ENOENT in
  `index.ts`; Worker B's download-helper migration likely supersedes anything
  I had in mind there.
- I do not remember any intentional change that should undo Worker B's new
  shared download helper.

## Recommended recovery approach

Do not try to replay this from memory as a blind patch.

Recommended next steps:

1. Keep Worker B's `playwright-download.ts` helper and migrations unless review
   finds a concrete defect.
2. Inspect the current `chase/index.ts` current-activity branch.
3. Inspect the latest Chase run gaps from `run_1778852923848`.
4. Inspect any saved Chase fixtures from runs around `run_1778814413392`,
   `run_1778812481478`, and `run_1778852923848`.
5. Re-derive the current-activity routing from live evidence:
   - Which page shows the fresh pending/posted rows?
   - Does that page include account attribution?
   - Does it work for one account and multiple accounts?
6. Implement the smallest durable patch:
   - Use overview MDS rows when attribution is safe.
   - Preserve a precise known gap when not safe.
   - Keep QFX/history and statements independent.
   - Capture fixtures at the no-rows and ambiguous-attribution branches.
7. Add or update fixture parser tests for the exact MDS shape.
8. Run the Chase parser/integration tests and polyfill typecheck.
9. Only ask the owner for another Chase OTP after expected post-OTP gaps have been
   fixed or narrowed.

## Owner call

My best memory is that the lost `chase/index.ts` work was a partially completed
current-activity routing/attribution fix: move from the failing account
activity/download surface toward the dashboard overview MDS current-activity
surface, emit records only when attribution is safe, and emit an honest known
gap otherwise.

I do not remember enough exact code to justify reconstructing it mechanically.
Use this as a map for reimplementation and review, not as a source patch.
