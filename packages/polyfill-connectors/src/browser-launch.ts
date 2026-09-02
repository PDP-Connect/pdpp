// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-launch primitive for polyfill connectors.
 *
 * Launches a per-connector patchright Chromium with an isolated profile
 * directory. Used by the connector runtime (`connector-runtime.ts`) and by
 * operator-side scripts under `bin/` that need a Chromium context.
 *
 * Profile directories live under `~/.pdpp/profiles/<profileName>/` by default,
 * or under the deployment-owned `PDPP_BROWSER_PROFILE_ROOT` when configured.
 * Each profile is independent: cookies, localStorage, and "trusted device" state
 * persist across runs of the same connector but never cross between
 * connectors. Concurrent runs across different `profileName`s are safe.
 *
 * Patchright is the patched-Playwright drop-in (replaces rebrowser-playwright
 * 2026-04-21). Importing patchright in the launching module activates the
 * full stealth stack (launch-side + client-side); using stock playwright over
 * CDP would forfeit the client-side layer.
 *
 * Container policy: Core owns the browser mode for local sessions. Its
 * browser-bearing image advertises `PDPP_RUNTIME_BROWSER=1` and its supervisor
 * supplies a managed Xvfb `DISPLAY`, so the normal local launch is a visible
 * headed Chromium even though the service has no physical desktop. Other
 * containers still fail closed unless they provide the existing escape hatch
 * or attach to an operator-visible remote CDP browser such as n.eko.
 */

import { existsSync, mkdirSync } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, chromium } from "playwright";
import { removeChromiumSingletonResidue, withProfileLockMutex } from "./profile-lock.ts";
import { isRunningInContainer } from "./runtime-environment.ts";

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXTRA_BROWSER_ARGS_RE = /\s+/;
export const BROWSER_HEADLESS_ENV = "PDPP_BROWSER_HEADLESS";
/**
 * Env-var channel for `bin/scenario-record.ts` to request HAR recording
 * from INSIDE the connector subprocess it spawns — mirrors
 * `subprocess-fetch-preloads.ts`'s `PDPP_SCENARIO_CLOCK_FIXED_NOW_ENV`
 * exactly: the recorder CLI and the connector's own browser-acquisition
 * call happen in different OS processes (`spawn(process.execPath, ...)`),
 * so a function argument can't cross that boundary — `process.env` (set on
 * the child's `env` at spawn time) is the only channel available. Resolved
 * in `acquireBrowserForConnector` (the entry point every browser-driven
 * connector's subprocess actually calls — see `connector-runtime.ts`'s
 * `acquireBrowser`), not in every individual connector, so no connector
 * needs to know this capability exists.
 */
export const HAR_RECORD_PATH_ENV = "PDPP_SCENARIO_HAR_RECORD_PATH";
/**
 * Env-var channel for `bin/scenario-record.ts` to request a `storageState()`
 * snapshot alongside the HAR — see `storageStateRecording`'s doc comment.
 * Same subprocess-boundary rationale as `HAR_RECORD_PATH_ENV`.
 */
export const STORAGE_STATE_RECORD_PATH_ENV = "PDPP_SCENARIO_STORAGE_STATE_RECORD_PATH";
// The two halves of the transient remote-CDP-attach race signature. See
// `isCdpAttachSessionRaceError` for the full root-cause explanation.
const CDP_ATTACH_RACE_METHOD_RE = /Network\.setCacheDisabled/;
const CDP_ATTACH_RACE_SESSION_CLOSED_RE = /session closed/i;

export interface IsolatedBrowser {
  browser: Browser | null;
  context: BrowserContext;
  /**
   * Present only when this context was launched with `harRecording` set
   * (see `AcquireIsolatedBrowserOptions.harRecording`). MUST be called
   * AFTER `release()` resolves — Playwright only flushes the HAR to disk
   * during context close, so calling this before `release()` would race
   * the flush and could report `flushed: false` for a capture that was
   * about to succeed. Absent entirely when `harRecording` was not
   * requested, so a caller that never asked for a HAR has no way to
   * mistakenly read a stale/undefined outcome as a real one.
   */
  harRecordingOutcome?: () => Promise<HarRecordingOutcome>;
  release: () => Promise<void>;
  /**
   * Present only when this context was launched with `storageStateRecording`
   * set. Same MUST-call-after-`release()` ordering rule as
   * `harRecordingOutcome` — `storageState()` itself is called from inside
   * `release()`, before `context.close()`, since Playwright cannot read
   * storage state from an already-closed context.
   */
  storageStateRecordingOutcome?: () => Promise<StorageStateRecordingOutcome>;
}

export interface AcquireIsolatedBrowserOptions {
  /**
   * Opt-in network-level HAR (HTTP Archive) capture for this browser
   * context — the RECORD half of the connector-verification scenario
   * harness's browser driver (see `bin/scenario-record.ts`'s
   * `--record-har` flag). OFF by default and zero-cost when omitted: no
   * `recordHar` option is added to `baseLaunchOptions`, so an ordinary
   * connector run's launch options are byte-identical to before this field
   * existed.
   *
   * When set, `path` becomes Playwright's `recordHar.path` — passed through
   * `baseLaunchOptions` at BOTH `launchPersistentContext` call sites (the
   * explicit-channel branch and the default-channel branch), so this option
   * covers every local-launch path the same way `streamingEnabled` does.
   * Does NOT apply to `acquireRemoteCdpBrowser` (n.eko-attached contexts):
   * `connectOverCDP` attaches to an ALREADY-launched remote context, so
   * there is no `launchPersistentContext` call to carry `recordHar` on that
   * path — recording a remote-CDP session's traffic is out of scope here.
   *
   * `content: "embed"` (inline base64/text in the HAR JSON, chosen over
   * Playwright's zip-friendly `"attach"`) is a deliberate choice: the
   * scenario-verify replay half needs a HAR whose response bodies are
   * actually present to route requests from (`context.routeFromHAR`) —
   * `"omit"` would produce a HAR that satisfies nothing downstream. A
   * single embedded JSON file is also the easiest shape for this module's
   * own post-close redaction pass (see `redactHarFile`) to reason about:
   * one file, one parse, no companion resource directory to also scrub.
   * The cost is size and secret exposure inside `content.text` — mitigated
   * by `redactHarFile` stripping `Set-Cookie`/`Authorization`/etc. headers
   * (see that function's doc comment for exactly what it does and does NOT
   * redact) but NOT by touching response bodies, which are handed to
   * `redactHarFile`'s caller un-inspected — see this option's own doc
   * comment continuation below on residual exposure.
   *
   * RESIDUAL EXPOSURE: response/request BODIES are embedded verbatim.
   * Unlike the existing fetch-preload's structured per-field JSON body
   * capture (which this harness never applies to HAR — a HAR entry's body
   * is an opaque blob with unknown shape per provider), this driver cannot
   * safely redact arbitrary body content field-by-field. A HAR captured
   * this way is `capture.privacy_class: "local-only"` territory, same as
   * every other scenario artifact this package's recorders produce — never
   * committed or shared without a scrub pass, exactly like
   * `bin/scenario-record.ts`'s existing capture output.
   *
   * Known gap, verified unexercised as of this change: `recordHar` does
   * NOT capture WebSocket frames, and a page's native download flow can
   * bypass HAR capture entirely. Checked against the connector fleet
   * (2026-08-21): zero of the 45 connectors use WebSocket/EventSource/SSE,
   * and none drive a browser download. Both gaps are real limitations of
   * this driver, left unaddressed because nothing currently exercises them
   * — not because they were solved.
   */
  harRecording?: { path: string };
  headless?: boolean;
  /**
   * Skip remote-CDP page-target cleanup before attach. Use only when the
   * connector intentionally preserves successful pages because the page itself
   * carries source auth state.
   */
  preserveRemotePagesOnAcquire?: boolean;
  profileName: string;
  /**
   * When set, the launcher does NOT spawn its own Chromium. Instead it
   * calls `patchright.chromium.connectOverCDP(remoteCdpUrl)` and returns
   * the FIRST existing context as the connector's context. Used for
   * connectors that need a real X server + WebRTC streaming (n.eko-hosted
   * Chromium) so the manual_action handoff goes back to the same browser
   * the connector was driving — not a separate headless Chrome launched
   * inside the reference container.
   *
   * The release function disconnects the Patchright client; it does NOT
   * close the remote browser. The neko container owns that lifecycle.
   *
   * When set, `streamingEnabled` is implied; we register the page-target
   * wsUrl for manual_action via the standard browser-handoff helper, but
   * the wsUrl points at the neko-hosted page through the cdp-proxy.py
   * URL the streaming companion already knows how to attach to.
   */
  remoteCdpUrl?: string;
  /**
   * Opt-in capture of this context's `storageState()` (cookies +
   * localStorage/origins) at release time, WRITTEN TO ITS OWN FILE — never
   * embedded in the HAR. Companion to `harRecording`, addressing a gap a
   * HAR alone cannot close: `launchPersistentContext` reuses a WARM
   * profile with existing session cookies, so replaying the HAR's captured
   * requests against a fresh/anonymous context hits the provider's own
   * login wall in the replaying page's JS and never reaches the recorded
   * request shapes at all. Recording the session alongside the HAR lets the
   * REPLAY half (owned elsewhere — see `bin/scenario-record.ts`'s
   * `--record-har` doc comment) seed a matching starting session.
   *
   * DELIBERATELY UNREDACTED, and this is a stated decision, not an
   * oversight: `storageState()`'s cookies ARE the live session — the value
   * of the session cookie is the credential that keeps the replaying page
   * logged in. Blanking it the way `harRecording`'s redaction pass blanks
   * HAR headers/cookies would produce a file that LOOKS like a safety
   * measure but actually just breaks the one thing this capture exists to
   * provide, without removing any real risk (the HAR's own cookie headers
   * are already redacted independently; this file is the one place a real,
   * usable session snapshot must exist for replay to be possible at all).
   * Treat a written storageState file as carrying live, unredacted
   * credentials — AT LEAST as sensitive as the raw scenario capture's
   * `capture.privacy_class: "local-only"` bodies, arguably more so (a
   * session cookie is immediately, directly usable by anyone who reads it;
   * a HAR body needs the specific provider context to be useful). Callers
   * MUST NOT commit, share, or embed this file's contents anywhere a HAR
   * or scenario JSON might otherwise be shared after a scrub pass — there
   * is no scrub pass that makes a live session cookie safe to publish.
   */
  storageStateRecording?: { path: string };
  /**
   * When true, the launcher launches Chromium in CDP-port mode
   * (`--remote-debugging-port=0` plus `--remote-debugging-address=127.0.0.1`), reads
   * the resolved random port out of `<userDataDir>/DevToolsActivePort`,
   * and publishes `PDPP_BROWSER_CDP_HOST` / `PDPP_BROWSER_CDP_PORT` to
   * `process.env` for the browser-binding-local handoff helper
   * (`browser-handoff.ts`) to compose per-interaction wsUrls at
   * `manual_action` emission time.
   *
   * The launcher itself does NOT register any streaming target — that
   * is interaction-scoped and owned by the binding code that emits the
   * manual_action. See
   * `openspec/changes/add-run-interaction-streaming-companion/`
   * `design-notes/interaction-scoped-target-resolution-2026-05-05.md`.
   *
   * Best-effort port publication: any failure (port not appearing in
   * `DevToolsActivePort`, etc.) logs a warning and lets the browser
   * launch succeed. The honest failure mode is "streaming unavailable
   * for this run; records still flow."
   *
   * Connectors that never need streaming MUST be unaffected — leave
   * this `false` or omit it.
   */
  streamingEnabled?: boolean;
}

/**
 * Mirrors `HarRecordingOutcome` for the storageState side — see
 * `storageStateRecording`'s doc comment for why this file is intentionally
 * unredacted and must be handled as live credentials, not a shareable
 * artifact.
 */
export interface StorageStateRecordingOutcome {
  flushed: boolean;
  path: string;
}

/**
 * Per-context-close, best-effort record of whether a requested HAR capture
 * actually reached disk. `acquireIsolatedBrowser`'s caller (via the
 * `harRecording` option) gets this back from `release()`'s resolved value
 * rather than from `IsolatedBrowser` itself, so every existing `release():
 * Promise<void>` caller keeps compiling unchanged — this is a strictly
 * additive read path, not a signature change to the widely-used
 * `IsolatedBrowser` interface.
 */
export interface HarRecordingOutcome {
  /**
   * True only when `context.close()` completed AND the HAR file was found
   * on disk afterward with nonzero size. A `false` here after a requested
   * `harRecording` option means exactly what it says: no trustworthy HAR
   * exists at `path` — a crash, a SIGKILL (e.g. `bin/scenario-record.ts`'s
   * inactivity watchdog), or any other non-graceful teardown before
   * `context.close()` runs leaves NO har file at all (Playwright buffers
   * HAR content in memory and only flushes it during context close — see
   * playwright-core's `HarRecorder.flush()`), never a silently truncated
   * one. Callers MUST check this before treating `path` as a real artifact
   * — never assume success just because `harRecording` was requested.
   */
  flushed: boolean;
  /** Absolute path the HAR was requested at (echoes `harRecording.path`). */
  path: string;
}

/**
 * Stable error code surfaced when a HEADED browser-backed connector is
 * attempted in a container/provider runtime that cannot show a visible
 * browser. The dashboard renders this as a deployment-config error
 * state pointing the operator at the local collector runner.
 */
export const HEADED_BROWSER_UNAVAILABLE_CODE = "headed_browser_unavailable";

/**
 * Failure surfaced when a HEADED browser-backed connector is requested
 * inside a container without a local collector runtime that can render
 * the browser. Carries a stable `code` so the dashboard can render the
 * actionable deployment-config error state.
 */
export class HeadedBrowserUnavailableError extends Error {
  readonly code: typeof HEADED_BROWSER_UNAVAILABLE_CODE;

  constructor(args: { message: string }) {
    super(args.message);
    this.name = "HeadedBrowserUnavailableError";
    this.code = HEADED_BROWSER_UNAVAILABLE_CODE;
  }
}

/**
 * Pure decision helper for the in-container fail-closed gate. Exported
 * so tests can exercise the policy without launching Patchright (the
 * acquire path itself is hard to test without spinning up a real
 * browser).
 *
 * Headed-vs-headless interpretation MUST mirror the effective mode resolved by
 * `acquireBrowserForConnector`, which applies the deployment override when a
 * caller omits `headless`. The baseline is headed, so:
 *
 *   - `headless: true`  → headless (allowed in container)
 *   - `headless: false` → headed   (container gate requires managed display or escape hatch)
 *   - `headless: undefined` (caller omitted the field) → the deployment
 *     choice (`PDPP_BROWSER_HEADLESS=1` means headless; otherwise headed).
 *     A connector's browser config never supplies this field.
 *
 * Returns:
 *   - `{ kind: "fail_closed" }` when the effective request is HEADED,
 *     the runtime is in a container, and the escape hatch is not
 *     asserted. Caller MUST throw `HeadedBrowserUnavailableError`.
 *   - `{ kind: "warn_and_proceed" }` when the same conditions hold
 *     except `PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1` is asserted.
 *     Caller SHOULD emit a per-acquisition stderr warning and proceed.
 *   - `{ kind: "proceed" }` otherwise.
 */
export type ContainerHeadedBrowserGate =
  | { readonly kind: "fail_closed" }
  | { readonly kind: "warn_and_proceed" }
  | { readonly kind: "proceed" };

export interface ContainerHeadedBrowserGateInputs {
  readonly escapeHatchEnabled: boolean;
  readonly headless: boolean | undefined;
  readonly inContainer: boolean;
  /**
   * Core's startup supervisor has installed the image-owned browser runtime
   * and waited for its managed Xvfb display. Omitted/false preserves the
   * fail-closed behavior for unrelated container runtimes.
   */
  readonly managedDisplayAvailable?: boolean;
  /**
   * When set, the launcher will NOT spawn a local headed Chromium — it
   * will attach to a remote CDP endpoint (e.g. a n.eko browser surface) which
   * already renders the browser visibly for the operator. In that case
   * the in-container fail-closed gate does not apply: there is no
   * invisible headed browser to fail closed against. Local headed
   * container launches (no remoteCdpUrl) still fail closed as before.
   */
  readonly remoteCdpUrl?: string;
}

/**
 * Resolve the deployment-owned local browser mode. Connector manifests do not
 * call this with an explicit value; the explicit argument remains available to
 * operator-side low-level callers as the existing headless escape hatch.
 */
export function resolveDeploymentBrowserHeadless(
  headless: boolean | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  return headless ?? env[BROWSER_HEADLESS_ENV]?.trim() === "1";
}

/**
 * Baseline used by the pure gate when a test or policy caller supplies no
 * deployment environment. The production wrapper resolves the environment
 * before it calls the gate.
 */
const ACQUIRE_ISOLATED_BROWSER_HEADLESS_DEFAULT = false;

export function decideContainerHeadedBrowserGate(inputs: ContainerHeadedBrowserGateInputs): ContainerHeadedBrowserGate {
  const effectiveHeadless = inputs.headless ?? ACQUIRE_ISOLATED_BROWSER_HEADLESS_DEFAULT;
  const headedRequested = effectiveHeadless === false;
  if (!(headedRequested && inputs.inContainer)) {
    return { kind: "proceed" };
  }
  // Remote-CDP attach bypasses the gate: the visible browser is owned by a
  // separate operator-visible surface (e.g. n.eko) and the operator can see it
  // via the streaming companion. There is no invisible headed Chromium in the
  // reference container to fail closed against.
  if (inputs.remoteCdpUrl && inputs.remoteCdpUrl.length > 0) {
    return { kind: "proceed" };
  }
  if (inputs.managedDisplayAvailable) {
    return { kind: "proceed" };
  }
  if (inputs.escapeHatchEnabled) {
    return { kind: "warn_and_proceed" };
  }
  return { kind: "fail_closed" };
}

/**
 * Stable error thrown by `failFastOnUnusableViewport` when a HEADED launch's
 * initial page reports a definitively-zero viewport — the observable
 * fingerprint of a display that is set but unusable (Chromium's GPU/
 * compositor init failed silently, so the launch API still returns a live
 * page, but it can never lay out content). Distinct from
 * `HeadedBrowserUnavailableError` (which fires BEFORE any launch attempt,
 * for the container policy gate) — this fires AFTER a launch that
 * "succeeded" by Playwright's own bookkeeping but is unusable in practice.
 */
export const UNUSABLE_VIEWPORT_CODE = "browser_viewport_unusable";

export class UnusableViewportError extends Error {
  readonly code: typeof UNUSABLE_VIEWPORT_CODE;

  constructor(args: { message: string }) {
    super(args.message);
    this.name = "UnusableViewportError";
    this.code = UNUSABLE_VIEWPORT_CODE;
  }
}

/**
 * Pure predicate: does this viewport reading indicate a definitively-zero
 * (unusable) display? Exported so the decision can be unit-tested without a
 * real Chromium — `failFastOnUnusableViewport` is not itself practical to
 * exercise headless-in-CI (a real headless launch has a real, non-zero
 * viewport by construction; reproducing a broken-display headed launch
 * needs an actual misconfigured X server).
 *
 * Deliberately conservative: only `0` (not merely small, not undefined/NaN)
 * on BOTH dimensions counts as unusable. `viewportSize()` returning `null`
 * alone is not enough — `viewport: null` (this launcher's own baseline
 * option, matching the window's native size) is Playwright's DOCUMENTED
 * normal behavior for using the OS window size instead of an emulated one,
 * so a null `viewportSize()` is the common case for a perfectly healthy
 * headed launch and must never trip this check by itself. A real broken
 * display must show up as an actual zero measurement from the page itself
 * (`window.innerWidth`/`innerHeight`), not merely the absence of an
 * explicit emulated viewport size.
 */
export function isDefinitivelyZeroViewport(measurement: {
  innerHeight: number | undefined;
  innerWidth: number | undefined;
}): boolean {
  return measurement.innerWidth === 0 && measurement.innerHeight === 0;
}

const UNUSABLE_VIEWPORT_MESSAGE =
  "Browser launched but its viewport measures 0x0 - no usable display (DISPLAY is set but the window " +
  "never laid out; common when Chromium's GPU/compositor init silently fails, e.g. tmux with an empty " +
  "XAUTHORITY). Remedies: set PDPP_BROWSER_HEADLESS=1, or fix XAUTHORITY for this display.";

/**
 * Checks the just-launched initial page's real viewport and throws
 * `UnusableViewportError` if it is definitively zero (see
 * `isDefinitivelyZeroViewport`), instead of letting the caller proceed into
 * a run that can never succeed. Best-effort on the measurement itself: if
 * `window.innerWidth`/`innerHeight` cannot be read at all (page not ready,
 * evaluate throws), this does NOT fail the launch — an unreadable
 * measurement is not evidence of a broken display, and a normal
 * headless/headed launch must be unaffected by this check.
 */
async function failFastOnUnusableViewport(page: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<void> {
  let measurement: { innerHeight: number | undefined; innerWidth: number | undefined };
  try {
    measurement = await page.evaluate(() => {
      const browserWindow = (globalThis as { window?: { innerWidth?: number; innerHeight?: number } }).window;
      return { innerWidth: browserWindow?.innerWidth, innerHeight: browserWindow?.innerHeight };
    });
  } catch {
    return; // unreadable is not evidence of unusable — never block a launch on this alone.
  }
  if (isDefinitivelyZeroViewport(measurement)) {
    throw new UnusableViewportError({ message: UNUSABLE_VIEWPORT_MESSAGE });
  }
}

export function configuredBrowserChannel(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.PDPP_BROWSER_CHANNEL;
  if (raw === undefined) {
    return;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Recognise the transient CDP-attach race that fails `connectOverCDP`
 * against a live n.eko Chromium with:
 *
 *   Protocol error (Network.setCacheDisabled): Internal server error, session closed.
 *       at ... crNetworkManager.setRequestInterception
 *
 * Root cause (verified against patchright-core 1.61.1 internals):
 * Patchright's `CRPage` constructor eagerly calls
 * `this._networkManager.setRequestInterception(true)` so its stealth
 * Fetch-domain hooks are always active (`server/chromium/crPage.js` line 80).
 * Stock Playwright does NOT — it defers to a conditional
 * `updateRequestInterception()`. Critically, that constructor call is FLOATED:
 * no `await`, no `.catch`. Patchright's `setRequestInterception` ends with a
 * patchright-only
 * `_forEachSession(info => info.session.send("Network.setCacheDisabled", …))`
 * (`server/chromium/crNetworkManager.js`). When `connectOverCDP` auto-attaches
 * (`Target.setAutoAttach`) to every existing target, `_onAttachedToTarget`
 * builds a `CRPage` per target — including the short-lived `about:blank` target
 * n.eko opens via `/json/new?about:blank` and immediately tears down via
 * `/json/close`. If that target's session disposes while the send is in flight,
 * the in-flight callback is rejected with `Internal server error, session
 * closed.` (`crConnection.js` `dispose()`). The MAIN-frame branch of
 * `_forEachSession` has no `.catch` guard (only non-main sessions swallow
 * `isSessionClosedError`).
 *
 * Because the offending `setRequestInterception(true)` is floated and
 * `connectOverCDP` only awaits `_waitForAllPagesToBeInitialized()` (NOT the
 * interception promise), `connectOverCDP` RESOLVES successfully and the
 * rejection escapes the entire connect promise chain as a Node UNHANDLED
 * REJECTION (`node:internal/process/promises`), terminating the process a tick
 * or two after attach. This is why a `try/catch` around `connectOverCDP` (v1)
 * never observed it. The catch boundary now lives in
 * `runCdpAttemptWithRaceGuard`, which intercepts the unhandled rejection.
 *
 * The condition is inherently transient: the offending target is on its way
 * out. A bounded retry a moment later — once n.eko's transient target has
 * disposed and only the stable page target remains — attaches cleanly.
 *
 * We deliberately do NOT switch the remote-attach client to stock Playwright:
 * patchright's `Runtime.enable` suppression and isolated-world hiding are
 * CLIENT-driven stealth (sent over CDP by the driving process, not baked into
 * the launched browser). A stock client attaching to the same browser would
 * leak the canonical CDP `Runtime.enable` automation signal on every page —
 * a permanent stealth regression on a bot-hostile target like Amazon, traded
 * for a transient startup race. Retry keeps full patchright stealth.
 *
 * Matched narrowly on the CDP method + the session-closed phrase so unrelated
 * protocol errors (auth, bad URL, real crash) still fail fast.
 */
export function isCdpAttachSessionRaceError(err: unknown): boolean {
  let message = "";
  if (err instanceof Error) {
    ({ message } = err);
  } else if (typeof err === "string") {
    message = err;
  }
  if (!message) {
    return false;
  }
  return CDP_ATTACH_RACE_METHOD_RE.test(message) && CDP_ATTACH_RACE_SESSION_CLOSED_RE.test(message);
}

/**
 * Stable, machine-actionable code carried on the error thrown by
 * `connectOverCdpWithRetry` when it exhausts every bounded attempt of the
 * narrow attach-session race (`isCdpAttachSessionRaceError`). This is the
 * ONLY source boundary that knows the retry budget was exhausted for THIS
 * specific race — not a rate limit, not a credential failure, not a real
 * browser crash. Downstream layers (the connector runtime's terminal error,
 * the reference runtime's connector_error.code, the managed-surface
 * lifecycle) MUST key off this typed code and MUST NOT re-derive the same
 * disposition by re-parsing error message text.
 */
export const CDP_ATTACH_SESSION_RACE_EXHAUSTED_CODE = "browser_surface_attach_exhausted";

/**
 * Error subclass thrown when `connectOverCdpWithRetry` gives up after
 * exhausting `maxAttempts` on the narrow attach-session race. Carries the
 * stable `code` so callers can pattern-match on a typed property instead of
 * the underlying race error's message text (which remains available via
 * `cause` for logs/diagnostics only).
 */
export class CdpAttachSessionRaceExhaustedError extends Error {
  readonly code: typeof CDP_ATTACH_SESSION_RACE_EXHAUSTED_CODE;

  constructor(lastError: unknown) {
    const lastMessage = lastError instanceof Error ? lastError.message : String(lastError);
    super(`remote CDP attach exhausted its retry budget on the attach-session race: ${lastMessage}`, {
      cause: lastError,
    });
    this.name = "CdpAttachSessionRaceExhaustedError";
    this.code = CDP_ATTACH_SESSION_RACE_EXHAUSTED_CODE;
  }
}

const REMOTE_CDP_ATTACH_MAX_ATTEMPTS = 4;
const REMOTE_CDP_ATTACH_RETRY_DELAY_MS = 500;
// After `connectOverCDP` resolves, the floated `setRequestInterception(true)`
// rejection (see `runCdpAttemptWithRaceGuard`) lands on a LATER macrotask tick.
// We hold the scoped unhandled-rejection guard open for this settle window so a
// just-after race rejection still converts the attempt into a retry instead of
// crashing the process. 250ms comfortably covers the observed ~tens-of-ms gap
// without meaningfully slowing a clean attach.
const REMOTE_CDP_ATTACH_SETTLE_MS = 250;

/**
 * Minimal port of the `process` unhandled-rejection surface the attempt guard
 * needs. Injected so the guard can be unit-tested without touching the real
 * process listeners (the test drives a fake emitter directly).
 */
export interface UnhandledRejectionHost {
  off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
  on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
}

/**
 * Run ONE remote-CDP attach attempt with a scoped `unhandledRejection` guard.
 *
 * Why this exists (root cause v2): the production failure is NOT the
 * `connectOverCDP` promise rejecting. `connectOverCDP` RESOLVES — it returns a
 * live `Browser`. Patchright's `CRPage` constructor then fires
 * `this._networkManager.setRequestInterception(true)` with NO `await` and NO
 * `.catch` (`server/chromium/crPage.js`). That floated promise runs
 * `_forEachSession(… "Network.setCacheDisabled" …)`, whose MAIN-frame branch has
 * no session-closed guard. When n.eko's transient `about:blank` target disposes
 * mid-send, the floated promise rejects, and because nobody is awaiting it the
 * rejection escapes the entire `connectOverCDP` promise chain as a Node
 * UNHANDLED REJECTION (`node:internal/process/promises`), terminating the
 * process. A `try/catch` around `connectOverCDP` (v1) can never see it.
 *
 * The fix installs a temporary `process.on("unhandledRejection")` listener and
 * races the attach attempt against that signal. If the race lands while
 * `connect()` is still pending, the attempt rejects immediately instead of
 * waiting for Patchright's 30s timeout. If `connect()` resolves first, the
 * guard stays open for a short settle window because the floated rejection can
 * land on a later tick. Either way, a matching unhandled rejection becomes a
 * retryable rejection of this attempt; the caller's bounded retry then
 * re-attaches once n.eko's transient target is gone.
 *
 * Safety rails:
 *   - The listener is ALWAYS removed when the attempt settles (success,
 *     retryable race, or fail-fast), via the `finally` block. We never leave a
 *     global listener installed across attempts.
 *   - Only the narrow race signature is consumed. Any OTHER unhandled rejection
 *     is re-thrown synchronously from the listener after removing ourselves, so
 *     Node's default crash-on-unhandled-rejection behavior is preserved for
 *     unrelated bugs. We do not become a process-wide rejection sink.
 *   - If the race rejection arrives after `connect()` already returned a live
 *     browser, or `connect()` resolves after the guard has already rejected,
 *     the injected `disconnect` is invoked best-effort so we don't leak a CDP
 *     client.
 *
 * `host`, `setTimeoutFn`, and `clearTimeoutFn` are injected for tests.
 */
export async function runCdpAttemptWithRaceGuard<TBrowser>({
  connect,
  disconnect,
  settleMs = REMOTE_CDP_ATTACH_SETTLE_MS,
  host = process,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: {
  connect: () => Promise<TBrowser>;
  disconnect?: (browser: TBrowser) => Promise<void> | void;
  settleMs?: number;
  host?: UnhandledRejectionHost;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): Promise<TBrowser> {
  let raceReason: unknown;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  // Resolves as soon as a race rejection is observed, so we can abandon the
  // settle window early and retry without waiting out the full delay.
  let signalRace: (() => void) | undefined;
  const raceObserved = new Promise<void>((resolve) => {
    signalRace = resolve;
  });

  const onUnhandledRejection = (reason: unknown): void => {
    if (isCdpAttachSessionRaceError(reason)) {
      raceReason = reason;
      signalRace?.();
      return;
    }
    // Not our race. Stop intercepting and re-throw so Node's default
    // unhandled-rejection handling (process crash) still applies to unrelated
    // failures. We must never silently swallow another subsystem's rejection.
    host.off("unhandledRejection", onUnhandledRejection);
    throw reason;
  };

  host.on("unhandledRejection", onUnhandledRejection);
  try {
    let connectSettled = false;
    const connectPromise = connect().then(
      (connectedBrowser) => {
        connectSettled = true;
        return connectedBrowser;
      },
      (err: unknown) => {
        connectSettled = true;
        throw err;
      }
    );
    const disconnectLateBrowser = async (lateBrowser: TBrowser): Promise<void> => {
      if (!disconnect) {
        return;
      }
      await Promise.resolve(disconnect(lateBrowser)).catch(() => undefined);
    };
    const browser = await Promise.race([
      connectPromise,
      raceObserved.then(() => {
        // The race can happen while Patchright is still inside connectOverCDP.
        // Do not wait for its 30s timeout; convert this attempt into the
        // retryable race immediately. If connect later yields a Browser, close
        // that orphaned CDP client best-effort.
        if (!connectSettled) {
          // biome-ignore lint/suspicious/noNestedPromises: deliberately fire-and-forget — this must not block converting the current attempt into the retryable race
          connectPromise.then(disconnectLateBrowser, () => undefined).catch(() => undefined);
        }
        throw raceReason;
      }),
    ]);
    // `connect` resolved, but the floated `setRequestInterception` rejection
    // (if any) lands on a LATER tick. Hold the guard open for a brief settle
    // window; bail early the moment a race rejection is observed.
    await Promise.race([
      raceObserved,
      new Promise<void>((resolve) => {
        settleTimer = setTimeoutFn(resolve, settleMs);
      }),
    ]);
    if (raceReason !== undefined) {
      // The just-connected browser is orphaned by the race; disconnect it
      // best-effort so we don't leak a CDP client before the caller retries.
      await disconnectLateBrowser(browser);
      throw raceReason;
    }
    return browser;
  } finally {
    if (settleTimer !== undefined) {
      clearTimeoutFn(settleTimer);
    }
    host.off("unhandledRejection", onUnhandledRejection);
  }
}

/**
 * Attach to a remote Chromium with a bounded retry around the transient
 * `connectOverCDP` session-closed race (see `isCdpAttachSessionRaceError`).
 *
 * Each attempt runs inside `runCdpAttemptWithRaceGuard` so the failure can be
 * caught whether it surfaces as a rejected `connect` promise OR as a Node
 * unhandled rejection from patchright's floated `setRequestInterception(true)`
 * (the v2 root cause — v1 only handled the former). Only the race error is
 * retried; every other failure (auth, unreachable endpoint, real browser crash)
 * is rethrown immediately so we never mask a genuine attach failure behind a
 * retry budget.
 *
 * `connect`, `disconnect`, `sleep`, and `runAttempt` are injected so the retry
 * policy can be unit-tested without a live browser.
 */
export async function connectOverCdpWithRetry<TBrowser>({
  connect,
  disconnect,
  profileName,
  redactedUrl,
  maxAttempts = REMOTE_CDP_ATTACH_MAX_ATTEMPTS,
  retryDelayMs = REMOTE_CDP_ATTACH_RETRY_DELAY_MS,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  runAttempt = runCdpAttemptWithRaceGuard,
}: {
  connect: () => Promise<TBrowser>;
  disconnect?: (browser: TBrowser) => Promise<void> | void;
  profileName: string;
  redactedUrl: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  runAttempt?: typeof runCdpAttemptWithRaceGuard;
}): Promise<TBrowser> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runAttempt<TBrowser>({ connect, ...(disconnect ? { disconnect } : {}) });
    } catch (err) {
      lastErr = err;
      if (!isCdpAttachSessionRaceError(err)) {
        // A different failure entirely (auth, unreachable endpoint, real
        // browser crash) — fail fast with its original identity, untagged.
        throw err;
      }
      if (attempt === maxAttempts) {
        // The ONLY point that knows the bounded retry budget was exhausted
        // specifically on this narrow race. Tag it here so no downstream
        // layer has to re-parse message text to learn the same fact.
        // biome-ignore lint/style/useErrorCause: CdpAttachSessionRaceExhaustedError's constructor already forwards `cause` to super() internally — Biome only recognizes a literal `{ cause }` at the call site
        throw new CdpAttachSessionRaceExhaustedError(err);
      }
      process.stderr.write(
        "[browser-launch] remote CDP attach hit transient session-closed race " +
          `profile=${profileName} url=${redactedUrl} attempt=${attempt}/${maxAttempts}; ` +
          `retrying in ${retryDelayMs}ms\n`
      );
      await sleep(retryDelayMs);
    }
  }
  // Unreachable: the loop either returns or throws. Rethrow defensively.
  throw lastErr;
}

/**
 * Attach to a remote Chromium via the standard DevTools Protocol over
 * WebSocket. Used when the connector should run inside a browser hosted
 * by a different container (e.g. n.eko) so the manual_action streaming
 * handoff lands on the exact same browser process.
 *
 * The returned context is the FIRST existing context on the remote
 * browser — typically the only context, since neko's Chromium runs with
 * a single persistent user-data-dir. The release function disconnects
 * the Patchright client but leaves the remote browser running; lifecycle
 * is owned by whoever launched it.
 *
 * Pages opened by the connector are NOT cleaned up automatically — the
 * connector should close any pages it opened in its own cleanup. This
 * matches `launchPersistentContext` semantics where the context outlives
 * individual pages.
 *
 * The attach itself is wrapped in `connectOverCdpWithRetry` to ride out the
 * transient session-closed race n.eko's transient targets trigger during
 * Patchright's auto-attach. That race does NOT reject `connectOverCDP`; it
 * escapes as a Node unhandled rejection from patchright's floated
 * `setRequestInterception(true)`, so each attempt runs under a scoped
 * `unhandledRejection` guard. See `runCdpAttemptWithRaceGuard` and
 * `isCdpAttachSessionRaceError`.
 */
export function shouldCleanRemoteCdpPageTargets({
  preserveRemotePagesOnAcquire,
}: Pick<AcquireIsolatedBrowserOptions, "preserveRemotePagesOnAcquire">): boolean {
  return !preserveRemotePagesOnAcquire;
}

async function acquireRemoteCdpBrowser(
  cdpUrl: string,
  profileName: string,
  options: Pick<AcquireIsolatedBrowserOptions, "preserveRemotePagesOnAcquire"> = {}
): Promise<IsolatedBrowser> {
  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");
  const attachStartedAt = Date.now();
  const redactedUrl = redactCdpUrl(cdpUrl);
  process.stderr.write(`[browser-launch] remote CDP attach start profile=${profileName} url=${redactedUrl}\n`);
  if (shouldCleanRemoteCdpPageTargets(options)) {
    // Remote profiles usually persist cookies; stale page targets do not need
    // to persist. Replace pages before attach so Patchright does not auto-attach
    // to a wedged renderer, while n.eko Chromium still keeps at least one page alive.
    const cleanup = await closeRemoteCdpPageTargets({ cdpUrl, profileName });
    process.stderr.write(
      `[browser-launch] remote CDP page-target cleanup profile=${profileName} closed=${cleanup.closed} remaining=${cleanup.remaining} replacementCreated=${String(
        cleanup.replacementCreated
      )} skipped=${String(cleanup.skipped)}\n`
    );
  } else {
    process.stderr.write(
      `[browser-launch] remote CDP page-target cleanup skipped profile=${profileName} reason=preserve_remote_pages_on_acquire\n`
    );
  }
  const browser = await connectOverCdpWithRetry<Browser>({
    connect: () => localChromium.connectOverCDP(cdpUrl),
    // If the floated `setRequestInterception` race rejects AFTER this attempt's
    // `connectOverCDP` already returned a live Browser, that Browser is orphaned
    // by the retry; disconnect it so we don't leak a CDP client. `.close()` on a
    // CDP-attached client disconnects without killing the n.eko-owned browser.
    disconnect: (b) => b.close().catch(() => undefined),
    profileName,
    redactedUrl,
  });
  const attachedAt = Date.now();
  let releaseRequested = false;
  const onDisconnected = (): void => {
    process.stderr.write(
      `[browser-launch] remote CDP disconnected profile=${profileName} elapsedMs=${Date.now() - attachedAt} releaseRequested=${String(
        releaseRequested
      )}\n`
    );
  };
  browser.on("disconnected", onDisconnected);
  process.stderr.write(
    `[browser-launch] remote CDP attached profile=${profileName} elapsedMs=${Date.now() - attachStartedAt}\n`
  );
  const [context] = browser.contexts();
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error(
      `acquireRemoteCdpBrowser(${profileName}): remote browser at ${cdpUrl} has no contexts; cannot attach`
    );
  }
  // Publish the CDP endpoint into process.env so `browser-handoff.ts` can
  // compose per-page wsUrls for manual_action registration. The host:port
  // we expose to the streaming companion is the SAME url we attached on —
  // it's what the companion's cdp-adapter will dial back through.
  try {
    const parsed = new URL(cdpUrl);
    process.env.PDPP_BROWSER_CDP_HOST = parsed.hostname;
    process.env.PDPP_BROWSER_CDP_PORT = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch (err) {
    process.stderr.write(
      `[browser-launch] could not parse remote CDP URL ${cdpUrl}: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
  return {
    browser,
    context,
    release: async (): Promise<void> => {
      // Disconnect only. Closing the remote browser would kill the n.eko
      // X-attached process; that lifecycle is owned by the neko container.
      releaseRequested = true;
      try {
        await browser.close();
      } catch {
        /* ignore */
      } finally {
        browser.off("disconnected", onDisconnected);
      }
    },
  };
}

function redactCdpUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "unparseable";
  }
}

// ─── HAR secret-hygiene pass (post-close, best-effort) ─────────────────────
//
// Playwright's own `recordHar` has no redaction knob — it captures headers,
// cookies, and bodies verbatim. This package's existing recorder
// (subprocess-fetch-preloads.ts's `writeRecordPreload`) never persists
// Cookie/Set-Cookie/Authorization at all (its capture shape doesn't even
// have a request-header field), redacts credential-shaped query params by
// name, and (src/interaction-handler.ts's `SECRET_FIELD_RE`) never persists
// a credentials-kind prompt response. This pass follows the SAME posture at
// the HAR layer: strip session/auth-carrying HEADERS and HAR's own
// structured `cookies[]` arrays (both request and response sides) plus
// credential-shaped request POST DATA — see `redactHarEntry`'s doc comment
// for the exact field list. It does NOT touch response/request BODY
// content (see `harRecording`'s doc comment for why that's a stated,
// deliberate gap, not an oversight).

/** Case-insensitive header names stripped from every HAR entry, both
 *  request and response sides. `cookie`/`set-cookie` carry session
 *  identity; `authorization` carries bearer/basic credentials;
 *  `x-csrf-token`/`x-xsrf-token` are the common CSRF-header spellings this
 *  package's connectors and their providers use. Matched by exact
 *  lower-cased name, not a substring/regex, so an unrelated header that
 *  merely CONTAINS one of these words (unlikely, but the query-param
 *  redaction elsewhere in this package uses substring matching precisely
 *  because query param names are freeform — HTTP header names are not) is
 *  never mistakenly dropped. */
const REDACTED_HAR_HEADER_NAMES = new Set(["cookie", "set-cookie", "authorization", "x-csrf-token", "x-xsrf-token"]);

const REDACTED_HAR_HEADER_PLACEHOLDER = "[redacted-by-scenario-record]";

interface HarNameValue {
  name: string;
  value: string;
}

interface HarPostDataParam {
  name: string;
  value?: string;
}

interface HarRequestOrResponse {
  cookies?: HarNameValue[];
  headers?: HarNameValue[];
  postData?: { mimeType?: string; params?: HarPostDataParam[]; text?: string };
}

interface HarEntry {
  request?: HarRequestOrResponse;
  response?: HarRequestOrResponse;
}

interface HarDocument {
  log?: { entries?: HarEntry[] };
}

/** Redacts headers matching `REDACTED_HAR_HEADER_NAMES` in place, returning
 *  a NEW array (does not mutate the input) with matching entries'
 *  `value` replaced by the placeholder — the header NAME is kept (so a
 *  reader can still see e.g. "an Authorization header was sent here"
 *  without learning its value), matching this package's existing
 *  `--persist-otp`-adjacent posture of recording the SHAPE of what happened
 *  without the secret itself. */
function redactHeaders(headers: HarNameValue[]): HarNameValue[] {
  return headers.map((header) =>
    REDACTED_HAR_HEADER_NAMES.has(header.name.toLowerCase())
      ? { name: header.name, value: REDACTED_HAR_HEADER_PLACEHOLDER }
      : header
  );
}

/** HAR's own structured `cookies[]` array (distinct from the `Cookie`/
 *  `Set-Cookie` HEADER, which `redactHeaders` also strips — Playwright
 *  populates both independently, so both must be redacted or the cookie
 *  value survives in the array even with the header blanked). Keeps the
 *  cookie NAME, drops the value. */
function redactCookies(cookies: HarNameValue[]): HarNameValue[] {
  return cookies.map((cookie) => ({ name: cookie.name, value: REDACTED_HAR_HEADER_PLACEHOLDER }));
}

/**
 * Redacts a request's `postData` when it looks like a credential
 * submission — mirrors `bin/scenario-record.ts`'s `isCredentialsPrompt`
 * posture (never persist a real credential value) rather than inventing a
 * new philosophy: a login POST is exactly the browser-driven analogue of
 * the Collection Profile `credentials`-kind INTERACTION that CLI already
 * redacts unconditionally. Heuristic, not a parser: `application/
 * x-www-form-urlencoded` or `multipart/form-data` bodies whose PARSED
 * fields (Playwright already gives us `params[]` for these content types)
 * include a name matching `CREDENTIAL_FORM_FIELD_RE` (password/passwd/pwd/
 * secret/token/otp/pin) get every param value blanked — a JSON login body
 * has no such structured `params[]` from Playwright, so it falls through
 * unredacted; see this function's caller-side doc comment on residual
 * exposure for that honestly-stated gap.
 */
const CREDENTIAL_FORM_FIELD_RE = /pass(word|wd)?|secret|token|\botp\b|\bpin\b/i;

type HarPostData = NonNullable<HarRequestOrResponse["postData"]>;

function looksLikeCredentialFormPost(postData: HarPostData): boolean {
  if (!postData.params) {
    return false;
  }
  return postData.params.some((param) => CREDENTIAL_FORM_FIELD_RE.test(param.name));
}

function redactPostData(postData: HarPostData): HarPostData {
  if (!looksLikeCredentialFormPost(postData)) {
    return postData;
  }
  const out: HarPostData = {};
  if (postData.mimeType !== undefined) {
    out.mimeType = postData.mimeType;
  }
  if (postData.text !== undefined) {
    out.text = REDACTED_HAR_HEADER_PLACEHOLDER;
  }
  if (postData.params) {
    out.params = postData.params.map((param) => ({ name: param.name, value: REDACTED_HAR_HEADER_PLACEHOLDER }));
  }
  return out;
}

function redactHarRequestOrResponse(side: HarRequestOrResponse): HarRequestOrResponse {
  const out: HarRequestOrResponse = { ...side };
  if (side.headers) {
    out.headers = redactHeaders(side.headers);
  }
  if (side.cookies) {
    out.cookies = redactCookies(side.cookies);
  }
  if (side.postData) {
    out.postData = redactPostData(side.postData);
  }
  return out;
}

/** Pure redaction of one parsed HAR document — exported so this exact
 *  transform is independently unit-testable against a synthetic HAR
 *  without touching the filesystem. See the module-scope "HAR secret-
 *  hygiene pass" comment above for the full posture and what is
 *  deliberately NOT redacted (response/request body content). */
export function redactHarDocument(har: HarDocument): HarDocument {
  const entries = har.log?.entries;
  if (!entries) {
    return har;
  }
  return {
    ...har,
    log: {
      ...har.log,
      entries: entries.map((entry) => {
        const out: HarEntry = { ...entry };
        if (entry.request) {
          out.request = redactHarRequestOrResponse(entry.request);
        }
        if (entry.response) {
          out.response = redactHarRequestOrResponse(entry.response);
        }
        return out;
      }),
    },
  };
}

/**
 * Reads the HAR JSON at `path`, applies `redactHarDocument`, and writes it
 * back 0600 — best-effort: a missing file (the honest "context.close()
 * never ran / HAR was never flushed" case — see `HarRecordingOutcome`'s doc
 * comment) or an unparseable file logs a warning and returns without
 * throwing, so a redaction-pass failure never turns into an unhandled
 * rejection that crashes the caller's `release()`. The mode is set
 * EXPLICITLY (not left to Playwright's own create-time umask-dependent
 * default) — mirrors `bin/scenario-record.ts`'s `writeScenarioAtomically`,
 * which never trusts umask for a file that may hold real captured data
 * either.
 *
 * EXPORTED so test fixtures that simulate a browser-driven connector
 * WITHOUT a real Chromium (this package's convention — see
 * `browser-launch.test.ts`'s module comment) can call the SAME redaction
 * `acquireIsolatedBrowser`'s `release()` runs, instead of a test double
 * re-implementing (and potentially drifting from) this logic. See
 * `src/test-fixtures/scenario-record-har-stub-connector.ts`.
 */
export async function redactHarFileBestEffort(path: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // No file to redact — either recording was never enabled for real (a
    // logic error upstream, since this is only called when it was) or
    // context.close() never completed (crash/SIGKILL). Either way there is
    // nothing to redact, and `harRecordingOutcome` is the honest signal for
    // "no HAR exists" — this function does not duplicate that reporting.
    return;
  }
  let parsed: HarDocument;
  try {
    parsed = JSON.parse(raw) as HarDocument;
  } catch (err) {
    process.stderr.write(
      `[browser-launch] HAR at ${path} was not valid JSON; leaving it UNREDACTED and unmodified. ` +
        `Treat this file as sensitive until manually reviewed. (${err instanceof Error ? err.message : String(err)})\n`
    );
    return;
  }
  const redacted = redactHarDocument(parsed);
  try {
    // `mode` on writeFile only applies at file CREATION; the HAR already
    // exists (Playwright created it), so force 0600 explicitly afterward —
    // same two-step belt-and-suspenders as `writeScenarioAtomically`.
    await writeFile(path, JSON.stringify(redacted), "utf8");
    await chmod(path, 0o600);
  } catch (err) {
    process.stderr.write(
      `[browser-launch] failed to write redacted HAR back to ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}. The file may still contain UNREDACTED secrets.\n`
    );
  }
}

/**
 * Writes `context.storageState()` to `path`, 0600, UNREDACTED (see
 * `storageStateRecording`'s doc comment on `AcquireIsolatedBrowserOptions`
 * for why redacting this file would defeat its purpose). Best-effort: a
 * failure here (context already unusable, disk error) logs a warning and
 * returns without throwing — `storageStateRecordingOutcome()` is the
 * caller-facing honest signal for "no session snapshot exists"; this
 * function does not duplicate that reporting, it only guarantees a failure
 * here can never block `release()`'s subsequent `context.close()`.
 */
async function writeStorageStateBestEffort(context: BrowserContext, path: string): Promise<void> {
  try {
    const state = await context.storageState();
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      `[browser-launch] failed to capture storageState to ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}. Replay will have no seeded session for this capture.\n`
    );
  }
}

/**
 * Reports whether a file this module was supposed to write actually reached
 * disk, nonempty — shared by `HarRecordingOutcome` and
 * `StorageStateRecordingOutcome` (both are the same "did the expected
 * side-effect file land" question). Checks for a nonempty file rather than
 * mere existence: a zero-byte file at this path is not a real capture (a
 * write raced with a read, or a placeholder was created some other way) —
 * treated the same as "does not exist" rather than reported as a false
 * success.
 *
 * EXPORTED so `bin/scenario-record.ts` can call this directly: HAR/
 * storageState recording is requested via an env var that crosses into a
 * SEPARATE OS process (the spawned connector subprocess), so the CLI has no
 * live `IsolatedBrowser` handle to call `harRecordingOutcome()`/
 * `storageStateRecordingOutcome()` on — it must independently re-check the
 * same path after the subprocess exits, using the identical honesty rule
 * (nonempty file, not mere existence) rather than a second, potentially
 * divergent implementation.
 */
export async function fileFlushOutcome(path: string): Promise<{ flushed: boolean; path: string }> {
  try {
    const info = await stat(path);
    return { path, flushed: info.isFile() && info.size > 0 };
  } catch {
    return { path, flushed: false };
  }
}

/**
 * Launch an isolated per-connection browser context with its own profile dir.
 * The connector runtime scopes the profile name with the stable connector
 * instance ID when the reference runtime supplies one.
 */
export async function acquireIsolatedBrowser({
  profileName,
  headless,
  streamingEnabled,
  remoteCdpUrl,
  preserveRemotePagesOnAcquire,
  harRecording,
  storageStateRecording,
}: AcquireIsolatedBrowserOptions): Promise<IsolatedBrowser> {
  if (!(profileName && PROFILE_NAME_RE.test(profileName))) {
    throw new Error("profileName required, must be [A-Za-z0-9_-]+");
  }
  // Remote-CDP attach: skip the entire local-launch path. The remote
  // browser owns its own profile and lifecycle (e.g. the n.eko container);
  // we just attach as a CDP client.
  if (remoteCdpUrl) {
    return acquireRemoteCdpBrowser(
      remoteCdpUrl,
      profileName,
      preserveRemotePagesOnAcquire ? { preserveRemotePagesOnAcquire } : {}
    );
  }
  const effectiveHeadless = resolveDeploymentBrowserHeadless(headless);
  const profileRoot = process.env.PDPP_BROWSER_PROFILE_ROOT?.trim() || join(homedir(), ".pdpp", "profiles");
  const isolatedDir = join(profileRoot, profileName);
  if (!existsSync(isolatedDir)) {
    mkdirSync(isolatedDir, { recursive: true, mode: 0o700 });
  }

  // Patchright "Best Practice" config; do not re-add Chromium flags
  // patchright already manages.
  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");

  // Streaming-registration mode needs Chromium to expose a TCP CDP endpoint
  // (so the streaming companion can connect by URL later) and write
  // `<userDataDir>/DevToolsActivePort` so we can discover the random port.
  // Patchright 1.61.1's persistent-context path still owns its parent CDP
  // transport through `--remote-debugging-pipe`; adding a second
  // `--remote-debugging-port=0` is supported by Chromium and preserves the
  // driver's pipe while publishing the companion endpoint. Bind it to
  // loopback because the wsUrl path carries a bearer secret.
  const baseArgs = [
    // Workaround for microsoft/playwright#40158: headed Chrome's download
    // bubble races Playwright's CDP-based download interception.
    "--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3",
  ];
  // Optional Chromium flags from PDPP_BROWSER_EXTRA_ARGS (space-separated).
  // Operator escape hatch for environment-specific needs that the launcher
  // intentionally does not opinionate on. Examples:
  //   - `--disable-gpu` when running headless under tmux without XAUTHORITY
  //     exported (Chromium otherwise tries the X display, fails GPU init,
  //     and the CDP child dies on the first command).
  //   - `--proxy-server=http://...` for corporate proxies.
  //   - Locale / font hinting flags for specific deployments.
  // Empty by default; we want the launcher to do the right thing on a sane
  // host without configuration.
  const extraArgsRaw = process.env.PDPP_BROWSER_EXTRA_ARGS;
  if (extraArgsRaw) {
    for (const a of extraArgsRaw.split(EXTRA_BROWSER_ARGS_RE).filter(Boolean)) {
      baseArgs.push(a);
    }
  }
  // Diagnostic for the most common GPU-init failure mode we've observed in dev:
  // tmux sessions started before the X session exported XAUTHORITY. Chromium
  // sees DISPLAY but cannot authenticate, GPU process crashes, the parent CDP
  // child reports "Internal server error, session closed" on the first call.
  // We don't auto-fix (operator may have a real reason for the env shape) but
  // we flag it once so the next operator who hits this isn't debugging blind.
  // Core's managed Xvfb display uses `-ac`, so it does not need XAUTHORITY and
  // skips this host/tmux diagnostic. Other X displays still get the warning.
  // Keep this predicate identical to browserSurfaceConfigured() in
  // reference-implementation/runtime/scheduler-readiness.ts — that module
  // can't import this one across the package boundary, so the two checks
  // are kept in sync by hand. Diverging here silently breaks scheduler
  // readiness for every browser-capable Core image.
  const managedDisplayAvailable = process.env.PDPP_RUNTIME_BROWSER === "1" && Boolean(process.env.DISPLAY);
  if (
    !(displayAuthWarningEmitted || managedDisplayAvailable) &&
    process.env.DISPLAY &&
    !process.env.XAUTHORITY &&
    !extraArgsRaw?.includes("--disable-gpu")
  ) {
    displayAuthWarningEmitted = true;
    process.stderr.write(
      "[browser-launch] DISPLAY is set but XAUTHORITY is empty (common in tmux). " +
        "Chromium GPU init may fail with 'session closed'. Either export XAUTHORITY " +
        "(e.g. `export XAUTHORITY=$(systemctl --user show-environment | grep ^XAUTHORITY | cut -d= -f2)`) " +
        "or set PDPP_BROWSER_EXTRA_ARGS=--disable-gpu before launching.\n"
    );
  }
  if (streamingEnabled) {
    baseArgs.push("--remote-debugging-address=127.0.0.1");
    baseArgs.push("--remote-debugging-port=0");
  }

  type PatchrightLaunchOptions = NonNullable<Parameters<typeof localChromium.launchPersistentContext>[1]> & {
    cdpPort?: number;
  };
  const baseLaunchOptions: PatchrightLaunchOptions = {
    headless: effectiveHeadless,
    viewport: null,
    args: baseArgs,
    // OFF by default (`harRecording` is opt-in and normally omitted), so an
    // ordinary connector launch never has a `recordHar` key at all — not
    // merely a falsy one, an ABSENT one — matching Playwright's own "HAR is
    // not recorded" default and keeping this launch path a true no-op for
    // every caller that doesn't ask for it. See `harRecording`'s doc
    // comment on `AcquireIsolatedBrowserOptions` for the `content: "embed"`
    // justification.
    ...(harRecording ? { recordHar: { path: harRecording.path, content: "embed" as const } } : {}),
  };

  const explicitChannel = configuredBrowserChannel();
  // Default to Patchright's pinned bundled Chromium so local and n.eko runs
  // share the same browser-family posture. Operators can still opt into a
  // branded channel explicitly with PDPP_BROWSER_CHANNEL=chrome.
  // Cleanup-then-launch is gated by an in-process mutex keyed on the
  // user-data-dir. The mutex is the load-bearing primitive: it guarantees
  // PDPP never has two of its own processes launching against the same
  // profile concurrently. Given that, any Singleton* residue we encounter
  // is provably from a prior incarnation (e.g. previous container) and
  // safe to remove unconditionally. See `profile-lock.ts` header comment
  // for the design rationale and source references.
  const context: BrowserContext = await withProfileLockMutex(isolatedDir, async () => {
    await removeChromiumSingletonResidue(isolatedDir);
    if (explicitChannel) {
      return localChromium.launchPersistentContext(isolatedDir, {
        ...baseLaunchOptions,
        channel: explicitChannel,
      });
    }
    return localChromium.launchPersistentContext(isolatedDir, baseLaunchOptions);
  });

  // Fail fast on an unusable display instead of proceeding into a doomed
  // run. Root-cause precedent (see the venmo fix in this same change and
  // the DISPLAY/XAUTHORITY warning above): a headed launch whose display is
  // set but unauthenticated/unusable (common under tmux with an empty
  // XAUTHORITY) still returns a live Browser/Context/Page from Playwright —
  // the GPU/compositor failure is silent at the launch API. The page then
  // never lays out, `page.goto` never actually commits visually, and every
  // downstream probe fails with an opaque transport error dozens of seconds
  // later. `launchPersistentContext` already opens an initial page for a
  // persistent context, so this is the earliest point a real viewport
  // reading is available.
  const [initialPage] = context.pages();
  if (initialPage) {
    await failFastOnUnusableViewport(initialPage);
  }

  // Publish the CDP host:port to env so the browser-binding-local handoff
  // helper (`browser-handoff.ts`) can compose per-interaction wsUrls at
  // `manual_action` emission time. The launcher does NOT register any
  // wsUrl itself — registration is now interaction-scoped and owned by
  // the binding code path that emits the manual_action (see
  // `openspec/changes/add-run-interaction-streaming-companion/design-notes/`
  // `interaction-scoped-target-resolution-2026-05-05.md`). Best-effort:
  // failures here MUST NOT prevent the run; streaming will simply be
  // unavailable.
  if (streamingEnabled) {
    await publishCdpEndpointFromLaunch({ isolatedDir });
  }

  return {
    context,
    browser: context.browser(),
    release: async (): Promise<void> => {
      // storageState() MUST be read BEFORE context.close() — Playwright
      // cannot read state off an already-closed context. Best-effort: a
      // crash here must not prevent context.close() from still being
      // attempted below (the pre-existing shutdown contract every other
      // caller relies on).
      if (storageStateRecording) {
        await writeStorageStateBestEffort(context, storageStateRecording.path);
      }
      try {
        await context.close();
      } catch {
        /* ignore */
      }
      // Playwright only flushes recordHar content during context close (see
      // `HarRecordingOutcome`'s doc comment) — running redaction here, AFTER
      // `context.close()` has been awaited (success OR failure), is the
      // earliest point a HAR file could possibly exist. A `harRecording`
      // caller that reads `harRecordingOutcome()` before this point would
      // race the flush; ordering `release()`'s own internals this way means
      // the race can only ever make redaction correctly report "not
      // written yet" on a violated call-order, never a false positive.
      if (harRecording) {
        await redactHarFileBestEffort(harRecording.path);
      }
    },
    ...(harRecording
      ? {
          harRecordingOutcome: (): Promise<HarRecordingOutcome> => fileFlushOutcome(harRecording.path),
        }
      : {}),
    ...(storageStateRecording
      ? {
          storageStateRecordingOutcome: (): Promise<StorageStateRecordingOutcome> =>
            fileFlushOutcome(storageStateRecording.path),
        }
      : {}),
  };
}

/**
 * Read the CDP port that Chromium picked (via `DevToolsActivePort`) and
 * publish the host:port to `process.env.PDPP_BROWSER_CDP_HOST` /
 * `PDPP_BROWSER_CDP_PORT`. The browser-binding-local handoff helper
 * (`browser-handoff.ts`) reads those vars at `manual_action` emission
 * time to compose per-interaction wsUrls for its exact-`Page` resolver.
 * This is the env-var channel because the launcher and the connector
 * code that calls `manualAction` run in the same process.
 *
 * Best-effort: if the port can't be read, log and return — streaming
 * will simply be unavailable for this run. Records still flow normally.
 */
async function publishCdpEndpointFromLaunch({ isolatedDir }: { isolatedDir: string }): Promise<void> {
  try {
    const port = await readDevToolsActivePort({ userDataDir: isolatedDir, timeoutMs: 5000, pollMs: 50 });
    if (port === null) {
      process.stderr.write(
        "[browser-launch] could not read DevToolsActivePort; streaming-companion will be unavailable for this run.\n"
      );
      return;
    }
    publishCdpEndpointToEnv({ host: "127.0.0.1", port });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[browser-launch] CDP endpoint publication failed: ${message}; streaming will be unavailable for this run.\n`
    );
  }
}

/**
 * Env-var channel for the browser-binding-local handoff helper. The launcher
 * is the only authority that knows which port Chromium picked (it read
 * `DevToolsActivePort` to find out); `process.env` is the cross-module
 * channel both modules share inside the connector subprocess.
 *
 * Setting these AFTER a successful port read is intentional: a stale value
 * from a previous run would point the handoff at a defunct browser; we'd
 * rather have `prepareManualAction` honestly say "no streaming endpoint"
 * than register a wsUrl that will fail at attach time.
 *
 * Mirrors `BROWSER_CDP_HOST_ENV` / `BROWSER_CDP_PORT_ENV` in
 * `browser-handoff.ts`. Kept as string literals rather than imports so
 * the launcher does not transitively pull in the handoff module (which
 * imports playwright types) at acquisition time.
 */
function publishCdpEndpointToEnv({ host, port }: { host: string; port: number }): void {
  process.env.PDPP_BROWSER_CDP_HOST = host;
  process.env.PDPP_BROWSER_CDP_PORT = String(port);
}

/**
 * Read Chromium's `DevToolsActivePort` (written to `<userDataDir>` when
 * `--remote-debugging-port=0` is set), then GET `http://127.0.0.1:PORT/json`
 * and pick the first `page` target's `webSocketDebuggerUrl`.
 *
 * Returns `null` when:
 *   - the port file isn't available within the poll window, or
 *   - the `/json` endpoint isn't reachable, or
 *   - no `type === "page"` target is present.
 *
 * Caller treats `null` as "skip registration, log + continue."
 *
 * Why DevToolsActivePort: Chromium writes this file as part of
 * remote-debugging startup (it's how `chrome --remote-debugging-port=0`
 * communicates the chosen random port to the launching process). It is the
 * canonical local-only handshake for "what port did Chromium pick?" and
 * does not require parsing Chromium stderr (which Playwright captures and
 * does not re-expose on launchPersistentContext).
 *
 * `fetchImpl` is injectable so tests can exercise the `/json` parsing
 * branch without a real Chromium.
 */
export async function resolvePageTargetWsUrl({
  userDataDir,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  pollMs = 50,
}: {
  userDataDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string | null> {
  const port = await readDevToolsActivePort({ userDataDir, timeoutMs, pollMs });
  if (port === null) {
    return null;
  }
  return await fetchPageTargetWsUrl({ port, fetchImpl });
}

async function readDevToolsActivePort({
  userDataDir,
  timeoutMs,
  pollMs,
}: {
  userDataDir: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<number | null> {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  // Playwright's `waitForReadyState` already blocks on `DevTools listening on …`
  // before returning, so by the time we get here the file is almost always
  // present. The poll loop is for the rare race where Chromium logs the line
  // before flushing the file to disk; cap is small.
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(portFile, "utf8");
      const firstLine = contents.split("\n", 1)[0]?.trim();
      const portNum = firstLine ? Number.parseInt(firstLine, 10) : Number.NaN;
      if (Number.isFinite(portNum) && portNum > 0) {
        return portNum;
      }
    } catch {
      // file not yet written; retry
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

interface DevToolsTarget {
  readonly id?: string;
  readonly type?: string;
  readonly webSocketDebuggerUrl?: string;
}

export interface RemoteCdpPageTargetCleanupResult {
  readonly closed: number;
  readonly remaining: number;
  readonly replacementCreated: boolean;
  readonly skipped: boolean;
}

export async function closeRemoteCdpPageTargets({
  cdpUrl,
  fetchImpl = globalThis.fetch,
  profileName,
  timeoutMs = 2000,
  pollMs = 100,
}: {
  cdpUrl: string;
  fetchImpl?: typeof fetch;
  profileName?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<RemoteCdpPageTargetCleanupResult> {
  if (typeof fetchImpl !== "function") {
    return { closed: 0, remaining: 0, replacementCreated: false, skipped: true };
  }
  const baseUrl = devToolsHttpBaseUrl(cdpUrl);
  if (!baseUrl) {
    return { closed: 0, remaining: 0, replacementCreated: false, skipped: true };
  }

  const deadline = Date.now() + timeoutMs;
  const targets = await fetchRemoteDevToolsTargets({ baseUrl, deadline, fetchImpl });
  if (!targets) {
    return { closed: 0, remaining: 0, replacementCreated: false, skipped: true };
  }

  const pageTargets = targets.filter((target) => target?.type === "page" && typeof target.id === "string" && target.id);
  if (pageTargets.length === 0) {
    return { closed: 0, remaining: 0, replacementCreated: false, skipped: false };
  }
  const staleTargetIds = new Set(pageTargets.map((target) => target.id).filter((id): id is string => Boolean(id)));
  const replacement = await createRemoteDevToolsPageTarget({ baseUrl, deadline, fetchImpl });
  if (!replacement?.id) {
    return { closed: 0, remaining: staleTargetIds.size, replacementCreated: false, skipped: true };
  }
  staleTargetIds.delete(replacement.id);

  let closed = 0;
  for (const targetId of staleTargetIds) {
    if (Date.now() >= deadline) {
      break;
    }
    const ok = await closeRemoteDevToolsTarget({ baseUrl, deadline, fetchImpl, targetId });
    if (ok) {
      closed += 1;
    }
  }

  let remaining = Math.max(0, staleTargetIds.size - closed);
  while (Date.now() < deadline) {
    const latestTargets = await fetchRemoteDevToolsTargets({ baseUrl, deadline, fetchImpl });
    if (!latestTargets) {
      break;
    }
    remaining = countMatchingPageTargets(latestTargets, staleTargetIds);
    if (remaining === 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }

  if (profileName && remaining > 0) {
    process.stderr.write(
      `[browser-launch] remote CDP page-target cleanup incomplete profile=${profileName} remaining=${remaining}\n`
    );
  }
  return { closed, remaining, replacementCreated: true, skipped: false };
}

function devToolsHttpBaseUrl(cdpUrl: string): URL | null {
  try {
    const parsed = new URL(cdpUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return new URL("/", parsed);
    }
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
      return new URL("/", parsed);
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchRemoteDevToolsTargets({
  baseUrl,
  deadline,
  fetchImpl,
}: {
  baseUrl: URL;
  deadline: number;
  fetchImpl: typeof fetch;
}): Promise<DevToolsTarget[] | null> {
  const response = await fetchWithDeadline(new URL("/json", baseUrl).toString(), deadline, fetchImpl);
  if (!response?.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return Array.isArray(body) ? (body as DevToolsTarget[]) : null;
}

async function closeRemoteDevToolsTarget({
  baseUrl,
  deadline,
  fetchImpl,
  targetId,
}: {
  baseUrl: URL;
  deadline: number;
  fetchImpl: typeof fetch;
  targetId: string;
}): Promise<boolean> {
  const url = new URL(`/json/close/${encodeURIComponent(targetId)}`, baseUrl).toString();
  const response = await fetchWithDeadline(url, deadline, fetchImpl);
  return response?.ok === true;
}

async function createRemoteDevToolsPageTarget({
  baseUrl,
  deadline,
  fetchImpl,
}: {
  baseUrl: URL;
  deadline: number;
  fetchImpl: typeof fetch;
}): Promise<DevToolsTarget | null> {
  const response = await fetchWithDeadline(new URL("/json/new?about:blank", baseUrl).toString(), deadline, fetchImpl, {
    method: "PUT",
  });
  if (!response?.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return typeof body === "object" && body !== null ? (body as DevToolsTarget) : null;
}

async function fetchWithDeadline(
  url: string,
  deadline: number,
  fetchImpl: typeof fetch,
  init: RequestInit = {}
): Promise<Response | null> {
  const remainingMs = Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, remainingMs);
    });
    return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }), timeoutPromise]);
  } catch {
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function countMatchingPageTargets(targets: readonly DevToolsTarget[], targetIds: ReadonlySet<string>): number {
  return targets.filter(
    (target) => target?.type === "page" && typeof target.id === "string" && targetIds.has(target.id)
  ).length;
}

export async function fetchPageTargetWsUrl({
  port,
  fetchImpl = globalThis.fetch,
}: {
  port: number;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  if (typeof fetchImpl !== "function") {
    return null;
  }
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${String(port)}/json`);
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(body)) {
    return null;
  }
  // Prefer the first `page` target. Some Chromium builds also list `iframe`,
  // `worker`, `service_worker`, `browser`, etc. — we want a real page.
  const pageTarget = (body as DevToolsTarget[]).find(
    (target) => target?.type === "page" && typeof target.webSocketDebuggerUrl === "string"
  );
  return pageTarget?.webSocketDebuggerUrl ?? null;
}

// Module-scope so the DISPLAY-without-XAUTHORITY warning fires once per
// process, not once per browser launch — quiet logs in normal operation.
let displayAuthWarningEmitted = false;

/**
 * Acquire a browser context for connector use.
 *
 * Container policy:
 *   - Headless container acquisitions (`headless: true`) remain available as
 *     the advanced deployment-level escape hatch.
 *   - Core's headed local acquisitions proceed when its packaged runtime and
 *     managed Xvfb display are present.
 *   - Other headed container acquisitions fail closed with
 *     `HeadedBrowserUnavailableError` because there is no visible browser
 *     surface. Operators can use a local collector runtime instead — see
 *     `bin/collector-runner.ts`.
 *   - Operators who need to escape the gate (e.g., debugging a headed
 *     container browser locally with X11 forwarding) can set
 *     `PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1`. The runtime emits a loud
 *     per-acquisition warning so the override is visible in logs.
 *   - The host-direct path is unaffected — without any container signal,
 *     the runtime uses `acquireIsolatedBrowser` against
 *     `PDPP_BROWSER_PROFILE_ROOT/<name>/` (default `~/.pdpp/profiles/<name>/`).
 */
export async function acquireBrowserForConnector(options: AcquireIsolatedBrowserOptions): Promise<IsolatedBrowser> {
  const effectiveHeadless = resolveDeploymentBrowserHeadless(options.headless);
  const gate = decideContainerHeadedBrowserGate({
    headless: effectiveHeadless,
    inContainer: isRunningInContainer(),
    escapeHatchEnabled: process.env.PDPP_ALLOW_HEADED_CONTAINER_BROWSER === "1",
    managedDisplayAvailable: process.env.PDPP_RUNTIME_BROWSER === "1" && Boolean(process.env.DISPLAY?.trim()),
    ...(options.remoteCdpUrl ? { remoteCdpUrl: options.remoteCdpUrl } : {}),
  });
  if (gate.kind === "fail_closed") {
    throw new HeadedBrowserUnavailableError({
      message:
        "Headed (visible) browser-backed connector requested in a container without a managed browser runtime/display. " +
        "Use the browser-capable Core image (it starts full Patchright Chromium under Xvfb), " +
        "or run this connector in a local collector runtime that advertises a `browser` binding " +
        "(`pdpp collector enroll --base-url <url> --code <code>` then `pdpp collector run --base-url <url> --connector <id> ...`), " +
        "or run the provider/control-plane outside the container so the host-direct launcher can open a visible browser. " +
        "Headless container browsers are unaffected; interactive flows must use a local collector so the operator can complete login/OTP/Cloudflare.",
    });
  }
  if (gate.kind === "warn_and_proceed") {
    process.stderr.write(
      "[browser-launch] PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1 — bypassing the in-container fail-closed gate. " +
        "A headed Chromium in a container is invisible to the operator unless an X11/VNC bridge is in place; " +
        "interactive flows will hang silently if the operator cannot reach the browser window.\n"
    );
  }

  // FIX (scenario-record HAR capture): resolve the subprocess-boundary env
  // vars into the same typed options `acquireIsolatedBrowser` already
  // accepts programmatically — an explicit `options.harRecording`/
  // `options.storageStateRecording` (a same-process caller, e.g. a future
  // test or tool) always wins over the env var, matching every other
  // env-vs-explicit-option precedence in this file (e.g.
  // `resolveDeploymentBrowserHeadless`'s `headless ?? env[...]`).
  const harRecordPath = process.env[HAR_RECORD_PATH_ENV]?.trim() || undefined;
  const storageStateRecordPath = process.env[STORAGE_STATE_RECORD_PATH_ENV]?.trim() || undefined;
  const harRecording = options.harRecording ?? (harRecordPath ? { path: harRecordPath } : undefined);
  const storageStateRecording =
    options.storageStateRecording ?? (storageStateRecordPath ? { path: storageStateRecordPath } : undefined);
  return await acquireIsolatedBrowser({
    ...options,
    headless: effectiveHeadless,
    ...(harRecording ? { harRecording } : {}),
    ...(storageStateRecording ? { storageStateRecording } : {}),
  });
}
