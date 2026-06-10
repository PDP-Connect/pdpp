## 1. Setup Engine Contract

- [x] 1.1 Add a shared setup-plan model covering connector identity, modality, support state, next-step kind, proof gate, deployment readiness, and non-secret documentation metadata.
- [ ] 1.2 Implement the setup planner as the single source of truth over connector manifests, static-secret support, local collector support, browser-bound proof state, and deployment readiness.
- [ ] 1.3 Add unit tests proving console, owner-agent, and CLI/SDK helper projections receive equivalent plans for local collector, static-secret, browser-bound, provider-authorization, and unsupported connectors.
- [ ] 1.4 Add drift tests that fail if a surface introduces a setup modality or supported connector list outside the setup planner.

Progress note: first implementation tranche centralizes the setup-plan model and current local/static-secret/browser-bound support truth, then points console catalog, owner-agent intents/templates, and static-secret routes at that module. Deployment readiness, CLI/SDK helper projections, provider-authorization setup, and proof-gate flips remain open.

## 2. Console Setup Flow

- [x] 2.1 Replace the console add-connection catalog's hard-coded modality/disposition logic with setup-plan consumption.
- [ ] 2.2 Render the add-connection page as a low-copy source picker plus one primary owner next step, with advanced route/runbook details behind disclosure.
- [ ] 2.3 Show deployment-readiness blockers separately from per-connection owner actions.
- [ ] 2.4 Preserve proof-gated and unsupported states as visible, honest outcomes without dead-end or false-supported copy.

## 3. Owner-Agent, CLI, and SDK-Style Setup Parity

- [x] 3.1 Switch `POST /v1/owner/connections/intents` to project setup plans from the shared planner.
- [ ] 3.2 Add or update CLI setup helpers so a human or agent using CLI receives the same setup plan and next-step contract.
- [ ] 3.3 Ensure owner-agent setup responses never include provider secrets, owner cookies, browser cookies, or grant-scoped MCP bearer material.
- [ ] 3.4 Add black-box tests for owner-agent setup intent responses across supported, proof-gated, deployment-blocked, and unsupported connectors.

## 4. Static-Secret Normal Path

- [ ] 4.1 Complete the static-secret proof gate for Gmail and GitHub using the existing draft-capture-first-ingest runbook, without committing secrets.
- [ ] 4.2 After proof, flip static-secret setup plans from proof-gated/runbook to supported owner-mediated credential capture.
- [ ] 4.3 Prove two accounts for one static-secret connector create two active connection ids with separate credentials.
- [ ] 4.4 Update docs so connector-specific source credential env vars are fallback/dev paths, not the normal setup path.

## 5. Browser-Bound Setup Path

- [ ] 5.1 Keep browser-bound setup proof-gated until live browser collector proof is recorded for the connector.
- [ ] 5.2 When proof lands, flip the relevant browser-bound setup plan in the same reviewable unit as the proof artifact.
- [ ] 5.3 Add regression tests ensuring unproven browser-bound connectors cannot appear as supported in console, owner-agent, or CLI projections.

## 6. Provider Authorization Path

- [ ] 6.1 Add setup-plan support for provider-authorization connectors that distinguishes deployment-level provider app readiness from per-account owner authorization.
- [ ] 6.2 Return `needs_deployment_config` when provider app material is missing, with non-secret readiness guidance.
- [ ] 6.3 Ensure provider callback/token exchange materializes active connections only after authorization and required account inventory or connection test succeeds.

## 7. Deployment and Documentation

- [ ] 7.1 Update self-host and Railway docs to list only instance-level deployment variables as required normal setup.
- [ ] 7.2 Document connector-specific source credential env vars as compatibility fallbacks and local development escape hatches.
- [ ] 7.3 Add an operator-facing "add a connection" flow document that points to the console and CLI/owner-agent setup plan rather than connector-specific runbook archaeology.

## 8. Acceptance Checks

- [ ] 8.1 Run `openspec validate complete-self-service-connection-onboarding --strict`.
- [ ] 8.2 Run `openspec validate --all --strict`.
- [ ] 8.3 Run setup planner unit tests and console catalog/render tests.
- [ ] 8.4 Run owner-agent connection-intent tests.
- [ ] 8.5 Run static-secret and browser-bound proof tests only when their live proof gates are intentionally being flipped.
