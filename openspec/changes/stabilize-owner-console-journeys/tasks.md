# Tasks

## 1. Execution Spine

- [x] Create this OpenSpec change to make the owner-console plan canonical for the current recovery work.
- [x] Keep `design-notes/owner-console-slvp-execution-plan-2026-06-16.md` as supplemental context; do not let it supersede this change.
- [x] Maintain a journey ledger mapping each live owner complaint or audit finding to a concrete acceptance check.
- [x] Before each UI deploy, record the journey row closed, evidence path, tests, and live-stack mutex closeout.

## 2. Browser-Session Setup

- [x] Remove owner-facing browser-session copy that points to missing operator runbooks or internal browser-service names.
- [x] Add a source invariant preventing the normal browser-session owner page from rendering those operator artifacts.
- [x] Replace the Amazon/browser-session start Server Action transport with a normal POST route and redirect flow.
- [x] Add invariants/tests proving the page uses normal POST transport and that the route preserves owner-session auth, repair mode, setup mode, and draft cleanup.
- [x] Run a headed live Amazon Start Session proof under a declared verification window and capture URL, body summary, console errors, failed network requests, and screenshot.

## 3. Add-Source Honesty

- [x] Separate add-now, server-setup-required, and not-available-from-this-page groups.
- [x] Remove false primary actions for unsupported/browser-proof-gated sources.
- [x] Review the add-source surface with screenshot/pixel evidence and a jargon scanner for developer-only terms.
- [x] Confirm unavailable sources do not appear as setup-able cards in the primary owner path.

## 4. Sources Cockpit

- [ ] Produce current desktop/mobile screenshots of the Sources list and one selected source detail.
- [ ] Fix layout squish: source rows retain enough width for names and statuses at desktop sizes.
- [ ] Fix state geometry: degraded/attention rows do not change width, corner shape, or row rhythm relative to normal rows.
- [ ] Fix selected-state craft: highlight/accent does not touch row content.
- [ ] Replace empty stream rows with useful facts or honest "not available yet" copy.
- [ ] Run a headed confused-owner pass for "I know what data I have" after the fixes.

## 5. Attention And Recovery Consistency

- [x] Preserve one attention truth: dashboard hero, Runs, Sources, source detail, and recovery panels derive owner-action attention from rendered verdicts.
- [x] Confirm device-local actions route to a focused recovery panel, not a remote action loop or `/dashboard/traces`.
- [x] Confirm recovery panels render cause-specific steps and no stale generic dead-letter ritual.

## 6. Verification

- [x] Run relevant unit/source invariants for each tranche.
- [x] Run `pnpm --dir apps/console run types:check` for console changes.
- [x] Run `node scripts/check-owner-journey-acceptance.mjs --no-report`.
- [x] Run `openspec validate stabilize-owner-console-journeys --strict`.
- [x] Run `openspec validate --all --strict` before merge/deploy-ready handoff.
- [x] Use worker lanes only for bounded evidence/review or owner-authored implementation packets; reap lanes and record reports under `tmp/workstreams/`.

## 7. Owner Acceptance

- [x] Deploy only after the owner approves live-stack mutation or after the RI owner has delegated deploy authority for the tranche.
- [x] Close the live-stack window with smoke evidence.
- [ ] Ask the owner for a fresh walkthrough only after the tranche has real headed-browser proof and no known P0/P1 trust/task blockers in its journey row.
