# Tasks: Add Source Webhook Ingress

Status: proposed
Owner: reference implementation owner
Created: 2026-05-28

## Acceptance Checks

- [x] `openspec validate add-source-webhook-ingress --strict` passes
- [x] `openspec validate --all --strict` passes with no regressions
- [x] `node --test reference-implementation/test/ref-source-webhook-ingest-operation.test.js` passes
- [x] `node --test reference-implementation/test/ref-source-webhook-route.test.js` passes
- [x] `node --test reference-implementation/test/source-webhook-event-store.test.js` passes
- [x] The spec delta accurately matches the implemented code (no invented requirements)
- [x] No runtime code changes (spec-only tranche)

## Tasks

- [x] Read and verify current implementation in `server/routes/source-webhooks.ts` and `operations/ref-source-webhook-ingest/index.ts`
- [x] Read and verify current tests in `test/ref-source-webhook-ingest-operation.test.js` and `test/ref-source-webhook-route.test.js`
- [x] Confirm existing spec language at `openspec/specs/reference-implementation-architecture/spec.md` lines 4349–4388
- [x] Confirm `add-source-webhook-ingress` OpenSpec change does not yet exist
- [x] Write `proposal.md`
- [x] Write `design.md` with full rationale, alternatives, invariants, residual risks
- [x] Write `tasks.md`
- [x] Write spec delta `specs/reference-implementation-architecture/spec.md` with precise envelope, header, signing, replay, error-code, and payload-action requirements
- [x] Run `openspec validate add-source-webhook-ingress --strict`
- [x] Run `openspec validate --all --strict`
- [x] Owner review of spec delta against code
- [ ] Archive after owner approves

## Deferred (not in this tranche)

- Source subscription lifecycle (subscribe/renew/expire/rotation)
- Per-source timestamp tolerance overrides
- Catch-up replay or event-stream endpoint for source webhooks
- Generic PDPP push delivery profile
