## 1. Policy Projection

- [ ] 1.1 Add a shared policy projection helper for trigger kind, automation mode, deployment readiness, and notification posture.
- [ ] 1.2 Route schedule, retry, webhook, and manual run requests through the projection helper before starting connector execution.
- [ ] 1.3 Preserve existing unsafe-schedule and not-ready gates as policy decisions instead of separate ad hoc checks.

## 2. Dashboard And API Semantics

- [ ] 2.1 Expose trigger kind and automation mode in reference run/schedule projections.
- [ ] 2.2 Show owner-facing copy for unattended, assisted, ask-before-run, and manual-only connectors.
- [ ] 2.3 Ensure manual run controls remain available when automatic triggers are blocked by policy.

## 3. Notification Policy

- [ ] 3.1 Add a small notification-policy helper for dashboard inbox, interruptive channel opt-in, urgency tier, and quiet-window behavior.
- [ ] 3.2 Classify run assistance and connector health events as action-required or informational.
- [ ] 3.3 Ensure Web Push and ntfy failures never hide the dashboard inbox state.

## 4. Validation

- [ ] 4.1 Add tests for all trigger kinds using the same policy projection.
- [ ] 4.2 Add tests for the four automation modes.
- [ ] 4.3 Add tests for informational quiet-hours suppression and action-required delivery eligibility.
- [ ] 4.4 Run `openspec validate add-run-automation-policy-model --strict`.
