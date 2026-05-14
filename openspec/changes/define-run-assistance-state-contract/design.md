## Context

The reference runtime currently has two broad owner-facing channels:

- `INTERACTION` for blocking input (`credentials`, `otp`, `manual_action`).
- `PROGRESS` for nonblocking status.

That split is not expressive enough for browser-backed and non-browser connectors. ChatGPT app-push approval exposed the problem: the run needed the owner to approve something outside PDPP while the connector could keep polling, but the system rendered it as `manual_action` and implied that the owner had to open the streaming companion and click continue.

The durable design problem is not ChatGPT-specific and not Playwright-specific. Any connector may need assistance through a browser surface, app approval, QR code, device link, OTP form, file picker, rate-limit wait, or blocked challenge. The reference needs a small model that preserves essential distinctions without turning every website-specific case into a new enum variant.

## Goals / Non-Goals

**Goals:**

- Represent owner assistance as a small set of orthogonal facts rather than a broad `needs_human` bucket or a large scenario enum.
- Keep browser streaming as an optional attachment to assistance, not the definition of assistance.
- Support arbitrary connectors, including connectors that are not Playwright-driven and do not have a browser page.
- Give the reference dashboard deterministic UX semantics for each assistance shape.
- Keep secrets, fixtures, and browser-surface references scoped to the active run and redacted from durable timeline payloads.
- Make it clear which pieces may become Collection Profile semantics and which are reference-runtime/operator UX only.

**Non-Goals:**

- Do not standardize remote browser streaming as PDPP Core.
- Do not make Playwright, CDP, or n.eko concepts part of the generic connector-runtime contract.
- Do not replace all existing `INTERACTION` callers in one step.
- Do not build a complete scheduler, credential vault, or challenge-solving system in this change.
- Do not require connectors to predict every possible future assistance need in their manifests.

## Decisions

### 1. Model Assistance As Orthogonal Fields

The target shape is compositional:

```ts
{
  progress_posture: "running" | "blocked" | "waiting_retry";
  owner_action: "none" | "act_elsewhere" | "provide_value" | "operate_attachment";
  response_contract: "none" | "response_required";
  attachments?: AssistanceAttachment[];
  sensitivity?: "none" | "non_secret" | "secret";
  input_schema?: Record<string, unknown>;
  timeout_seconds?: number;
}
```

These names are provisional; the axes are the design commitment.

Why not one state enum:

- `chatgpt_push_pending`, `bank_push_pending`, `captcha_pending`, and `qr_pending` would be incidental complexity.
- The UI does not need website identity to render the right controls; it needs progress posture, owner action, response obligation, attachment, and sensitivity.

Why not a single `needs_human` flag:

- It complects unrelated behavior. The UI cannot know whether to wait, ask for a code, open a stream, or schedule a retry.
- It recreates the failure mode from app-push approval, where a nonblocking external approval was rendered as browser control.

### 2. Keep Assistance Generic And Attachments Specific

The generic runtime may know about attachment kinds, but not implementation details:

- `browser_surface`: a reference to a streamable surface.
- `url`: an owner-openable link.
- `qr`: a QR payload or image reference.
- `file`: a file-pick or file-provide request.
- `fixture`: diagnostic evidence captured for the operator/developer.

Browser-specific details such as Playwright `Page`, CDP wsUrl, n.eko stream base URL, WebRTC credentials, and pointer mapping stay in the browser binding and remote-surface layers. They are resolved into an attachment reference, not embedded into the generic assistance model.

### 3. Separate Runtime Progress From Response Obligation

`progress_posture = running`, `owner_action = act_elsewhere`, and `response_contract = none` means:

- Emit an owner-visible notice.
- Keep the connector running and polling.
- Do not create a blocking response slot.
- Escalate to a blocking state only if polling times out or the connector loses the ability to observe completion.

This is the generic version of ChatGPT app-push approval and banking app approval.

### 4. Preserve Existing Compatibility During Migration

Existing `INTERACTION` messages remain valid. The reference can map them into assistance shapes:

- `otp` -> `blocked` + `provide_value` + `response_required` + `secret`.
- `credentials` -> `blocked` + `provide_value` + `response_required` + `secret`.
- `manual_action` with browser handoff -> `blocked` + `operate_attachment` + `response_required` + `browser_surface`.
- `PROGRESS` remains nonblocking observability, but new code uses structured assistance when the owner is expected to act.

The migration should add the new model beside existing messages first, then update callers opportunistically.

### 5. Persist Safe Assistance State, Not Sensitive Values

The reference run timeline should record assistance requested/resolved/expired/cancelled states with machine-readable fields. It must not persist submitted secrets, raw browser bearer URLs, raw QR secrets, or durable credentials.

The runtime may retain ephemeral response waiters and short-lived attachment tokens. Submitted values satisfy the current run only unless a separate credential/storage capability explicitly persists them.

### 6. UI Is Derived From State

The dashboard should derive copy and controls from structured assistance facts:

- `running` + `act_elsewhere` + `none`: show instruction and passive waiting state; no stream button by default.
- `blocked` + `provide_value` + `response_required`: show a form generated from `input_schema`; suppress sensitive values from timeline.
- `blocked` + `operate_attachment` + `browser_surface`: show streaming companion controls.
- `waiting_retry` + `none` + `none`: show retry/backoff status; no owner action CTA.
- Timeout fallback may transform a nonblocking state into a blocking one, but that transition must be explicit in the timeline.

### 7. Collection Profile Boundary

The live assistance state is reference/runtime behavior today. It is not PDPP Core.

The Collection Profile candidate semantics are:

- Connector runs can request bounded owner assistance.
- Assistance requests have secret-handling rules.
- Assistance resolution can gate collection progress.
- Runs must remain honest about pauses, timeouts, and cancellation.

Reference-only semantics include:

- Dashboard route names.
- Streaming companion implementation.
- n.eko/CDP/Playwright target resolution.
- Fixture capture storage.
- Operator copy and layout.

If the Collection Profile later standardizes assistance, it should standardize the minimal axes and safety semantics, not n.eko or ChatGPT-specific behavior.

## Risks / Trade-offs

- [Risk] The compositional model is too abstract for implementers.
  → Mitigation: include canonical scenarios and mapping examples for OTP, app approval, captcha/browser control, QR approval, retry/backoff, and stream attach failure.

- [Risk] The model becomes a dumping ground for UI details.
  → Mitigation: keep UI layout/copy out of the protocol fields; store only progress posture, action, response obligation, attachment kind, sensitivity, timeout, and safe messages.

- [Risk] Browser streaming leaks into generic runtime semantics.
  → Mitigation: attachment references are generic; browser target resolution stays in browser binding and remote-surface packages.

- [Risk] `PROGRESS` remains overloaded during migration.
  → Mitigation: allow compatibility, but require new owner-action cases to emit structured assistance.

- [Risk] The Collection Profile boundary remains ambiguous.
  → Mitigation: label each requirement as reference-runtime behavior unless it is explicitly a candidate for Collection Profile promotion.

## Migration Plan

1. Add reference-only assistance event types and timeline persistence behind existing interaction behavior.
2. Map existing `INTERACTION` kinds into assistance shapes without changing connector APIs.
3. Add dashboard rendering for assistance shapes and keep existing interaction controls as compatibility fallback.
4. Add a connector-runtime helper for nonblocking owner notices where the connector continues running and no response is owed.
5. Migrate ChatGPT app-push from plain `PROGRESS` to structured assistance.
6. Migrate browser `manual_action` to emit a browser-surface attachment.
7. Update docs/OpenSpec with what remains reference-only versus Collection Profile candidate.

Rollback is straightforward while compatibility remains: keep existing `INTERACTION` handling and ignore new assistance events in older UI surfaces.

## Connector Assistance Audit

This audit records the migration decision for implemented connectors. It is not a claim that every connector is live-proven in Docker; it separates assistance-contract readiness from browser/runtime deployment readiness.

| Connector | Current mode | Assistance mapping | Docker deployment decision |
| --- | --- | --- | --- |
| ChatGPT | Playwright plus browser-session API calls | Migrated to structured nonblocking app-push assistance; OTP and manual fallbacks remain supported | Use as the reference browser-backed connector; requires managed n.eko/remote surface or local collector browser |
| USAA | Playwright browser with persistent profile and downloads | OTP maps through compatibility; manual login fallback should move to the browser-handoff helper before being considered polished | Defer full Docker proof until browser-surface fallback is migrated |
| Chase | Playwright headed-browser connector | OTP maps through compatibility; app-push, if observed, should use nonblocking assistance | Defer provider-Docker proof; run through local collector or managed remote surface |
| Amazon | Playwright browser with bot/CAPTCHA risk | OTP maps through compatibility; CAPTCHA/manual remediation should become explicit browser-surface assistance | Defer full Docker proof until CAPTCHA/manual fallback is modeled |
| Reddit | Playwright login plus page-context fetch | OTP/manual compatibility exists, but manifest assistance declarations need correction | Defer full Docker proof until manifest and manual fallback are aligned |
| Gmail | Network-only IMAP | Credential prompt maps through compatibility, though the connector should eventually use the shared helper | Docker-ready when app password/env or an explicit credential response is available |
| claude-code | Local filesystem collector | No owner assistance expected | Keep local-collector only; Docker needs mounted user filesystem |
| codex | Local filesystem/CLI-state collector | No owner assistance expected | Keep local-collector only; Docker needs mounted user filesystem |

## Open Questions

- Should the connector-facing message be a new stdout message type, an extension of `INTERACTION`, or a runtime helper that emits existing messages plus structured timeline metadata?
- Should assistance attachments be single-primary plus diagnostics, or a list with one recommended attachment?
- Which parts of assistance should Collection Profile standardize now versus leave as reference-only until more connectors prove the shape?
