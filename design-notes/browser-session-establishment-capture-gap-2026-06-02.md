# Browser Session Establishment Capture Gap

Status: promoted
Owner: RI owner
Created: 2026-06-02
Updated: 2026-06-02
Related: `openspec/changes/add-browser-session-establishment-watchdog`, `packages/polyfill-connectors/src/connector-runtime.ts`, `packages/polyfill-connectors/src/browser-handoff.ts`, `packages/polyfill-connectors/src/auto-login/amazon.ts`

## Question

Should browser-backed connector runs capture intermediate auth/session-establishment
checkpoints, and should manual-action target preparation avoid unbounded page
metadata reads, so stuck runs produce useful diagnostics before operator handoff?

## Context

Amazon run `run_1780367394694` stayed active for more than 14 hours. The durable
timeline showed only browser-surface startup and `run.started`; it never reached
record emission, state emission, `runtime-session-established`, or terminal
events.

Fixture capture was enabled, but the committed fixture directory contained only
`runtime-new-page` (`about:blank`). That means capture was not disabled; the run
hung before the next runtime checkpoint. The richer Playwright trace existed only
under `/tmp/playwright-artifacts-B4SZvu` in the reference container. It showed
Amazon sign-in / claim navigation and then Amazon home, but not a clean orders
session.

Live CDP attach showed that `Page.getNavigationHistory` still responded while
`Page.getFrameTree`, `DOM.getDocument`, and `Runtime.evaluate` timed out. That is
consistent with a wedged page/renderer during session establishment.

One plausible code-level failure point is manual-action target preparation:
`readManualActionPageMetadata()` awaits `page.title()` with no local timeout
before the connector emits the `INTERACTION`. If the page is wedged, the owner
may never receive the manual-action prompt.

## Stakes

Without intermediate auth checkpoints, a stuck browser connector can leave the
owner with an active run and no actionable fixture. Without bounded metadata
reads and run-level watchdogs, a connector can wait forever before surfacing the
manual action that would have unblocked it.

## Current Leaning

The SLVP shape is:

- keep the existing raw trace capture, but make stalled-run trace artifacts easy
  to locate or preserve;
- add capture checkpoints inside session establishment around auth probe,
  automated login submit, challenge/manual-action decision, and pre-collection
  verification;
- bound optional metadata reads used for manual-action registration;
- fail closed for streaming metadata, but still emit the `INTERACTION`;
- add a run-level watchdog or owner cancel path so an active run cannot remain
  stuck indefinitely.

## Promotion Trigger

Promote to OpenSpec before changing the reference runtime contract for browser
capture checkpoints, manual-action registration behavior, active-run watchdogs,
or owner cancellation semantics.

## Decision Log

- 2026-06-02: Captured after debugging stuck Amazon run `run_1780367394694`.
- 2026-06-02: Promoted into `openspec/changes/add-browser-session-establishment-watchdog`; runtime watchdog/checkpoint changes merged in `e44c7fe4`.
