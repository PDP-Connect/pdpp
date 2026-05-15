# Reference Implementation Owner Handoff - 2026-05-15

This is a durable handoff for the next reference implementation owner. It is
not only a status report. It captures the operating model, quality bar,
architecture direction, recent lessons, current live state, and the work that
must continue without losing the thread.

The immediate reason for this document is token scarcity. the owner has Claude Code
available and needs another agent to proceed faithfully with minimal rediscovery
and minimal waste.

## 1. Mission

PDPP is a protocol and reference implementation for user-controlled,
purpose-bound personal data access. The reference implementation must prove
that users can authorize agents and services to collect their own data from
real systems while preserving user agency, auditability, and data minimization.

This project is not a toy demo. It is a reference implementation intended to be
read, forked, challenged, and used as evidence for the protocol design. Every
connector, runtime path, UI flow, and storage behavior should be honest about
what it did, what it could not do, and what evidence exists.

The most important product truth is this:

> The user is in the driver's seat. The system assists the user in exercising
> their own access rights. It must not pretend to have collected complete data
> when it has not, and it must not bypass controls that require user approval.

The current reference implementation is also being used as the testbed for a
remote human interaction surface. That surface exists so a user can complete
manual steps in their own browser running in their own personal server or
deployment, including account login, MFA approval, consent screens, and other
legitimate interactive steps.

## 2. Owner Role

The owner is responsible for outcomes, not just patches.

When you take over, do not merely fix the next visible symptom. Maintain the
architecture, quality bar, and roadmap. If a patch makes one run pass while
weakening the design, it is not a success.

The owner should:

- Keep the end-to-end user journey in view.
- Use OpenSpec for non-trivial protocol, architecture, storage, runtime, or UX
  behavior changes.
- Use subagents and Claude workers aggressively for legwork, but keep ownership
  of synthesis, review, and final merge decisions.
- Batch related work when the process overhead of tiny tranches would dominate,
  while still maintaining clear acceptance gates.
- Commit coherent changes as progress is made.
- Prove important changes with tests and live reference runs before reporting
  them as done.
- Ask the user only for actions that truly require the human, such as OTP
  codes, app push approval, device subscription, or corroborating account
  contents.
- Never ask the user to retest a state you already expect to be broken.

The user has repeatedly emphasized that the reference implementation owner is
expected to coordinate effectively. That means the parent agent should not burn
scarce high-value tokens reading every file or driving every browser step when
workers can gather evidence, implement bounded patches, or validate specific
lanes.

## 3. SLVP Quality Bar

the owner uses "SLVP" as the practical standard for this work: the Simplest Lossless
Verifiable Path.

The target is usually 95%+ confidence, and sometimes effectively 99% when the
design boundary is durable. This does not mean slow by default. It means fast
work that is defensible, observable, and honest.

### 3.1 Simple

Simple means essential complexity only. Use Rich Hickey's distinction:

- Essential complexity is inherent in the domain: authentication, MFA, rate
  limits, partial data, browser surfaces, schedules, retries, user approval.
- Incidental complexity is accidental machinery: one-off flags, hidden state,
  confusing special cases, opaque failure modes, connector-specific hacks that
  should have been runtime features.

Do not over-engineer. Also do not under-engineer by forcing durable concerns
into local hacks. When several connectors need the same behavior, prefer a
runtime primitive or shared utility over repeated connector code.

### 3.2 Lossless

Lossless means the reference implementation must not throw away meaning.

Examples:

- A connector that finds an account but cannot download statements must preserve
  that fact as a known gap, not silently succeed.
- A conversation discovered from ChatGPT but not fetched in detail must not be
  treated as fully collected.
- A pending Chase transaction that may later become cleared must not be modeled
  as if it were necessarily final.
- A run that needed manual human approval must record that assistance state
  without storing secrets or OTP values.
- A streamed browser that is usable for clicking but not typing is not a
  complete manual-action surface.

Lossless also applies to learning. If a painful failed attempt taught us that a
strategy fights n.eko instead of enhancing it, capture that in design notes or
this handoff so future agents do not repeat it.

### 3.3 Verifiable

Verifiable means there is evidence.

Expected evidence for a connector/runtime change:

- Relevant unit tests pass.
- Typecheck/lint for touched package passes.
- Docker deployment is rebuilt when Docker/runtime code changed.
- A live run proves the target path when the change affects live account flows.
- DB/timeline records are inspected programmatically.
- Known gaps are explained with recovery action.
- No false success is accepted.

For UI/remote-surface changes, telemetry alone is not enough unless it measures
the user-perceived behavior. Several prior iterations had telemetry saying
things were fine while the user saw a tiny stream, wrong pointer alignment, or
broken rotation. When telemetry and human perception disagree, telemetry is
incomplete.

## 4. Token and Process Discipline

The project has only a small amount of high-value model quota left for the
week. Claude Code is available. Use it.

Recommended operating model:

1. Parent agent owns the plan, acceptance criteria, and merge gate.
2. Low-cost workers do code search, fixture inspection, narrow patches, DB
   queries, and test runs.
3. Parent reviews worker reports and diffs in batches.
4. Parent commits coherent chunks.
5. Parent asks the owner to test only when the system is at a meaningful acceptance
   point.

Worker prompts should be explicit:

- Scope and files/modules owned.
- What not to touch.
- Validation commands required.
- Required report format.
- Whether edits are allowed.
- Reminder not to revert others' changes.

Avoid token-wasting behaviors:

- Do not use browser/Playwright through chat for tasks a worker or script can
  do.
- Do not paste large logs into the main thread. Query and summarize.
- Do not ask the owner to describe problems that telemetry, screenshots, fixtures,
  DB records, or logs can reveal.
- Do not rediscover settled decisions. Search the docs, OpenSpec changes, and
  recent commits first.
- Do not keep cycling on "probably fixed" without a concrete acceptance gate.

## 5. Safety and Security Framing

This work has repeatedly triggered automated cybersecurity-risk flags in the
chat environment. The correct framing is important.

The work here is authorized personal data collection and user-driven browser
interaction. The user is accessing their own accounts through their own
deployment. The system should not bypass account protections, steal sessions,
or automate around controls that require human approval.

Acceptable goals:

- Let the user view and control their own remote browser.
- Detect when a connector needs human action.
- Prompt the user to approve MFA or enter an OTP.
- Preserve browser profiles when that improves legitimate continuity and
  reduces repeated login prompts.
- Record sanitized diagnostics and fixtures for debugging.

Unacceptable goals:

- Bypassing MFA, CAPTCHA, Cloudflare, or anti-abuse controls.
- Logging OTP values, passwords, session cookies, or secrets.
- Using stealth language as a goal in itself instead of preserving a real,
  user-driven browser session.
- Treating anti-bot systems as enemies to evade rather than as constraints that
  require the user to remain in control.

Prefer language like "manual-action remote surface", "user approval",
"browser surface", "interaction assistance", and "user-owned browser profile".
Avoid casual language that sounds like evasion.

## 6. Repository Map

Important top-level areas:

- `openspec/`: authoritative proposal/spec workflow for durable changes.
- `design-notes/`: non-canonical intake for design questions and open issues.
- `reference-implementation/`: runtime server, event spine, connector runtime,
  owner APIs, scheduler, streaming routes, tests.
- `packages/polyfill-connectors/`: browser/data connectors, parsers, auto-login
  helpers, connector tests.
- `packages/remote-surface/`: emerging remote-surface substrate intended to be
  cleanly extractable and eventually close to OSS-ready.
- `apps/web/`: dashboard UI and stream viewer.
- `docker/neko/`: n.eko image, Chromium launch, CDP proxy, X/stream support.
- `docs/`: handoffs, research, design briefs, operational notes.
- `tmp/`: workstream reports, fixtures, transient evidence. Do not treat as
  canonical unless promoted.

Read before non-trivial design or implementation:

- `AGENTS.md`
- `openspec/README.md`
- `docs/agent-workstream-playbook.md`
- `docs/handoff-2026-05-12.md`
- `docs/5-12-26-chatgpt-remote-surface-brief-response.txt`

## 7. Core Commands

Use the repo root unless noted.

Docker reference deployment:

```bash
docker compose --profile neko-dynamic --env-file .env.docker \
  -f docker-compose.yml -f docker-compose.neko.yml up -d --build reference
```

Bring the full stack up:

```bash
docker compose --profile neko-dynamic --env-file .env.docker \
  -f docker-compose.yml -f docker-compose.neko.yml up -d
```

List containers:

```bash
docker compose --profile neko-dynamic --env-file .env.docker \
  -f docker-compose.yml -f docker-compose.neko.yml ps
```

Polyfill connector tests and typecheck:

```bash
cd packages/polyfill-connectors
pnpm exec tsx --test src/auto-login/chase.test.ts connectors/chase/parsers.test.ts connectors/chase/integration.test.ts
pnpm typecheck
```

Remote-surface tests:

```bash
pnpm --filter @pdpp/remote-surface test
```

Reference tests are mixed Node tests; prefer targeted files first:

```bash
cd reference-implementation
pnpm test
```

OpenSpec validation:

```bash
openspec validate <change-name> --strict
```

Git discipline:

```bash
git status --short
git diff --stat
git log --oneline -12
```

## 8. Data Inspection Hints

Prefer programmatic DB inspection to manual UI interpretation.

Useful concepts:

- Timeline events live in the event spine, often with JSON payloads.
- Records use `records.connector_id` and `records.stream`.
- Some older assumptions about `stream_id` are wrong in current queries.
- Known gaps may be represented in completion events and/or detail-gap tables.
- Do not log sensitive payloads; summarize counts and error classes.

When a run reports `succeeded_with_gaps`, inspect:

- Run terminal event.
- Known gaps in timeline payload.
- Record counts by stream.
- Connector detail gaps, if present.
- Whether staged state was committed.
- Whether the cursor advanced.
- Whether gaps are retryable, selector pending, download failures, or expected
  partial coverage.

## 9. Recent Commit State

As of this handoff, recent commits include:

- `d12c72a Fix Chase OTP shadow input selection`
- `9b7a85a Keep n.eko CDP websocket tunnels alive`
- `9e763f5 Fix Chase OTP and current activity parsing`
- `4eb74e5 Fix source webhook dedupe for Postgres`
- `db6404b Harden Gmail attachment backfill`
- `7b7750f Add reference source webhook ingress`
- `4614591 Add local agent inventory streams`
- `a64a4e6 fix chase download artifact persistence`
- `c650817 Add connector instance registry substrate`
- `60f8177 Hide unproven local connectors from catalog`
- `b89bb2b Advance Gmail attachment backfill proof`
- `b686428 Add OpenSpec for local agent collector completeness`

The last proven live run before this handoff was Chase `run_1778852923848`.
The user submitted an OTP. The run reached `succeeded_with_gaps`.

This means:

- The Chase OTP/manual assistance path is much healthier than before.
- The run is not a clean success.
- The remaining Chase gaps are real work, not cosmetic status wording.

## 10. Current Connector Status

This section is intentionally conservative. A connector is not "working" unless
it has been proven in the current Docker deployment and does not report false
success.

### 10.1 Chase

Current status: partially working in Docker through n.eko.

What is proven:

- Managed n.eko surface can be leased for Chase.
- OTP assistance can reach the user.
- The CDP websocket tunnel no longer times out during normal OTP waiting.
- The Chase OTP field is a shadow-DOM input and the current selector fix
  correctly targets it.
- After OTP, the connector can verify session, enumerate at least one account,
  and collect some records.
- Latest known run produced records:
  - `accounts`: 1
  - `balances`: 1
  - `statements`: 5
  - `transactions`: 15

Latest live result:

- `run_1778852923848`: `succeeded_with_gaps`

Known remaining gaps from that run:

- QFX download failed with Playwright download/artifact path errors.
- Statement PDF downloads failed with `download.saveAs` / `ENOENT` class
  errors, while index records were still emitted.
- Current activity parsing still reported selector pending in the live account
  activity path, despite earlier parser work for MDS dashboard overview rows.

Important recent root causes and fixes:

- CDP tunnel sockets inherited a 10 second timeout from `socket.create_connection`.
  That caused browser-surface disconnects during OTP waits. Commit `9b7a85a`
  sets websocket tunnel sockets back to blocking mode and enables TCP_NODELAY
  where possible.
- Chase OTP visible input is inside `mds-text-input-secure#otpInput` shadow DOM.
  Commit `d12c72a` targets the shadow input instead of the hidden disabled
  light-DOM input.
- Chase Next button is also an MDS/shadow component. The fix targets
  `mds-button#next-content` then its shadow `button`.

Next Chase actions:

1. Inspect the latest Chase gaps from `run_1778852923848` directly.
2. Fix Playwright download artifact handling in Docker for QFX and PDF
   downloads. Do not accept index-only statement records as complete if PDFs
   were requested and failed.
3. Resolve the current-activity mismatch between dashboard overview MDS rows
   and the account activity page path used in the live run.
4. Improve fixture capture around assistance boundaries and failure points so
   OTP/current-activity/download failures produce useful, scrubbed artifacts.
5. Re-run Chase only after expected failures are fixed. Ask the owner for OTP only if
   the live account flow requires it.

### 10.2 ChatGPT

Current status: partially working, not yet reliable.

What is proven:

- ChatGPT can run through the managed browser surface path.
- ChatGPT login can reach app push approval / 2FA states.
- The connector can collect significant data when the session is active.
- Backoff messages now mention the 15 minute cap in at least some runs.
- The reference can produce manual-action events for ChatGPT login assistance.

Known issues:

- ChatGPT detail fetches frequently hit rate limiting or network pressure.
- The newer connector has struggled with only hundreds of conversations, while
  a much older connector once synced thousands. This discrepancy is unresolved.
- It is unclear whether the platform, the account state, connector request
  pattern, or previous test activity caused the increased rate limiting.
- The 2FA/manual-action UX has been confusing. the owner saw prompts like "No
  streaming target registered for this run" and messages that implied he should
  approve in the app and also manually confirm.
- There is a design tension around cursor advancement, partial success,
  `DETAIL_GAP`, and retryability.

Important design direction:

- Do not blindly advance a source cursor after discovering items whose details
  could not be collected unless the system has a durable, query-visible,
  retry-safe representation of that detail gap.
- Do not let ChatGPT runs report clean success when only list-level data was
  collected but conversation details were skipped.
- Treat adaptive bounded concurrency as a reusable connector utility, not a
  ChatGPT-only pile of sleeps.
- The preferred starting algorithm discussed was conservative loss-based AIMD:
  start small, cut to 1 on pressure, increase only after sustained success.
  the owner later pushed to let it start less conservatively if the algorithm is
  sound. This should be implemented deliberately and measured.

Next ChatGPT actions:

1. Inspect current ChatGPT adaptive throttling code and recent run timelines.
2. Compare request patterns against the old successful connector in git history
   or `~/code/data-connectors` if available.
3. Verify sanitized 429/network-pressure diagnostics are implemented and useful
   without logging sensitive data.
4. Clarify and update OpenSpec/design notes for `DETAIL_GAP`: non-commitment,
   semantics, query visibility, retryability, and cursor interaction.
5. Make 2FA assistance state precise and less confusing: the user should know
   whether the system is waiting for an external approval, whether the browser
   surface is available, and whether the connector can auto-detect completion.
6. Prove a run that either completes cleanly or reports meaningful retryable
   gaps without false success.

### 10.3 USAA

Current status: not proven in Docker.

Known from discussion:

- USAA failed immediately in earlier Docker attempts.
- It likely needs the managed n.eko/browser-surface path and better assistance
  events.
- Do not assume the connector implementation alone is the issue. Some failures
  are collection-profile/runtime-binding concerns: whether the connector is
  launched with the correct browser surface, profile, and interaction support.

Next USAA actions:

1. Inspect latest USAA run timelines and fixture output.
2. Confirm the connector declares/receives the runtime bindings it needs.
3. Enable the appropriate managed n.eko/browser surface if not already done.
4. Add general assistance-boundary fixture capture before doing selector work.
5. Only then calibrate selectors or login steps.

### 10.4 Gmail

Current status: likely functional, but attachment completeness needs proof.

Recent commits:

- `db6404b Harden Gmail attachment backfill`
- `b89bb2b Advance Gmail attachment backfill proof`

Important nuance:

- the owner believes Gmail already supported attachments after the initial scan.
- The recent work may have been hardening/backfill rather than a new feature.
- Do not present Gmail attachment support as done without proving that all
  expected attachments for a representative account are fetched, persisted, and
  query-visible.

Next Gmail actions:

1. Run or inspect a Gmail backfill that includes messages with attachments.
2. Verify attachment records/artifacts exist and are linked to mail records.
3. Ensure schedules or manual reruns can backfill attachments missed by earlier
   scans.

### 10.5 Claude and Codex Local Collectors

Current status: inventory substrate exists, but complete local collection does
not.

Recent commit:

- `4614591 Add local agent inventory streams`

OpenSpec:

- `openspec/changes/complete-local-agent-collectors`

the owner wants:

- 100% complete local collection for Claude and Codex where feasible.
- Multi-device support.
- Clear UX for multiple local collectors and multiple instances.

Next actions:

1. Treat this as a real collector completeness project, not a placeholder.
2. Inventory what local data is available for Claude Code and Codex.
3. Define streams and durable identity semantics.
4. Implement incrementally with fixtures and local tests.
5. Do not overclaim until payload-level collection is proven.

### 10.6 Slack / Slackdump and Other Connectors

Current status: unknown / needs audit.

the owner explicitly asked for an audit of connectors in the server and getting them
working to the extent possible without human assistance.

Next actions:

1. List all visible and hidden connectors in the server catalog.
2. Categorize each as proven, partially proven, unproven, hidden, or stub.
3. For each visible connector, verify it can run in Docker or hide it.
4. For Slack/slackdump specifically, inspect current state before promising a
   fix.

### 10.7 Hidden / Unproven Connectors

Recent commit:

- `60f8177 Hide unproven local connectors from catalog`

the owner explicitly named iMessage as unproven. Spotify and stub connectors were
also discussed as hidden/unproven.

Policy:

- Do not show connectors as available unless they are proven enough for the
  reference implementation's honesty bar.
- It is better to hide a connector than to let it create false confidence.

## 11. Remote Surface and n.eko Architecture

The remote surface has been the most painful workstream. Capture the lessons
carefully.

### 11.1 Intended Architecture

The intended architecture is:

```text
Patchright/CDP = connector automation plane
n.eko/X11/WebRTC = human manual-action interaction plane
mobile text input controller = IME / keyboard plane
PDPP RemoteSurface = adapter boundary that composes them
```

Patchright/CDP should continue to drive connector automation. When a human is
interacting during `manual_action`, input should go through the remote machine's
native input path wherever possible, not through a hand-rolled CDP screencast
surface.

The dashboard should depend on a `RemoteSurface` interface, not on direct n.eko
or CDP details.

### 11.2 OSS Spinout Goal

The goal is not to publish immediately. The goal is to keep the internal
architecture close to push-button publishable later.

The likely future package shape is a narrow remote-surface substrate:

- Backend-neutral surface interface.
- n.eko adapter.
- CDP fallback/debug adapter.
- Mobile-safe pointer/touch normalization.
- Soft keyboard / IME text input controller.
- Clipboard policy and affordance model.
- Telemetry hooks and playground harness.

Documentation and public examples can wait until publishing is real. Separation
of concerns cannot wait.

Active or relevant OpenSpec changes:

- `openspec/changes/extract-remote-surface-substrate`
- `openspec/changes/extract-remote-surface-streaming-architecture`
- `openspec/changes/make-remote-surface-oss-publishable`
- `openspec/changes/add-neko-browser-surface-leases`
- `openspec/changes/add-dynamic-neko-surface-allocation`

### 11.3 Critical UX History

There was a perceived UX peak before later regressions. At the peak:

- The stream was interactive.
- Typing on mobile was possible.
- Scrolling had improved.
- Keyboard focus behavior was much better than earlier attempts.

Then the implementation backslid through repeated changes around touch bridge,
layout scaling, rotation handling, copy/paste affordances, container rects, and
telemetry. the owner saw:

- Stream content tiny with huge white borders.
- Wrong pointer targeting and cursor offset.
- Browser chrome when it should not appear.
- Rotation settling through multiple wrong intermediate states.
- Soft keyboard toggling on every tap or closing immediately after focus.
- Copy/paste working desktop-to-stream or stream-to-desktop inconsistently,
  especially on mobile.
- Black/white bars and blurry scaling.
- Telemetry claiming quality while the visible UX was wrong.

The lesson is not "add more telemetry and patches forever." The lesson is:

- Work with n.eko, do not fight it.
- Prefer n.eko native behavior when trustworthy.
- Add small, well-evidenced enhancements where n.eko does not cover PDPP's UX.
- Do not replace mature remote-desktop behavior with brittle React math unless
  there is clear evidence.

### 11.4 Current Remote Surface State

Current state is good enough to support Chase OTP and some ChatGPT manual
actions. It is not yet an ideal polished SLVP remote surface.

Do not claim:

- Mobile rotation is solved.
- Clipboard is fully solved across mobile and desktop.
- Pointer alignment is fully solved on all surfaces.
- Remote-surface package is standalone OSS-ready.
- Dynamic n.eko allocation/profile orchestration is finished.

Dynamic browser surfaces and connector instance substrate exist, but full
multi-instance UX and scheduling/routing integration remain unfinished.

## 12. Browser Surface Leases and Profiles

The direction is dynamic per-connector n.eko profiles/surfaces, capped by
leases.

Rationale:

- Separate browser profiles preserve account/session isolation.
- Connectors should not all share one browser profile.
- The runtime should allocate surfaces based on connector needs and resource
  caps.
- The user should not have to manually switch streams if the runtime can route
  assistance to the right active run.

Unresolved design/implementation work:

- Complete dynamic allocation semantics.
- Queue behavior when more connector runs need n.eko surfaces than the cap
  allows.
- Profile lifecycle and retention policy.
- UI for multiple concurrent runs needing assistance.
- How schedules interact with scarce browser-surface leases.
- How connector instances map to browser profiles, especially for multiple
  Gmail accounts or multiple local collectors.

Do not regress to a single shared profile except as a deliberate temporary
fallback with an explicit known limitation.

## 13. Manual Assistance UX

The manual assistance design must generalize across arbitrary connectors.
Connectors may be Playwright-driven, API-driven, local-file-driven, or mixed.

Do not design only for "ChatGPT push approval" or "Chase OTP". The runtime
needs an abstract assistance model.

Good assistance state should answer:

- What is blocking the run?
- What does the user need to do?
- Where can the user do it?
- Is there a live streaming target?
- Can the runtime detect completion automatically?
- Is user confirmation required, or only helpful?
- What is the timeout?
- What data, if any, will be persisted from the response?

Avoid confusing copy:

- Do not tell the user to open a streaming companion if no streaming target is
  registered.
- Do not imply approving an app push also requires manual confirmation unless
  that is actually necessary.
- Do not mention local headed mode as a primary recommendation in a Docker
  remote deployment unless it is truly a useful alternative.

Ideal flow:

1. Connector reaches an assistance boundary.
2. Runtime captures a scrubbed fixture/snapshot.
3. Runtime emits a structured assistance event.
4. UI sends push/PWA/ntfy notification if configured.
5. User opens the run or stream.
6. User completes the action.
7. Runtime detects completion where possible.
8. If detection is impossible, UI asks for a simple confirmation.
9. Connector resumes.
10. Runtime captures post-assistance evidence and records outcome.

## 14. Fixture and Snapshot Capture

Current state: not good enough.

Fixture capture exists in some form, but it has not reliably captured the most
useful pages, especially assistance-boundary states like Chase OTP. In Chase,
fixtures captured post-login pages but not the OTP page before the connector
paused and later failed.

SLVP ideal:

- Capture scrubbed fixtures at every assistance boundary.
- Capture immediately before waiting for user input.
- Capture immediately after user input is submitted.
- Capture on failure.
- Capture relevant frame/shadow DOM context when selectors cross components.
- Redact secrets, OTP values, tokens, account numbers where possible.
- Store enough metadata to connect fixture to run id, connector id, stream,
  URL class, phase, and reason.
- Make fixture capture general runtime behavior, not one-off per connector.

Connector-specific captures are acceptable as short-term diagnostics, but the
durable fix should be general.

## 15. Schedules

Current state: not fully proven.

the owner reported schedules not working, possibly only in Docker. Recent webhook and
dedupe work may have improved part of this:

- `7b7750f Add reference source webhook ingress`
- `4eb74e5 Fix source webhook dedupe for Postgres`

Do not assume schedules are fixed. Prove them.

Next actions:

1. Inspect scheduler state in Docker.
2. Verify a scheduled connector can enqueue and run.
3. Verify webhook-triggered runs dedupe correctly in Postgres.
4. Verify schedules interact correctly with browser-surface leases.
5. Verify failed runs do not permanently wedge future scheduled runs.
6. Add tests for the failure mode found.

## 16. PWA / Web Push Notifications

the owner wants a smoother experience than ntfy, ideally a PWA installed on his phone
that can receive push notifications for run assistance.

Status: design and implementation may be partially present, but do not treat it
as done until proven on a real device.

The correct scope:

- Owner subscribes a browser/device for push.
- Server stores subscription safely.
- Assistance events can fan out to push subscriptions.
- Notification opens the relevant run/stream.
- Works with Docker/public deployment.
- Does not leak sensitive prompt details.
- Can coexist with ntfy during transition.

OpenSpec should exist or be created/updated for this because it changes
durable user-facing behavior, storage, and runtime notification semantics.

Acceptance:

- the owner installs/opens the PWA on phone.
- A run reaches assistance required.
- Phone receives push without ntfy.
- Tapping notification opens the right run or stream.
- The run can continue after assistance.

## 17. Webhooks

Recent status:

- Source webhook ingress exists.
- Postgres dedupe was fixed recently.

Unresolved:

- End-to-end proof for real sources.
- Documentation of event contract.
- Security model for webhook authenticity.
- Idempotency guarantees under retry.
- Interaction with schedules and connector instances.

If extending webhooks, use OpenSpec.

## 18. Multi-Instance Connectors

Recent status:

- `c650817 Add connector instance registry substrate`

the owner wants:

- Multiple Gmail accounts.
- Claude collectors on multiple devices.
- Clean UX for multiple instances of the same connector.
- Schedules and manual runs that target a specific instance.
- Browser profiles that correspond to the right instance where appropriate.

SLVP concerns:

- Instance identity must be durable and user-understandable.
- Records must be attributable to the right source instance.
- Browser profiles should not accidentally cross accounts.
- The UI must not make it easy to run the wrong account.
- Schedules must not collapse distinct instances into one connector id.

This is architecture-level work. Use OpenSpec before expanding behavior.

## 19. Run Outcome Semantics

Do not treat terminal status words casually.

Important distinctions:

- `succeeded`: requested coverage completed within the connector's declared
  scope.
- `succeeded_with_gaps`: useful data was collected and committed, but at least
  one requested source/stream/detail was not fully collected.
- `failed`: connector could not complete and state likely was not committed.
- `waiting` / `pending`: run needs human or external input.

For `succeeded_with_gaps`, always answer:

- Which streams are complete?
- Which streams have gaps?
- Are gaps retryable?
- Did cursor/state advance?
- Were partial records inserted?
- Can clients query the gaps?
- What should the next run do?

Latest Chase example:

- The run succeeded with gaps because some records were collected and committed,
  but QFX/PDF downloads and current activity coverage were incomplete.

## 20. Partial Detail, Cursor, and DETAIL_GAP

This topic is unsettled and important.

Problem:

- A connector may discover a list of items.
- Fetching details for some items may fail due to rate limits, network pressure,
  selectors, or access.
- Advancing the cursor without representing missing detail can lose data.
- Refusing to advance any state can force expensive rediscovery and make large
  connectors brittle.

Concrete ChatGPT example:

- A conversation appears in the conversation list.
- Fetching `/conversation/<id>` fails under rate limiting.
- The system might want to record that the conversation exists, mark detail as
  missing, and retry detail later without re-paging the entire history.

Design questions:

- Is a gap attached to a record, stream, run event, or separate gap table?
- Are gap records query-visible?
- Does a gap participate in completeness reporting?
- Can the connector retry detail directly from the gap?
- Can cursor advance past a discovered-but-incomplete item?
- What happens if a later run fills the gap?

Do not make an irreversible commitment without OpenSpec. The previous
discussion leaned toward a gap representation but the owner was hesitant about
hackiness. Capture non-commitments explicitly.

## 21. ChatGPT Rate Limiting and Throttling

Current hypothesis is not settled.

Known facts:

- Current ChatGPT runs often hit rate limits or network pressure.
- Backoff now caps at 15 minutes in messaging.
- Earlier very old connector reportedly synced thousands of conversations.
- Recent versions have struggled with hundreds.

Possible causes:

- ChatGPT-side policy changed.
- Account got more sensitive after repeated testing.
- Current connector is more aggressive or less browser-like.
- Current connector fetches detail differently.
- Initial sync may not have actually collected the same detail.
- Parallel detail fetches may be too high.

SLVP approach:

1. Compare old and current request patterns.
2. Log sanitized pressure diagnostics, including status, retry headers if any,
   endpoint class, timing, and concurrency state.
3. Use adaptive bounded concurrency, not unlimited parallelism and not
   hard-coded sleeps everywhere.
4. Preserve partial discovery/detail gaps correctly.
5. Prove by run timelines and record counts.

Prior art/research expectation:

- Before building a custom throttler beyond a simple bounded queue, research
  high-traction libraries and prior art. If using custom AIMD, explain why
  existing libraries do not cover the semantics.

## 22. Chase Domain Lessons

Chase has several domain-specific lessons that should be preserved.

### 22.1 OTP

- OTP page uses Material Design System web components.
- Visible OTP field is inside a shadow root.
- Light-DOM inputs may be hidden/disabled mirrors and must not be selected.
- Buttons may also be shadow components.
- Selectors should be semantic and Playwright-best-practice where possible,
  but shadow DOM sometimes requires component-targeted locators.

### 22.2 Pending vs Cleared Transactions

the owner observed that Chase shows recent/pending activity on one page while the
download/activity page can say no activity matched the selected date range.

Likely reason:

- Dashboard/current activity includes pending authorizations and very fresh
  transactions.
- Downloaded statements/QFX or activity export may include only posted/cleared
  transactions for certain date ranges.

Open question:

- Does the PDPP / Collection Profile model explicitly support transactions that
  start pending and later transition to cleared?

Capture this in design notes/OpenSpec if not already captured. Fresh pending
data is valuable, but it needs a model that can reconcile later changes.

### 22.3 Downloads

Download handling in Docker remains suspicious.

Observed errors:

- `download.saveAs: ENOENT`
- Temporary Playwright artifact path missing.
- Statement index records emitted while PDF download failed.
- QFX download gaps despite previous artifact persistence patch.

Likely areas:

- Browser/context lifetime around downloads.
- Artifact directory mounted/created inside container.
- Timing of `download.path()` vs `saveAs()`.
- Cleanup of temporary directories before save completes.
- Whether the page/context is closed before downloads finish.

Fix this at the artifact/runtime helper level if multiple connectors download
files.

## 23. Patching Standards for Connectors

Connector changes must follow modern Playwright best practices:

- Prefer role, label, placeholder, text, and semantic locators.
- Use shadow DOM locators deliberately when components require it.
- Avoid brittle CSS unless constrained by the live DOM.
- Avoid arbitrary sleeps; prefer locator state, URL, network/download events,
  and explicit timeouts.
- Pair live DOM observations with scrubbed fixtures.
- Add parser fixtures for stable markup.
- Keep selectors broad enough for A/B variants where evidence suggests both
  shapes exist.
- Report selector-pending gaps instead of false success.

For financial connectors:

- Do not log OTPs, credentials, account numbers, or full transaction payloads in
  general logs.
- Mask account labels.
- Treat downloads as sensitive artifacts.

## 24. OpenSpec Governance

This repo is spec-driven. Read `openspec/README.md`.

Use OpenSpec when:

- Introducing a new capability.
- Changing runtime contracts.
- Changing storage schemas.
- Changing run outcome semantics.
- Adding durable notification behavior.
- Changing connector instance/profile semantics.
- Changing remote-surface architecture.
- Adding webhook semantics.
- Making a design decision a reviewer should be able to audit later.

Design notes are for intake, not official commitments. If a design note becomes
implementation, promote it to an OpenSpec change.

Do not put session handoffs in OpenSpec unless they are tightly scoped design
notes for an active change. General handoffs belong in `docs/` or `tmp/`.

## 25. Current Active / Relevant OpenSpec Threads

Likely relevant changes include:

- `add-neko-browser-surface-leases`
- `add-dynamic-neko-surface-allocation`
- `extract-remote-surface-substrate`
- `extract-remote-surface-streaming-architecture`
- `make-remote-surface-oss-publishable`
- `complete-local-agent-collectors`
- `add-dashboard-web-push-notifications` if present or to create/update
- ChatGPT cursor/detail-gap/backoff note/change, if present
- Chase pending/posted transaction modeling note/change, if present

Before implementing any related durable behavior, inspect the actual change
folders and validate with:

```bash
openspec validate <change-name> --strict
```

## 26. Definition of Done for a Connector in Docker

A connector is done only when all applicable checks pass:

- It appears in the catalog only if intentionally visible.
- It declares and receives required runtime bindings.
- It runs from the Docker dashboard path.
- It uses the correct browser surface/profile/instance.
- Login/manual assistance works or fails with clear structured assistance.
- Fixtures are captured at meaningful boundaries.
- Records are inserted with correct stream/source/instance attribution.
- Artifacts such as PDFs, attachments, and exports are persisted and queryable.
- Known gaps are accurate, query-visible or timeline-visible, and actionable.
- State/cursor semantics are correct for partial success.
- Schedules/manual runs/webhooks do not conflict.
- A second run behaves sensibly: no duplicate flood, no skipped missing data, no
  wedged state.
- Tests cover parsers, login helpers, and any reusable runtime helpers.
- The final run outcome is honest.

## 27. Definition of Done for Remote Surface

The remote surface is done only when it satisfies the actual user journey, not
just tests.

Minimum acceptance:

- Desktop: click, type, scroll, copy, paste, cursor mapping.
- Android phone: tap, scroll, focus input, soft keyboard, type, backspace,
  enter/submit, copy/paste affordances if required.
- Rotation does not leave wrong scale, bars, or offset.
- Keyboard open/close does not resize the remote browser incorrectly.
- Stream fills the intended local frame without tiny content or huge borders.
- Pointer/touch mapping is correct after resize and rotation.
- Overlay/control buttons appear only where useful.
- No n.eko branding/chrome unless intentionally part of the surface.
- Telemetry can detect the classes of failure the owner actually sees.
- n.eko native behavior is preserved where it is better than custom code.
- CDP fallback remains available for debug/legacy but is not the primary
  human-input path for sensitive interactive flows.

If telemetry says "settled" while the user sees a wrong layout, telemetry is
wrong or incomplete.

## 28. UI and Dashboard Quality

The dashboard is part of the reference implementation. It should be clear,
honest, and polished.

Known or requested UI topics:

- Dark mode should apply properly to login pages.
- Sessions should not expire annoyingly often.
- Assistance messages should be precise and not contradictory.
- Mobile stream playground/control pages need to be mobile-friendly.
- Desktop should not show mobile-only keyboard/clipboard buttons.
- Mobile controls should be useful, not clutter.
- Copy/paste buttons should be disabled or hidden when not meaningful, when
  feasible.

Use existing design-system patterns and UI skills if doing substantial frontend
work. Do not introduce visually generic or inconsistent components.

## 29. Human Interaction Protocol

the owner is willing to help, but the system should minimize human burden.

Ask the owner for:

- OTP codes.
- App push approval.
- Installing/subscribing PWA push.
- Corroborating account data when the only source is private UI.
- Choosing between product tradeoffs when the code cannot determine intent.

Do not ask the owner for:

- Repeating a test you can automate or inspect.
- Retesting expected-broken states.
- Explaining logs that the system already captured.
- Manually telling you what fixtures, screenshots, telemetry, or DB records
  could show.

When asking the owner to test, be specific:

- URL.
- Expected visible behavior.
- What to click/type.
- What would count as success/failure.
- Whether you are already collecting telemetry.
- Whether sensitive input should be avoided.

## 30. Immediate Recommended Next Steps

The next owner should not start from scratch. Proceed in this order unless new
evidence changes priorities.

1. Commit this handoff if not already committed.
2. Inspect `run_1778852923848` gaps directly.
3. Fix Chase download artifact handling for QFX/PDF in Docker.
4. Fix Chase current-activity collection path so it captures the fresh pending
   and posted rows the owner sees, without losing export/download coverage.
5. Add or improve general assistance-boundary fixture capture.
6. Rebuild Docker reference and run Chase again.
7. Ask the owner for OTP only if needed.
8. Require either clean Chase success or a smaller, well-explained gap set.
9. In parallel via workers, inspect schedules, PWA push, and connector catalog
   status.
10. Resume ChatGPT rate-limit/detail-gap work after Chase is no longer
    consuming all attention.

## 31. Suggested Worker Packets

Use these as starting points for Claude Code or low-cost subagents.

### 31.1 Chase Gaps Worker

Task:

- Inspect `run_1778852923848` timeline, records, gaps, fixtures, and logs.
- Identify exact code paths for QFX, statement PDF, and current activity gaps.
- Do not edit files unless assigned.
- Return root-cause hypotheses ranked by confidence and the smallest durable
  fix plan.

Required output:

- Run outcome summary.
- Record counts by stream.
- Gap list with file/function references.
- Whether failures are runtime/download helper or connector-specific.
- Recommended patch set.

### 31.2 Download Artifact Worker

Task:

- Own Playwright download/artifact handling in `packages/polyfill-connectors`
  and/or `reference-implementation` helper code.
- Fix Docker `download.saveAs` / `ENOENT` class errors.
- Do not alter Chase selectors.
- Add targeted tests using mocked/download fixture surfaces if possible.

Acceptance:

- Existing connector tests pass.
- A live or simulated Docker path proves artifact directory exists through
  save completion.
- No index-only success when artifact was required and failed.

### 31.3 Current Activity Worker

Task:

- Own Chase current-activity parsing/navigation.
- Reconcile dashboard overview MDS rows with account activity page behavior.
- Support known A/B shapes if evidence exists.
- Use semantic/shadow-aware Playwright best practices.

Acceptance:

- Fixture parser tests for both known shapes.
- Live run captures current/pending transactions or emits precise selector gap
  with fixture.

### 31.4 Fixture Capture Worker

Task:

- Design and implement general assistance-boundary fixture capture.
- Ensure capture before wait, after response, and on failure.
- Redact sensitive values.
- Avoid connector-specific hard-coding except where needed to integrate.

Acceptance:

- Tests for capture emission around an interaction-required run.
- Chase OTP page or equivalent assistance page gets captured in a future run.

### 31.5 Scheduler Worker

Task:

- Prove or fix schedules in Docker.
- Inspect scheduler logs, DB state, webhooks, dedupe, and queued runs.
- Do not touch connectors unless scheduler proof requires a tiny fixture
  connector.

Acceptance:

- A schedule triggers a run in Docker.
- Duplicate webhook/schedule events dedupe correctly.
- Failed run does not wedge future schedule.

### 31.6 PWA Push Worker

Task:

- Inspect or create OpenSpec for dashboard web push.
- Implement minimum PWA push subscription and assistance-event notification if
  not complete.
- Keep ntfy compatibility.

Acceptance:

- Real phone can subscribe.
- Assistance event sends push.
- Tap opens correct run/stream.

### 31.7 Connector Catalog Audit Worker

Task:

- List all connectors in current server catalog.
- Categorize visible, hidden, stub, unproven, proven.
- Identify Docker blockers per connector.
- Do not fix everything. Produce ranked action list.

Acceptance:

- No unproven connector is presented as ready.
- High-value connectors have next fix steps.

## 32. Things Not to Do

Do not:

- Continue making remote-surface patches that fight n.eko without proving why
  n.eko native behavior is insufficient.
- Treat `succeeded_with_gaps` as good enough without gap analysis.
- Add connector-specific sleeps as a substitute for proper waits or backoff.
- Keep old broken browser surfaces alive after rebuilding images.
- Share browser profiles across connectors unless explicitly scoped as a
  temporary fallback.
- Ask the owner to keep submitting OTPs for runs expected to fail after OTP.
- Expose stub/unproven connectors in the catalog.
- Store or repeat OTP codes in docs, commits, logs, or comments.
- Declare schedule/PWA/webhook support done without live proof.

## 33. Current Mental Model for "Why Things Went Wrong"

The project repeatedly backslid when agents optimized for the next symptom
instead of the architecture.

Examples:

- Remote-surface telemetry measured frame dimensions but not user-visible
  content placement, so it missed the tiny-content problem.
- Touch/layout fixes accumulated until they fought n.eko instead of enhancing
  it.
- Fixture capture existed but did not capture the exact assistance states that
  would have made debugging fast.
- Chase had a real infrastructure issue (CDP websocket timeout) and a real
  selector issue (shadow OTP), and both needed to be separated.
- ChatGPT backoff/rate-limit behavior was discussed in terms of sleeps before
  the deeper cursor/detail semantics were fully resolved.

The correction is owner discipline:

- Separate infrastructure failures from connector failures.
- Separate UX symptoms from architecture boundaries.
- Preserve evidence.
- Use workers for legwork.
- Keep specs and code aligned.
- Prefer reusable runtime primitives when the same issue appears in multiple
  connectors.

## 34. Current "Done" Bar for the Near-Term Program

The near-term program is not complete until:

- Chase runs in Docker and either fully collects requested data or reports only
  well-understood, retryable, query-visible gaps.
- ChatGPT can survive realistic rate limits without false cursor advancement or
  false success.
- USAA has a proven Docker path or is clearly marked not ready.
- Gmail attachment completeness is proven for post-initial backfill.
- Schedules trigger reliably in Docker.
- PWA push can notify the owner's phone for assistance events.
- Connector catalog visibility matches proof status.
- Remote surface is stable enough for real manual action from desktop and
  phone.
- Multi-instance connector foundations are aligned with schedules, records,
  browser profiles, and UX.
- Claude/Codex local collectors have a clear path from inventory to complete
  collection.

## 35. Final Guidance to the Next Agent

Start by acting like the reference implementation owner, not a bug fixer.

The most valuable next move is probably to close the Chase loop because the
latest run proved login/OTP and exposed concrete downstream gaps. But do not let
Chase consume all attention. Schedule, PWA push, connector catalog honesty,
ChatGPT throttling, fixture capture, and multi-instance semantics are active
threads that must remain visible.

Use Claude workers. Batch their outputs. Review critically. Commit often.

When in doubt, ask:

- Is this the simplest path that preserves the truth?
- Does this make the next connector easier, or only this case pass?
- Can a future implementer understand the decision from OpenSpec/docs/tests?
- Would the owner be surprised by what this run status means?
- Can I prove this without asking the owner to be the telemetry system?

That is the standard.
