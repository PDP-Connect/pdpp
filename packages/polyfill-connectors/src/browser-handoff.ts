/**
 * Browser-binding-local, interaction-scoped manual-action handoff.
 *
 * This module is the browser binding's bridge between an in-flight
 * `manual_action` interaction and the streaming-companion's per-interaction
 * page-target registry. It intentionally lives next to `browser-launch.ts`
 * (the patchright launcher) and is imported by browser-driven connectors
 * — the generic connector runtime never sees it.
 *
 * Architecture (see openspec/changes/add-run-interaction-streaming-companion/
 * design-notes/ and tmp/answer.md):
 *
 *   - The streaming target identity follows interaction identity, NOT browser
 *     launch time, NOT tab focus, NOT a mutable "latest page for this run"
 *     cell. Every browser `manual_action` is bound to the EXACT `Page` the
 *     human should see and control.
 *   - The browser binding (this module) owns page identity. It resolves the
 *     CDP page-target wsUrl for the precise `Page` the connector author
 *     hands in, then registers it under `(runId, interactionId)` BEFORE the
 *     interaction envelope reaches the operator.
 *   - The streaming companion (in the reference server) consumes an
 *     already-decided target — it does not ask "which tab is active now?"
 *
 * Failure mode: every helper here is best-effort and fails closed. If the
 * reference server is unreachable, the env vars aren't set, or the page is
 * closed mid-resolution, the connector still emits the interaction; the
 * streaming companion just won't have a target for it. Records still flow.
 *
 * NOTE on the launcher-time registration code path: this is the parallel
 * NEW code that replaces it. The launcher still pre-registers under a
 * `_launcher_bootstrap` interactionId — that path is scheduled for removal
 * once the connectors and binding paths route through this helper. Until
 * then, the two paths co-exist; the per-interaction registration here
 * overrides the launcher-time placeholder for any real `manual_action`.
 */

import { randomBytes } from "node:crypto";
import type { Page } from "playwright";

import type { InteractionRequest, InteractionResponse } from "./connector-runtime.ts";
import type { CaptureSession } from "./fixture-capture.ts";
import {
  resolveStreamingRegistrationFromEnv,
  type StreamingTargetRegistrationHooks,
} from "./streaming-target-registration.ts";

// ─── Exact-page CDP target resolver ────────────────────────────────────────
//
// Validated by the page-target resolver spike (tmp/spikes/page-target-resolver/
// findings.md). The compose-from-targetId approach (Approach 1 + 2b) is
// preferred over `/json` scraping because:
//
//   - it returns the target for the EXACT `Page` object passed in, not
//     "whichever page target appears first in /json" (that ordering is not
//     guaranteed to match the connector's working page, especially after
//     `context.newPage()` or popup creation);
//   - it works for popup targets that may not appear in `/json` immediately;
//   - one fewer HTTP round trip during launch / handoff.
//
// Requires the browser to have been launched with `cdpPort: 0` (or
// `--remote-debugging-port=0`) AND a known port — Patchright's pipe
// transport carries CDP for Playwright-internal use, but an external CDP
// client connecting via wsUrl needs an HTTP-exposed listener. Production
// already sets `cdpPort: 0` in streaming-registration mode (see
// `browser-launch.ts`).

export interface ResolveWsUrlOptions {
  readonly host: string;
  readonly port: number;
}

/**
 * Resolve the CDP page-target webSocketDebuggerUrl for the EXACT `Page`
 * passed in. Distinguishes pages by Playwright object identity, not by
 * URL/title (which can collide on `about:blank` or duplicate tabs).
 * Stable across navigations within the same page.
 *
 * Throws when the page is closed/detached (Playwright surfaces an error
 * along the lines of "browserContext.newCDPSession: page: no object with
 * guid …"). Callers in this module catch and treat as "skip registration".
 */
export async function resolveWsUrlForExactPage(page: Page, opts: ResolveWsUrlOptions): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
      targetInfo: { targetId: string; type: string };
    };
    if (targetInfo.type !== "page") {
      throw new Error(`expected page target, got type=${targetInfo.type}`);
    }
    return `ws://${opts.host}:${String(opts.port)}/devtools/page/${targetInfo.targetId}`;
  } finally {
    // Best-effort detach; if the page is already gone Playwright may reject
    // — that's irrelevant to our caller, which only needs the wsUrl.
    await session.detach().catch((): undefined => undefined);
  }
}

// ─── Env-var contract for the binding-local handoff ───────────────────────
//
// The launcher (`browser-launch.ts`) is the authority that knows which
// host:port the browser actually exposed CDP on. After a successful patchright
// launch in streaming-registration mode, it writes:
//
//   process.env.PDPP_BROWSER_CDP_HOST = "127.0.0.1";
//   process.env.PDPP_BROWSER_CDP_PORT = String(port);
//
// We read those here. The connector code, the launcher, and this helper
// all run in the same process (the launcher is imported by the connector
// runtime), so `process.env` is the right channel.
//
// Both env vars are required. If either is missing — typical when streaming
// is not configured for this run, or the launcher chose not to enable
// `cdpPort: 0` — `prepareManualAction` returns `{ registered: false }` and
// emits a warning, but does not throw.

const BROWSER_CDP_HOST_ENV = "PDPP_BROWSER_CDP_HOST";
const BROWSER_CDP_PORT_ENV = "PDPP_BROWSER_CDP_PORT";
const BROWSER_SURFACE_ID_ENV = "PDPP_BROWSER_SURFACE_ID";
const BROWSER_SURFACE_LEASE_ID_ENV = "PDPP_BROWSER_SURFACE_LEASE_ID";
const BROWSER_SURFACE_PROFILE_KEY_ENV = "PDPP_BROWSER_SURFACE_PROFILE_KEY";
const BROWSER_SURFACE_REQUIRED_ENV = "PDPP_BROWSER_SURFACE_REQUIRED";
const BROWSER_SURFACE_STREAM_BASE_URL_ENV = "PDPP_BROWSER_SURFACE_STREAM_BASE_URL";

interface ResolvedCdpEndpoint {
  readonly host: string;
  readonly port: number;
}

function resolveCdpEndpointFromEnv(env: NodeJS.ProcessEnv): ResolvedCdpEndpoint | undefined {
  const host = env[BROWSER_CDP_HOST_ENV]?.trim();
  const portRaw = env[BROWSER_CDP_PORT_ENV]?.trim();
  if (!(host && portRaw)) {
    return;
  }
  const port = Number.parseInt(portRaw, 10);
  if (!(Number.isFinite(port) && port > 0)) {
    return;
  }
  return { host, port };
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function isManagedNekoRequired(env: NodeJS.ProcessEnv): boolean {
  return nonEmptyEnv(env, BROWSER_SURFACE_REQUIRED_ENV)?.toLowerCase() === "neko";
}

function resolveManagedNekoDescriptorFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const baseUrl = nonEmptyEnv(env, BROWSER_SURFACE_STREAM_BASE_URL_ENV);
  const leaseId = nonEmptyEnv(env, BROWSER_SURFACE_LEASE_ID_ENV);
  const profileKey = nonEmptyEnv(env, BROWSER_SURFACE_PROFILE_KEY_ENV);
  if (!(baseUrl && leaseId && profileKey)) {
    return;
  }
  return {
    backend: "neko",
    base_url: baseUrl,
    lease_id: leaseId,
    profile_key: profileKey,
    ...(nonEmptyEnv(env, BROWSER_SURFACE_ID_ENV) ? { surface_id: nonEmptyEnv(env, BROWSER_SURFACE_ID_ENV) } : {}),
  };
}

// ─── Interaction-id generation ─────────────────────────────────────────────
//
// Same shape as the connector runtime's `nextInteractionId` (`int_<ts>_<n>`)
// but with a 4-byte random suffix instead of a per-process counter. The
// runtime's counter is closed over its own `runConnector` invocation and
// not reachable from this helper; the random suffix gives equivalent
// uniqueness guarantees without adding shared state. Both forms accepted
// downstream — the request_id is opaque to the protocol.

function generateInteractionId(): string {
  return `int_${String(Date.now())}_${randomBytes(4).toString("hex")}`;
}

// ─── prepareManualAction: the binding-local handoff helper ─────────────────

export type ManualActionReason = "login" | "2fa" | "captcha" | "oauth_popup" | "manual_action";

export interface PrepareManualActionArgs {
  /**
   * Test/integration seam. Defaults to `process.env`. The launcher mutates
   * `process.env` directly after a successful patchright launch, so the
   * default is the right thing in production.
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly page: Page;
  readonly reason?: ManualActionReason;
  /**
   * Test seam. Defaults to `resolveStreamingRegistrationFromEnv`, which
   * reads `PDPP_RUN_ID` + `PDPP_REFERENCE_BASE_URL` + a registration token
   * from env and returns a real client. Tests inject a fake to assert the
   * register payload without spinning up a server.
   */
  readonly resolveStreamingRegistration?: (
    env?: NodeJS.ProcessEnv
  ) => Promise<StreamingTargetRegistrationHooks | undefined>;
  /**
   * Test seam. Defaults to `resolveWsUrlForExactPage`. Tests inject a fake
   * so the registration payload can be asserted without a real CDP session.
   */
  readonly resolveWsUrl?: (page: Page, opts: ResolveWsUrlOptions) => Promise<string>;
}

export interface PrepareManualActionResult {
  /** Generated interactionId; the connector then includes this in its INTERACTION envelope. */
  readonly interactionId: string;
  /**
   * `true` if registration succeeded with the reference server. `false`
   * means streaming will fail closed for this interaction — the connector
   * can still emit it, the operator just won't have a working browser
   * stream. The honest failure mode.
   */
  readonly registered: boolean;
}

interface ManualActionPageMetadata {
  readonly pageTitle?: string;
  readonly pageUrl?: string;
}

async function readManualActionPageMetadata(page: Page): Promise<ManualActionPageMetadata> {
  let pageUrl: string | undefined;
  let pageTitle: string | undefined;
  try {
    pageUrl = page.url();
  } catch {
    /* page may have been closed; metadata is optional */
  }
  try {
    pageTitle = await page.title();
  } catch {
    /* page may have been closed; metadata is optional */
  }
  return {
    ...(pageUrl ? { pageUrl } : {}),
    ...(pageTitle ? { pageTitle } : {}),
  };
}

function registerManagedNekoManualActionTarget(args: {
  readonly env: NodeJS.ProcessEnv;
  readonly interactionId: string;
  readonly metadata: ManualActionPageMetadata;
  readonly reason?: ManualActionReason;
  readonly registration: StreamingTargetRegistrationHooks;
}): Promise<boolean> {
  const nekoDescriptor = resolveManagedNekoDescriptorFromEnv(args.env);
  if (!nekoDescriptor) {
    process.stderr.write(
      `[browser-handoff] managed n.eko surface env is incomplete; streaming-companion target not registered for interaction ${args.interactionId}.\n`
    );
    return Promise.resolve(false);
  }
  return args.registration.register({
    backend: "neko",
    runId: args.registration.runId,
    interactionId: args.interactionId,
    descriptor: {
      ...nekoDescriptor,
      ...(args.metadata.pageUrl ? { start_url: args.metadata.pageUrl } : {}),
    },
    ...(args.metadata.pageUrl ? { pageUrl: args.metadata.pageUrl } : {}),
    ...(args.metadata.pageTitle ? { pageTitle: args.metadata.pageTitle } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  });
}

async function resolveCdpWsUrlForManualAction(args: {
  readonly endpoint: ResolvedCdpEndpoint;
  readonly interactionId: string;
  readonly page: Page;
  readonly resolveWsUrl: (page: Page, opts: ResolveWsUrlOptions) => Promise<string>;
}): Promise<string | undefined> {
  try {
    return await args.resolveWsUrl(args.page, args.endpoint);
  } catch (err) {
    // Most common cause: the page closed between the connector deciding it
    // needed manual_action and us reaching the resolver. Fail closed for
    // streaming, return the interactionId so the INTERACTION still emits.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[browser-handoff] could not resolve CDP page-target wsUrl for interaction ${args.interactionId}: ${message}; continuing without streaming.\n`
    );
    return;
  }
}

function registerCdpManualActionTarget(args: {
  readonly interactionId: string;
  readonly metadata: ManualActionPageMetadata;
  readonly reason?: ManualActionReason;
  readonly registration: StreamingTargetRegistrationHooks;
  readonly wsUrl: string;
}): Promise<boolean> {
  return args.registration.register({
    runId: args.registration.runId,
    interactionId: args.interactionId,
    wsUrl: args.wsUrl,
    ...(args.metadata.pageUrl ? { pageUrl: args.metadata.pageUrl } : {}),
    ...(args.metadata.pageTitle ? { pageTitle: args.metadata.pageTitle } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  });
}

/**
 * Prepare a browser handoff for a `manual_action` interaction.
 *
 * Generates an interactionId, resolves the CDP page-target wsUrl for the
 * exact `Page`, and registers `(runId, interactionId) -> wsUrl` with the
 * reference server's run-target registry. Returns the interactionId so the
 * caller can include it as the request_id on its INTERACTION envelope.
 *
 * Best-effort by design: if the env isn't wired up for streaming, if the
 * page is closed mid-resolve, or if registration fails over the network,
 * the helper returns `{ registered: false }` rather than throwing. The
 * connector run continues; only streaming for that specific interaction
 * is unavailable.
 */
export async function prepareManualAction(args: PrepareManualActionArgs): Promise<PrepareManualActionResult> {
  const env = args.env ?? process.env;
  const resolveStreamingRegistration = args.resolveStreamingRegistration ?? resolveStreamingRegistrationFromEnv;
  const resolveWsUrl = args.resolveWsUrl ?? resolveWsUrlForExactPage;
  const interactionId = generateInteractionId();

  const registration = await resolveStreamingRegistration(env);
  if (!registration) {
    // No PDPP_RUN_ID + base URL + token combo in env. Streaming is not
    // configured for this run — return the interactionId so the connector
    // can still emit the INTERACTION envelope. The resolver itself logs
    // a hint when PDPP_RUN_ID is set but the rest is missing.
    return { interactionId, registered: false };
  }

  const metadata = await readManualActionPageMetadata(args.page);

  if (isManagedNekoRequired(env)) {
    const ok = await registerManagedNekoManualActionTarget({
      env,
      interactionId,
      metadata,
      registration,
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return { interactionId, registered: ok };
  }

  const endpoint = resolveCdpEndpointFromEnv(env);
  if (!endpoint) {
    process.stderr.write(
      `[browser-handoff] ${BROWSER_CDP_HOST_ENV}/${BROWSER_CDP_PORT_ENV} not set; streaming-companion target not registered for interaction ${interactionId}.\n`
    );
    return { interactionId, registered: false };
  }

  const wsUrl = await resolveCdpWsUrlForManualAction({
    endpoint,
    interactionId,
    page: args.page,
    resolveWsUrl,
  });
  if (!wsUrl) {
    return { interactionId, registered: false };
  }

  const ok = await registerCdpManualActionTarget({
    interactionId,
    metadata,
    registration,
    wsUrl,
    ...(args.reason ? { reason: args.reason } : {}),
  });

  if (!ok) {
    // The registration client itself logged the underlying reason
    // (network error, 401, 4xx, etc). We don't double-log here; just
    // surface the registered=false bit to the caller.
    return { interactionId, registered: false };
  }

  return { interactionId, registered: true };
}

// ─── manualAction: connector-author convenience layer ──────────────────────
//
// Connector authors call `manualAction({ page, message }, sendInteraction)`
// and get the entire flow: handoff prepared, INTERACTION emitted, response
// awaited. They do NOT touch interactionIds, wsUrls, registry endpoints,
// or any CDP machinery — this module hides all of that. They express
// "the human needs to act on this page", as the advisor recommends.

export interface ManualActionArgs extends PrepareManualActionArgs {
  /** Optional fixture capture session; when enabled, captures this exact page before notifying the operator. */
  readonly capture?: CaptureSession | null;
  /** Human-facing prompt the operator sees in the streaming companion / interaction surface. */
  readonly message: string;
  /** Optional schema for the response payload — mirrors INTERACTION.schema. */
  readonly schema?: Record<string, unknown>;
  /** Optional timeout passthrough — mirrors INTERACTION.timeout_seconds. */
  readonly timeoutSeconds?: number;
}

export type SendInteraction = (req: InteractionRequest) => Promise<InteractionResponse>;

function captureManualActionFixture(args: {
  readonly capture?: CaptureSession | null;
  readonly interactionId: string;
  readonly page: Page;
  readonly reason?: ManualActionReason;
}): void {
  if (!args.capture) {
    return;
  }

  try {
    const capture = args.capture.captureDom(
      args.page,
      `manual-action-${args.reason ?? "manual_action"}-${args.interactionId}`
    );
    capture.catch((): undefined => undefined);
  } catch {
    // Fixture capture is diagnostic-only and must never delay or block the operator handoff.
  }
}

/**
 * Convenience wrapper for the manual-action handoff. Prepares the streaming
 * target (so the operator can attach), then emits a `manual_action` INTERACTION
 * envelope through the connector runtime's `sendInteraction` and returns its
 * response.
 *
 * Connector usage:
 *
 *   await manualAction(
 *     { page, message: "Solve the captcha", reason: "captcha" },
 *     sendInteraction
 *   );
 *
 * The two-arg shape (args + sendInteraction) keeps the helper composable
 * without leaking the runtime's emit machinery into `args` (which would
 * make `args` impossible to construct in tests that don't have a runtime).
 */
export async function manualAction(
  args: ManualActionArgs,
  sendInteraction: SendInteraction
): Promise<InteractionResponse> {
  const { interactionId } = await prepareManualAction({
    page: args.page,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.env ? { env: args.env } : {}),
    ...(args.resolveStreamingRegistration ? { resolveStreamingRegistration: args.resolveStreamingRegistration } : {}),
    ...(args.resolveWsUrl ? { resolveWsUrl: args.resolveWsUrl } : {}),
  });
  captureManualActionFixture({
    ...(args.capture ? { capture: args.capture } : {}),
    interactionId,
    page: args.page,
    ...(args.reason ? { reason: args.reason } : {}),
  });

  return await sendInteraction({
    kind: "manual_action",
    request_id: interactionId,
    message: args.message,
    ...(args.schema ? { schema: args.schema } : {}),
    ...(args.timeoutSeconds === undefined ? {} : { timeout_seconds: args.timeoutSeconds }),
  });
}

// ─── Exports for tests ─────────────────────────────────────────────────────

export {
  BROWSER_CDP_HOST_ENV,
  BROWSER_CDP_PORT_ENV,
  BROWSER_SURFACE_ID_ENV,
  BROWSER_SURFACE_LEASE_ID_ENV,
  BROWSER_SURFACE_PROFILE_KEY_ENV,
  BROWSER_SURFACE_REQUIRED_ENV,
  BROWSER_SURFACE_STREAM_BASE_URL_ENV,
};
