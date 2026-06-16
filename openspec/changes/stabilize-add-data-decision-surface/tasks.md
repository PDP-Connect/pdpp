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
- [ ] Capture live desktop/mobile Add data screenshots and action inventory after implementation.

## 5. Deploy Gate

- [ ] If local and live proof pass, declare a live-stack window and deploy through `scripts/reference-stack.sh up --build-app`.
- [ ] Close the live-stack window with Add data smoke evidence.
