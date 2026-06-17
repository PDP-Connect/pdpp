# Tasks

## 1. Evidence And Spec

- [x] Capture current live `/dashboard/records/add` desktop/mobile evidence and action inventory.
- [x] Create this OpenSpec change with the Add data decision-surface contract.
- [x] Validate the OpenSpec change strictly before implementation.

## 2. Decision Surface

- [x] Replace repeated per-card "Why this" disclosures with compact row-level method/support/action presentation.
- [x] Move acquisition paths behind a details disclosure that is not shown in the main row rhythm, or defer them to the setup/import destination.
- [x] Move existing-source reuse out of the default card body so manual-upload rows stay comparable.
- [x] Summarize server-prerequisite sources outside the primary add-now list.
- [x] Keep unavailable sources collapsed/searchable and without primary setup actions.

## 3. Tests And Scanners

- [x] Update Add data source invariants to pin comparable rows and forbid repeated "Why this" copy.
- [x] Keep negative copy tests for fake actions and developer/operator jargon.
- [x] Add or update component/source tests for server-prerequisite summary and unavailable collapsed behavior.

## 4. Verification

- [x] Run relevant Add data/source setup tests.
- [x] Run `pnpm --dir apps/console run types:check`.
- [x] Run `node scripts/check-owner-journey-acceptance.mjs --no-report`.
- [x] Run `openspec validate stabilize-add-data-decision-surface --strict`.
- [x] Run `openspec validate --all --strict`.
- [x] Capture live desktop/mobile Add data screenshots and action inventory after implementation.
  - Live proof at `https://pdpp.vivid.fish/dashboard/records/add` on the deployed `c578128d` UI: desktop `1280x900` and mobile `390x900` headed-browser captures reported zero `Why this`, `Recommended next`, deployment/proof/setup-path jargon, `Coming soon`, or setup-pending labels; Strava/Pocket-style unavailable sources were collapsed under `Sources not available from this page (23)`; server prerequisites were collapsed under `Server settings needed before setup (1)`; primary add-now actions were real collector/account/instruction actions. Earlier persisted evidence: `tmp/workstreams/add-data-live-audit-v2.json`, `tmp/workstreams/add-data-live-desktop-v2.png`, `tmp/workstreams/add-data-live-mobile-v2.png`.

## 5. Deploy Gate

- [x] If local and live proof pass, declare a live-stack window and deploy through `scripts/reference-stack.sh up --build-app`.
  - Deployed in the recorded `2026-06-16` Add Data decision-surface live-stack window with the canonical stack script; later rebuild `v0.5.0-281-gc578128d` preserved the same accepted Add Data surface.
- [x] Close the live-stack window with Add data smoke evidence.
  - Mutex closeout in `tmp/workstreams/ri-owner-current-state.md` records Add Data smoke evidence: `whyThisCount=0`, `recommendedNextCount=0`, `existingSourcesInlineCount=0`, `serverSetupCardCount=0`, `serverSettingsSummaryCount=1`, and no suspicious setup jargon.
