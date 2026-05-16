/**
 * Browser-launch primitive for polyfill connectors.
 *
 * Launches a per-connector patchright Chromium with an isolated profile
 * directory. Used by the connector runtime (`connector-runtime.ts`) and by
 * operator-side scripts under `bin/` that need a Chromium context.
 *
 * Profile directories live under `~/.pdpp/profiles/<profileName>/`. Each
 * profile is independent: cookies, localStorage, and "trusted device" state
 * persist across runs of the same connector but never cross between
 * connectors. Concurrent runs across different `profileName`s are safe.
 *
 * Patchright is the patched-Playwright drop-in (replaces rebrowser-playwright
 * 2026-04-21). Importing patchright in the launching module activates the
 * full stealth stack (launch-side + client-side); using stock playwright over
 * CDP would forfeit the client-side layer.
 *
 * Container policy: a HEADED browser inside a container is invisible to the
 * operator. The legacy host-browser bridge that used to bridge that gap is
 * retired (see `openspec/changes/introduce-local-collector-runner`). Headed
 * browser-backed connectors must run in a local collector runtime that
 * advertises a `browser` binding; provider/control-plane runtimes that lack
 * that binding fail spawn before launch via the runtime-capability gate.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, chromium } from "playwright";
import { removeChromiumSingletonResidue, withProfileLockMutex } from "./profile-lock.ts";
import { isRunningInContainer } from "./runtime-environment.ts";

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXTRA_BROWSER_ARGS_RE = /\s+/;

export interface IsolatedBrowser {
  browser: Browser | null;
  context: BrowserContext;
  release: () => Promise<void>;
}

export interface AcquireIsolatedBrowserOptions {
  headless?: boolean;
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
   * When true, the launcher launches Chromium in CDP-port mode
   * (`cdpPort: 0` plus `--remote-debugging-address=127.0.0.1`), reads
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
 * Headed-vs-headless interpretation MUST mirror `acquireIsolatedBrowser`'s
 * effective default. That function destructures `{ headless = false }`,
 * so:
 *
 *   - `headless: true`  → headless (allowed in container)
 *   - `headless: false` → headed   (gate fires in container)
 *   - `headless: undefined` (caller omitted the field) → headed,
 *     because the launcher's default kicks in. A library-direct caller
 *     writing `acquireBrowserForConnector({ profileName })` with no
 *     headless field is asking for a visible browser, and that must
 *     fail closed in a container exactly like `headless: false` does.
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
 * Effective default for the `headless` option, mirroring the
 * destructured default in `acquireIsolatedBrowser` (`headless = false`).
 * If this default ever changes there, change it here in lockstep —
 * keep the gate honest about what the launcher will actually do.
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
  if (inputs.escapeHatchEnabled) {
    return { kind: "warn_and_proceed" };
  }
  return { kind: "fail_closed" };
}

function configuredBrowserChannel(): string | undefined {
  const raw = process.env.PDPP_BROWSER_CHANNEL;
  if (raw === undefined) {
    return;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Patchright/Playwright surfaces a specific error when the requested channel
// binary is not installed on disk — e.g. for `channel: "chrome"`:
//   "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome"
// We use this discriminator to decide whether a launch failure is "Chrome
// just isn't installed" (safe to fall back to bundled Chromium) versus any
// other launch failure (port collision, profile lock, OOM, etc.) which must
// propagate so the operator sees the real problem.
const MISSING_CHROME_INSTALL_RE = /Chromium distribution 'chrome' is not found|Executable doesn't exist.*chrome/i;

function isMissingChromeInstallError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return MISSING_CHROME_INSTALL_RE.test(error.message);
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
 */
async function acquireRemoteCdpBrowser(cdpUrl: string, profileName: string): Promise<IsolatedBrowser> {
  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");
  const attachStartedAt = Date.now();
  process.stderr.write(`[browser-launch] remote CDP attach start profile=${profileName} url=${redactCdpUrl(cdpUrl)}\n`);
  const browser = await localChromium.connectOverCDP(cdpUrl);
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

/**
 * Launch an isolated per-connector browser context with its own profile dir.
 *
 * NOTE: the default profile-name derivation in `connector-runtime.ts` is
 * `profileName = connectorName`, which is single-account by design. When
 * multi-account support ships, switch the derivation to include a stable
 * subject identifier (e.g. `${connectorName}__${subjectId}`) so two accounts
 * on the same platform get independent profile directories.
 */
export async function acquireIsolatedBrowser({
  profileName,
  headless = false,
  streamingEnabled,
  remoteCdpUrl,
}: AcquireIsolatedBrowserOptions): Promise<IsolatedBrowser> {
  if (!(profileName && PROFILE_NAME_RE.test(profileName))) {
    throw new Error("profileName required, must be [A-Za-z0-9_-]+");
  }
  // Remote-CDP attach: skip the entire local-launch path. The remote
  // browser owns its own profile and lifecycle (e.g. the n.eko container);
  // we just attach as a CDP client.
  if (remoteCdpUrl) {
    return acquireRemoteCdpBrowser(remoteCdpUrl, profileName);
  }
  const isolatedDir = join(homedir(), ".pdpp", "profiles", profileName);
  if (!existsSync(isolatedDir)) {
    mkdirSync(isolatedDir, { recursive: true, mode: 0o700 });
  }

  // Patchright "Best Practice" config; do not re-add Chromium flags
  // patchright already manages.
  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");

  // Streaming-registration mode needs Chromium to expose a TCP CDP
  // endpoint (so the streaming companion can connect by URL later) AND
  // write `<userDataDir>/DevToolsActivePort` so we can discover the
  // randomly-assigned port without scraping stderr. We also pin the bind
  // to loopback as defense in depth — the wsUrl path encodes a bearer
  // secret, and we never want it reachable from a non-local listener.
  //
  // The right way to do this through Patchright/Playwright is the
  // `cdpPort` launch option: when set, Patchright pushes
  // `--remote-debugging-port=<port>` AND switches the parent's CDP
  // transport from pipe to WebSocket (server/browserType.js dispatch on
  // `options.cdpPort !== undefined`). It also skips its own
  // `--remote-debugging-pipe` default (server/chromium/chromium.js
  // `defaultArgs` else branch).
  //
  // We CANNOT achieve the same effect by pushing
  // `--remote-debugging-port=0` into `args[]`: Patchright only checks
  // `options.cdpPort` (not the args array) when deciding whether to add
  // `--remote-debugging-pipe`, so Chromium ends up launched with BOTH
  // `--remote-debugging-port=0` AND `--remote-debugging-pipe`, the
  // parent connects over the pipe, and the first CDP command after
  // launch (`Network.setCacheDisabled` from initial page setup) fails
  // with `Internal server error, session closed`. That manifested as
  // `companion_start_failed` for any run that needed streaming.
  //
  // `cdpPort: 0` lets Chromium pick a random free port; we then read
  // it back out of `DevToolsActivePort` for the wsUrl. The
  // `--remote-debugging-address=127.0.0.1` arg is still set explicitly
  // because Patchright doesn't expose a host-binding option.
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
  // Production / Docker / headless-server deployments do not have DISPLAY set
  // and so will not trip this warning.
  if (
    !displayAuthWarningEmitted &&
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
  }

  type PatchrightLaunchOptions = NonNullable<Parameters<typeof localChromium.launchPersistentContext>[1]> & {
    cdpPort?: number;
  };
  const baseLaunchOptions: PatchrightLaunchOptions = {
    headless,
    viewport: null,
    args: baseArgs,
    // `cdpPort: 0` is honored by Patchright (`server/browserType.js`
    // dispatches CDP transport on this; `server/chromium/chromium.js`
    // `defaultArgs` skips `--remote-debugging-pipe` when it is set).
    // Playwright's public `LaunchOptions` typing doesn't surface `cdpPort`,
    // but Patchright's protocol validator accepts it and forwards it.
    ...(streamingEnabled ? { cdpPort: 0 } : {}),
  };

  const explicitChannel = configuredBrowserChannel();
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
    try {
      return await localChromium.launchPersistentContext(isolatedDir, {
        ...baseLaunchOptions,
        channel: "chrome",
      });
    } catch (error) {
      if (!isMissingChromeInstallError(error)) {
        throw error;
      }
      logChromiumFallback();
      return localChromium.launchPersistentContext(isolatedDir, baseLaunchOptions);
    }
  });

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
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    },
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
    if (port == null) {
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
  if (port == null) {
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
  readonly type?: string;
  readonly webSocketDebuggerUrl?: string;
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

let chromiumFallbackLogged = false;
// Module-scope so the DISPLAY-without-XAUTHORITY warning fires once per
// process, not once per browser launch — quiet logs in normal operation.
let displayAuthWarningEmitted = false;

function logChromiumFallback(): void {
  if (chromiumFallbackLogged) {
    return;
  }
  chromiumFallbackLogged = true;
  process.stderr.write(
    "[browser-launch] Real Chrome not installed; falling back to bundled Patchright Chromium. " +
      "For best stealth on the host, run `pnpm --dir packages/polyfill-connectors exec patchright install chrome` " +
      "(or set PDPP_BROWSER_CHANNEL to override).\n"
  );
}

/**
 * Acquire a browser context for connector use.
 *
 * Container policy:
 *   - Headless container acquisitions (`headless: true`) are allowed —
 *     non-interactive scrapes (cookie-based authenticated GETs, headless
 *     fetches that need a Chromium-backed fingerprint) have no operator
 *     interaction surface and are a legitimate Docker workload.
 *   - HEADED in-container acquisitions fail closed with
 *     `HeadedBrowserUnavailableError`. A headed Chromium in a container
 *     is invisible to the operator; an interactive flow (Cloudflare,
 *     OTP) blocks indefinitely on the `auto-login` INTERACTION
 *     handshake with no visible signal. Operators must run the connector
 *     in a local collector runtime instead — see
 *     `bin/collector-runner.ts`.
 *   - Operators who need to escape the gate (e.g., debugging a headed
 *     container browser locally with X11 forwarding) can set
 *     `PDPP_ALLOW_HEADED_CONTAINER_BROWSER=1`. The runtime emits a loud
 *     per-acquisition warning so the override is visible in logs.
 *   - The host-direct path is unaffected — without any container signal,
 *     the runtime uses `acquireIsolatedBrowser` against
 *     `~/.pdpp/profiles/<name>/`.
 */
export async function acquireBrowserForConnector(options: AcquireIsolatedBrowserOptions): Promise<IsolatedBrowser> {
  const gate = decideContainerHeadedBrowserGate({
    headless: options.headless,
    inContainer: isRunningInContainer(),
    escapeHatchEnabled: process.env.PDPP_ALLOW_HEADED_CONTAINER_BROWSER === "1",
    ...(options.remoteCdpUrl ? { remoteCdpUrl: options.remoteCdpUrl } : {}),
  });
  if (gate.kind === "fail_closed") {
    throw new HeadedBrowserUnavailableError({
      message:
        "Headed (visible) browser-backed connector requested in a container with no local collector runtime to render it. " +
        "Run this connector in a local collector runtime that advertises a `browser` binding " +
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

  return await acquireIsolatedBrowser(options);
}
