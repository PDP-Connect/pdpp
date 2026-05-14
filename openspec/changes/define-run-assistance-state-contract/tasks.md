## 1. Contract And Timeline

- [x] 1.1 Add reference-run-assistance types for progress posture, owner action, response obligation, attachment kind, sensitivity, lifecycle status, and safe timeline payloads.
- [x] 1.2 Add runtime helpers that normalize existing `INTERACTION` and future structured assistance requests into the run-assistance shape.
- [x] 1.3 Persist assistance requested, resolved, timed out, cancelled, and escalated transitions in the reference run timeline with redaction tests.
- [ ] 1.4 Ensure submitted secret values, raw browser bearer URLs, QR secrets, and durable credentials are not written to timeline payloads.

## 2. Runtime Compatibility

- [x] 2.1 Map existing `otp`, `credentials`, and `manual_action` messages into assistance states without breaking current connector callers.
- [x] 2.2 Add a connector-runtime API for nonblocking owner assistance where progress posture is `running` and response obligation is `none`.
- [x] 2.3 Keep plain `PROGRESS` as observability and prevent new owner-action helpers from using it as the only structured signal.
- [x] 2.4 Preserve existing `_ref/runs/:runId/interaction` behavior for blocking input while routing it through assistance lifecycle events.

## 3. Attachments And Browser Surface Boundary

- [x] 3.1 Represent browser streaming as a `browser_surface` attachment reference instead of a generic interaction requirement.
- [ ] 3.2 Represent unavailable browser-surface registration honestly in assistance state and dashboard copy.
- [x] 3.3 Keep CDP, Playwright, n.eko, WebRTC, and target-registration details inside browser binding or remote-surface layers.
- [ ] 3.4 Add tests for non-browser attachments such as URL or QR assistance without requiring a browser surface.

## 4. Dashboard UX

- [x] 4.1 Render `running` + `act_elsewhere` + `none` as passive waiting with no required stream or submit CTA.
- [x] 4.2 Render `blocked` + `provide_value` + `response_required` as a form with secret handling and no durable credential persistence.
- [x] 4.3 Render `operate_attachment` + `browser_surface` as the streaming companion entry point.
- [x] 4.4 Render `waiting_retry` + `none` + `none` as retry/backoff status with no owner-action CTA.
- [x] 4.5 Update confusing fallback copy so stream-control language appears only when a browser surface is actually required and available.

## 5. Connector Migrations

- [x] 5.1 Migrate ChatGPT app-push approval from plain progress to structured `running` + `act_elsewhere` + `none` assistance.
- [x] 5.2 Migrate ChatGPT timeout fallback to an explicit escalation from nonblocking assistance to blocking manual resume.
- [ ] 5.3 Audit USAA, Chase, Amazon, Reddit, and Gmail for owner-assistance cases and map each to the new model or explicitly defer.
- [x] 5.4 Keep connectors that do not use Playwright able to request assistance through the same runtime contract.

## 6. Acceptance Checks

- [x] 6.1 Validate `openspec validate define-run-assistance-state-contract --strict`.
- [ ] 6.2 Add unit tests for all canonical mappings: app approval, OTP, credentials, browser control, retry/backoff, URL/QR attachment, stream unavailable, timeout escalation.
- [x] 6.3 Run relevant reference, polyfill connector, remote-surface, and dashboard tests.
- [ ] 6.4 Run one fresh ChatGPT app-push flow in Docker and verify it shows passive waiting, auto-continues after approval, and does not require the stream unless escalated.
- [ ] 6.5 Run one browser-control manual-action flow in Docker and verify the stream CTA appears only for `browser_surface` assistance.
