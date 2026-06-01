# Owner-Agent Browser-Bound Connection Creation

Status: captured
Owner: RI owner
Created: 2026-06-01
Updated: 2026-06-01
Related: `openspec/specs/reference-owner-agent-control-surface/spec.md`, `openspec/specs/reference-connector-instances/spec.md`, `openspec/changes/add-browser-collector-enrollment-primitive`

## Question

Should a trusted owner-agent bearer be able to create a browser-bound connection, such as Amazon, by returning an `enroll_browser_collector` next step that lets a delegate drive the browser while the owner handles OTP, push approval, CAPTCHA, or other account-trust prompts?

## Context

The owner-agent connection intent route can initiate proven local-collector enrollment, but browser-bound connectors currently return a typed `unsupported` next step. The public contract reserves `enroll_browser_collector`, and the reference has browser-collector enrollment machinery, but the owner-agent intent branch has not been flipped because committed end-to-end proof for a real logged-in browser session creating an addressable connection is still missing.

This matters for shared-account workflows. A delegate such as Simon may have owner-level owner-agent access and enough context to connect a shared Amazon account, while the owner remains the only person who should approve account-trust prompts on their phone or enter sensitive challenges.

The important distinction is connection creation vs. run initiation. Existing owner-agent access already covers control of existing connections and local-collector connection intents. The open question is whether that same owner-agent authority can start creation of a new browser-bound connection without requiring the owner to be the person driving the dashboard session. Manual challenges are not the hard blocker by themselves: a delegate can drive the browser surface while the owner responds to push approvals or account-trust checks out of band, as long as sensitive challenge material and session-control links remain owner-mediated and time-bounded.

## Stakes

If the route stays unsupported, a delegate with owner-agent access can run and manage existing connections but cannot create an Amazon connection without an owner dashboard session. That preserves honesty but blocks useful assisted setup.

If the route emits `enroll_browser_collector` before the proof is complete, the RI may imply a durable browser connection exists when it has only minted an intent. That would repeat the class of usability gaps where a surface says "supported" but the owner cannot complete the task through the advertised path.

## Current Leaning

Promote this when we can implement it as an owner-mediated, auditable, least-privilege flow:

- The owner-agent bearer may request creation for a browser-bound connector.
- The owner-agent bearer does not need an owner dashboard session merely to initiate the connection intent, if the bearer was explicitly granted owner-level control.
- The RI returns `next_step.kind = "enroll_browser_collector"` only when the connector manifest is registered and the browser collector path is operational.
- The durable connection is created only after a browser-collector enrollment or equivalent browser-profile binding completes.
- The delegate can drive the browser session, but owner-trust prompts remain owner-mediated.
- Secrets, OTP text, and session-control URLs are treated as sensitive and time-bounded.
- The resulting connection is a normal `connection_id` owned by the owner subject and usable by owner-agent run/control APIs.

## Promotion Trigger

Promote into OpenSpec before flipping the owner-agent intent route from `unsupported` to `enroll_browser_collector` for Amazon or any other browser-bound connector. The change should include the route contract, owner/delegate UX constraints, audit events, browser-profile binding semantics, failure states, and a real end-to-end proof that creates a connection and ingests records.

## Decision Log

- 2026-06-01: Captured after the owner clarified that the question was not run initiation, but creating the Amazon connection with owner-level access granted to a delegate.
