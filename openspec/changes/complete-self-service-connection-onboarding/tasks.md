## 1. Setup Engine Contract

- [x] 1.1 Add a shared setup-plan model covering connector identity, modality, support state, next-step kind, proof gate, deployment readiness, and non-secret documentation metadata.
- [x] 1.2 Implement the setup planner as the single source of truth over connector manifests, static-secret support, local collector support, browser-bound proof state, and deployment readiness.
- [x] 1.3 Add unit tests proving console, owner-agent, and CLI/SDK helper projections receive equivalent plans for local collector, static-secret, browser-bound, provider-authorization, and unsupported connectors.
- [x] 1.4 Add drift tests that fail if a surface introduces a setup modality or supported connector list outside the setup planner.

Progress note: implementation centralizes the setup-plan model and points console catalog, owner-agent intents, CLI setup, provider-authorization readiness, static-secret owner-session setup, and proof-gated browser/static-secret handling at that module. Live provider/browser proof flips remain gated on human-held evidence.

## 2. Console Setup Flow

- [x] 2.1 Replace the console add-connection catalog's hard-coded modality/disposition logic with setup-plan consumption.
- [x] 2.2 Render the add-connection page as a low-copy source picker plus one primary owner next step, with advanced route/runbook details behind disclosure.
- [x] 2.3 Show deployment-readiness blockers separately from per-connection owner actions.
- [x] 2.4 Preserve proof-gated and unsupported states as visible, honest outcomes without dead-end or false-supported copy.

## 3. Owner-Agent, CLI, and SDK-Style Setup Parity

- [x] 3.1 Switch `POST /v1/owner/connections/intents` to project setup plans from the shared planner.
- [x] 3.2 Add or update CLI setup helpers so a human or agent using CLI receives the same setup plan and next-step contract.
- [x] 3.3 Ensure owner-agent setup responses never include provider secrets, owner cookies, browser cookies, or grant-scoped MCP bearer material.
- [x] 3.4 Add black-box tests for owner-agent setup intent responses across supported, proof-gated, deployment-blocked, and unsupported connectors.

## 4. Static-Secret Normal Path

- [ ] 4.1 Complete the static-secret proof gate for Gmail and GitHub using the existing draft-capture-first-ingest runbook, without committing secrets.
- [ ] 4.2 After proof, flip static-secret setup plans from proof-gated/runbook to supported owner-mediated credential capture.
- [ ] 4.3 Prove two accounts for one static-secret connector create two active connection ids with separate credentials.
- [x] 4.4 Update docs so connector-specific source credential env vars are fallback/dev paths, not the normal setup path.
- [x] 4.5 Move static-secret setup form metadata into connector manifests, expose a setup descriptor with credential-key-provider readiness, and block before draft creation when no provider is configured.
- [x] 4.6 Generate the Docker credential encryption key from `scripts/generate-secrets.sh` and keep Railway on an auto-generated template secret.

Progress note: normal static-secret setup no longer requires per-account env vars or runbook archaeology. The console now creates a draft, captures the provider secret from the owner session, and starts first sync. The support-state flip remains proof-gated until live Gmail/GitHub credentials produce no-secret-leak evidence and accepted records.

## 5. Browser-Bound Setup Path

- [x] 5.1 Keep browser-bound setup proof-gated until live browser collector proof is recorded for the connector.
- [ ] 5.2 When proof lands, flip the relevant browser-bound setup plan in the same reviewable unit as the proof artifact.
- [x] 5.3 Add regression tests ensuring unproven browser-bound connectors cannot appear as supported in console, owner-agent, or CLI projections.

## 6. Provider Authorization Path

- [x] 6.1 Add setup-plan support for provider-authorization connectors that distinguishes deployment-level provider app readiness from per-account owner authorization.
- [x] 6.2 Return `needs_deployment_config` when provider app material is missing, with non-secret readiness guidance.
- [x] 6.3 Ensure provider callback/token exchange materializes active connections only after authorization and required account inventory or connection test succeeds.

Progress note: the reference now ships a deterministic provider-authorization
lifecycle boundary with owner-session initiation, callback state validation,
injectable token exchange, account inventory/connection test, credential-store
gating, multi-account connection materialization, and no token leakage in
responses or audit events. Real provider connectors remain gated until their
connector-specific exchanger/inventory adapters are implemented and proven.

## 7. Deployment and Documentation

- [x] 7.1 Update self-host and Railway docs to list only instance-level deployment variables as required normal setup.
- [x] 7.2 Document connector-specific source credential env vars as compatibility fallbacks and local development escape hatches.
- [x] 7.3 Add an operator-facing "add a connection" flow document that points to the console and CLI/owner-agent setup plan rather than connector-specific runbook archaeology.
- [x] 7.4 Document the credential key provider abstraction: Railway generated env-var provider, Docker generated env-var provider, and Docker/Kubernetes file-provider escape hatch.

## 8. Acceptance Checks

- [x] 8.1 Run `openspec validate complete-self-service-connection-onboarding --strict`.
- [x] 8.2 Run `openspec validate --all --strict`.
- [x] 8.3 Run setup planner unit tests and console catalog/render tests.
- [x] 8.4 Run owner-agent connection-intent tests.
- [x] 8.5 Run static-secret and browser-bound proof tests only when their live proof gates are intentionally being flipped.

Progress note: live proof gates were not flipped in this tranche. Static-secret deterministic route tests ran; browser-bound live proof remains gated and therefore its live proof test was intentionally not run.
