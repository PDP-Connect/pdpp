# Tasks

## 1. Reference detail contract

- [x] Add an owner-session-only `GET /_ref/approvals/:approval_id` route with a defensive safe projection for pending consent and owner-device approvals.
- [x] Add operation and route regressions for redaction and terminal/expired fail-closed behavior.

## 2. Console review flow

- [x] Replace queue-row approval with a review link and a request-specific denial control.
- [x] Add a review route and final confirmation state that renders the exact `/consent/review` artifact, immutable revision, request URI binding, and the owner-device distinction.
- [x] Submit single-consent final approval with only the exact reviewed `request_uri` and `approval_review_revision`; keep batch consent non-actionable in console.

## 3. Verification

- [x] Add rendered UI and source-contract regressions for exact artifact fields, revision/request binding, no approval-time review call, batch non-actionability, error confirmation clearing, and owner-device wording.
- [x] Run focused server and console tests, type checks, Biome, and strict OpenSpec validation.
