# Calibrated Thresholds And Copy

Status: captured
Owner: reference implementation owner
Created: 2026-06-15
Change: `redesign-connection-health-verdict-and-recovery`

## Purpose

This note records the connector-health thresholds and owner-facing copy choices
that are intentionally judgment-based. They are part of the SLVP calibration
surface: reviewers should be able to see which choices are policy, which
evidence justified them, and which tests pin them.

## Calibrations

| Choice | Calibration | Evidence | Pinned by |
|---|---|---|---|
| Advisory vs. attention | `attention` is reserved for an owner-audience primary action with `satisfied_when.kind !== "none"` where the owner is the sole resolution. Owner-optional accelerants and maintainer/status work stay `advisory`. | `docs/research/slvp-connector-health-FINAL-design-2026-06-15.md` §3.2 and §4.4; live evidence showed Amazon stale/manual refresh and Chase retryable gap are actionable but not push-worthy. | `reference-implementation/test/rendered-verdict.test.js` golden fixtures; `reference-implementation/test/notification-policy.test.js`; `reference-implementation/test/web-push-notifications.test.js`. |
| Push eligibility | Escalation Web Push emits only when the rendered verdict is `channel: "attention"` and the primary action is owner-satisfiable. `calm` and `advisory` suppress before transport. | Same agency rule as above; prevents scheduler `needs_attention` / `blocked` transitions from bypassing the server-owned verdict channel. | `fanoutEscalationWebPush: rendered verdict channel suppresses non-attention pushes`; `fanoutEscalationWebPush: rendered attention verdict sends to owner subscriptions`. |
| Stale/manual-refresh language | Manual-refresh account sources use owner-action copy such as "Run a refresh to bring this up to date" / "Refresh now"; stale freshness is always annotated. | Live Amazon/Reddit/USAA schedule absence is manual-refresh posture, not a credential defect. The refresh contract is derived from manifest `recommended_mode` + `background_safe`, not credential presence. | `reference-implementation/test/refresh-evidence-wiring.test.js`; `reference-implementation/test/rendered-verdict.test.js` Amazon fixture. |
| Stream-priority weighting | Required streams participate in the worst-wins rollup; accepted absence and optional streams do not manufacture a red/blocked owner action without an action that can be satisfied. | Preserves honesty without treating optional coverage as owner-blocking. Terminal/maintainer work renders as status, not an owner button. | `reference-implementation/test/rendered-verdict.test.js` property/composite tests and synthetic `code_fix` fixture. |
| Runtime liveness sensitivity | Runtime faults cap every per-connection `channel` at `calm`; one global runtime indicator owns the interruption. Per-connection `pill.tone` remains honest. | Prevents an infrastructure fault from becoming N owner-facing alarms. Matches the design note's runtime-vs-connection cascade guard. | `reference-implementation/test/runtime-cascade-guard.test.js`; `reference-implementation/test/rendered-verdict.test.js` runtime fault fixture. |
| Mechanistic counts on dashboard | Dashboard/list/passport attention layer does not render raw gap, retry, backlog, `next_attempt_at`, or collection-rate counts. These remain in `RenderedVerdict.detail`. | Live ChatGPT had 2,532 recovered gaps and 0 pending gaps; the count is true but not owner-actionable. | `reference-implementation/test/rendered-verdict.test.js` ChatGPT fixture; Sources/detail surface tests assert verdict summary and no dead owner CTA. |

## Residual Calibration Gates

The live-owner acceptance pass still needs to confirm the same choices against
`pdpp.vivid.fish`: ChatGPT calm/fresh with the 2,532 backlog absent from the
dashboard but present in detail, Amazon stale/manual refresh as advisory, and
Chase retryable transactions gap as advisory with a truthful next-run statement.
