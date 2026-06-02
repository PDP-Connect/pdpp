# Design: add-browser-session-establishment-watchdog

## Problem statement

A browser-backed connector run wedged in `controller_active_runs` with five
durable spine events (browser surface requested/starting/leased/ready,
`run.started`) and nothing after. No progress, record, state, gap, attention,
or terminal event followed. Live CDP attach to the surface showed
`Page.getNavigationHistory` working while `Page.getFrameTree`,
`DOM.getDocument`, and `Runtime.evaluate` timed out — a wedged renderer during
session establishment.

In the connector runtime this maps to the window inside `runInBrowser`:

```
page = await ctx.newPage()
captureBrowserPage(... "runtime-new-page")     // ← last durable capture
await establishSession(...)                    // ← wedged here, forever
captureBrowserPage(... "runtime-session-established")  // ← never reached
```

`establishSession` calls the connector's `ensureSession` (Amazon's
`ensureAmazonSession`), which drives `page.goto`, `page.title`,
`page.waitForTimeout`, and `page.locator(...).innerText()`. Against a wedged
renderer, the CDP-backed calls that need a live render tree never resolve.
Individual Playwright navigations carry a 30 s timeout, but several call paths
(notably `page.title()` in the manual-action handoff, and any
`locator.innerText()` / `page.evaluate`) have no explicit timeout and can hang
indefinitely. Even where per-call timeouts exist, there is no overall deadline
on the establishment phase, so a connector that loops or stalls between bounded
calls can still sit active forever.

The `detect-midwait-browser-surface-loss` change is the adjacent defense, but it
is controller-side and only arms once an interaction is open. This run never
emitted an interaction, so that detector could not fire. This change adds the
connector-runtime-side defense for the establishment window.

## Approach

Three bounded primitives, smallest-safe-subset first. None of them changes the
controller, the spine event set, or any wire contract.

### 1. Bounded manual-action metadata read (`browser-handoff.ts`)

`readManualActionPageMetadata()` awaits `page.title()` with no local timeout.
If the page is wedged, the whole `manualAction` call never emits its INTERACTION
and the owner never sees a prompt — the exact "swallowed mystery" failure.

Change: race `page.title()` against a bounded deadline (`withDeadline`, default
2 s). `page.url()` stays synchronous and is read first, so even on a metadata
timeout the interaction still carries the URL. On timeout we emit a compact
stderr diagnostic (`[browser-handoff] page.title() timed out after Nms …`) and
proceed with the partial metadata. The interaction is always registered/emitted;
metadata is best-effort, never blocking.

`withDeadline(promise, ms, onTimeout?)` is a small generic helper:
`Promise.race` of the work against a timer that resolves to a sentinel. The
timer is `unref`-ed so it never keeps the process alive, and cleared when the
work wins. Exported for direct unit testing.

### 2. Session-establishment checkpoints (`connector-runtime.ts`)

The runtime already captures named checkpoints (`runtime-new-page`,
`runtime-session-established`, …) via `captureBrowserPage`. The gap is *inside*
`establishSession`: a multi-second to multi-minute auth flow with zero
checkpoints. When it hangs, the last durable artifact is `runtime-new-page` on
`about:blank`.

Change: introduce a `checkpoint(label)` function threaded into
`EnsureSessionArgs`. Calling it (a) records the label + monotonic timestamp as
the run's last-progress marker (the watchdog reads this), and (b) triggers a
best-effort diagnostic capture (`session-establish-<label>`) when capture is
active. The runtime emits framing checkpoints (`session-establish:begin`,
`session-establish:probe`) and the connector emits phase checkpoints. Capture
is best-effort and time-bounded by reusing `captureBrowserPage`'s existing
"page already closed → skip" guard plus the bounded-title fix; a checkpoint
SHALL NOT be able to hang the watchdog (see §3 — the watchdog's deadline is
independent of any single checkpoint's capture).

Generic vs connector-specific: the runtime owns the begin/probe framing
checkpoints. Phase checkpoints (sign-in loaded, email submit, password submit,
2FA decision, final verify) are connector-specific because only the connector
knows its auth state machine. Amazon is the first consumer; the hook is generic
so any browser connector can adopt it.

### 3. Session-establishment watchdog (`connector-runtime.ts`)

Wrap `establishSession` in a bounded watchdog. The watchdog is a deadline
relative to the **last checkpoint**, not a fixed wall-clock cap, so a connector
that is legitimately making auth progress (each phase checkpoints) is never
killed mid-flow, while a connector that stops checkpointing for longer than the
deadline is failed closed.

- Default deadline: `PDPP_SESSION_ESTABLISH_WATCHDOG_MS` (default 120000 ms,
  i.e. 2 min of no checkpoint progress). Successful prior Amazon runs completed
  the entire run in ~29–41 s, so 2 min of *no progress at all* is well clear of
  the legitimate envelope.
- An interaction wait (owner solving a CAPTCHA / entering OTP) can legitimately
  take many minutes. To avoid killing a run that is correctly blocked on the
  owner, the watchdog is **paused while an interaction is open** and resumed
  (deadline reset) when the interaction resolves. This is done by wrapping the
  `sendInteraction` used during establishment so each open interaction
  suspends the watchdog. A run blocked on the owner is making the intended kind
  of progress; a run blocked on a dead renderer with no interaction open is not.
- On expiry: set a one-shot tripped flag, finalize trace/capture diagnostics
  (the same `finalizeDiagnostics()` the SIGTERM path uses, so the operator gets
  a usable trace), then reject the establishment with a `TerminalError`
  (`<name>_session_establish_timeout`, retryable). The existing outer catch
  converts this to a terminal failed DONE; the existing `finally` releases the
  browser. The run therefore cannot remain in `controller_active_runs`.

The watchdog races the wrapped `establishSession` against the deadline; whichever
settles first wins. If establishment finishes first, the timer is cleared
(and `unref`-ed regardless). The connector child may still be stuck inside a
non-cancellable Playwright call after we reject — but the runtime has already
emitted its terminal DONE and released its handle, so the controller clears the
active run. Process-level teardown (the connector exiting) is handled by the
existing `flushAndExit`. Forcibly aborting a wedged in-flight CDP call from
JS is not possible without killing the process; emitting the terminal DONE and
letting `flushAndExit` run is the bounded, honest behavior.

### Bounded teardown capture

On a trip, the existing `runInBrowser` catch path captures a `runtime-error`
snapshot and the `finally` finalizes diagnostics + releases. That `runtime-error`
capture runs `captureBrowserPage` → `captureDom`, whose CDP-backed reads
(`page.content()`, `page.title()`, `page.ariaSnapshot()`) have no per-call
timeout and would re-hang teardown on the very wedged renderer that tripped the
watchdog. `captureBrowserPage` therefore bounds its DOM snapshot with
`withDeadline` (default 10 s, injectable for tests): on timeout it abandons the
snapshot and returns, so the terminal DONE and browser release are never blocked
by a diagnostic capture. The detached `captureDom` keeps running harmlessly;
its internals already swallow their own errors, so it never rejects.

## Why not extend the mid-wait detector instead

`detect-midwait-browser-surface-loss` is controller-side and probes the CDP HTTP
base during an *open interaction*. The wedge here happens with no interaction
open and is a renderer-level hang, not necessarily a surface-availability loss —
`Page.getNavigationHistory` still worked, so an HTTP/CDP-base probe might have
reported the surface as "up". The correct detector for "the connector made no
establishment progress" lives next to the connector's establishment code, keyed
on checkpoint progress, not on surface reachability. The two are complementary
layers.

## Alternatives considered

### Fixed wall-clock cap on establishment

Simpler, but either too short (kills legitimate slow first-time logins / owner
interaction waits) or too long (lets a fast-connector hang sit for the worst
case). Keying on last-checkpoint progress with an interaction pause gives a tight
bound on *stalls* without penalizing legitimate slow-but-progressing flows.

### Per-call timeouts on every Playwright call in every connector

Brittle and connector-by-connector. We still add the bounded metadata read
(the specific named suspect) but the watchdog is the connector-agnostic backstop
so we are not relying on every connector author remembering every timeout.

### Aborting the wedged CDP call

Playwright/CDP calls against a dead renderer are not JS-cancellable; the only
way to stop them is to kill the process. The watchdog instead unblocks the
*runtime's* control flow (emit terminal DONE, release handle, finalize
diagnostics) and lets `flushAndExit` tear the process down. This is the bounded,
observable outcome the lane requires.

## Acceptance checks

1. `readManualActionPageMetadata` (via `manualAction`/`prepareManualAction`)
   still emits/registers the interaction when `page.title()` never resolves; the
   emitted interaction carries the URL and a `registered` result; a timeout
   diagnostic is written to stderr.
2. A session-establishment flow whose `ensureSession` never checkpoints and never
   returns is failed closed by the watchdog: a terminal `failed` DONE with a
   `*_session_establish_timeout` error, diagnostics finalized, browser released.
3. A session-establishment flow that checkpoints steadily is NOT killed even when
   total time exceeds the deadline, as long as no single gap between checkpoints
   exceeds it.
4. The watchdog is paused while an interaction is open: a flow that blocks on a
   long owner interaction is not killed.
5. Amazon's `ensureAmazonSession` invokes the checkpoint hook at each auth phase
   (probe, sign-in loaded, email submit, password submit, 2FA decision,
   final verify), proven with a fake page/sendInteraction.
6. `pnpm --dir packages/polyfill-connectors run typecheck` passes.
7. `pnpm --dir packages/polyfill-connectors run check` passes.
8. `openspec validate add-browser-session-establishment-watchdog --strict` passes.

## What is NOT in scope

- The live wedged run, the live deployment, container restarts, or any live
  Amazon run. This change is code/spec/test only.
- Controller spine events or the controller-side mid-wait detector.
- Patchright/n.eko stealth posture, `packages/remote-surface`, Docker compose,
  deployment scripts.
- Forcibly aborting in-flight CDP calls (not possible without killing the
  process; out of scope by design).
- Re-prompting or retry policy after a watchdog trip (scheduler/policy concern).
