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
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, chromium } from "playwright";
import {
  HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  hostBrowserBridgeUnavailableMessage,
  resolveHostBrowserBridgeConfig,
} from "./host-browser-bridge-config.ts";
import { isRunningInContainer } from "./runtime-environment.ts";

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface IsolatedBrowser {
  browser: Browser | null;
  context: BrowserContext;
  release: () => Promise<void>;
}

export interface AcquireIsolatedBrowserOptions {
  headless?: boolean;
  profileName: string;
}

/**
 * Failure surfaced when the runtime is configured to use the host
 * browser bridge but the bridge is unreachable, mismatched, or
 * misconfigured. Carries the stable `code` the dashboard uses to
 * render the deployment-config error state. See
 * `openspec/changes/design-host-browser-bridge-for-docker/design.md` §
 * Failure Mode.
 */
export class HostBrowserBridgeUnavailableError extends Error {
  readonly code: typeof HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE;
  readonly bridgeUrl: string | null;

  constructor(args: { message: string; bridgeUrl: string | null }) {
    super(args.message);
    this.name = "HostBrowserBridgeUnavailableError";
    this.code = HOST_BROWSER_BRIDGE_UNAVAILABLE_CODE;
    this.bridgeUrl = args.bridgeUrl;
  }
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
 * Launch an isolated per-connector browser context with its own profile dir.
 *
 * NOTE: the default profile-name derivation in `connector-runtime.ts` is
 * `profileName = connectorName`, which is single-account by design. When
 * multi-account support ships, switch the derivation to include a stable
 * subject identifier (e.g. `${connectorName}__${subjectId}`) so two accounts
 * on the same platform get independent profile directories. See
 * `openspec/changes/retire-browser-daemon` for the spec requirement.
 */
export async function acquireIsolatedBrowser({
  profileName,
  headless = false,
}: AcquireIsolatedBrowserOptions): Promise<IsolatedBrowser> {
  if (!(profileName && PROFILE_NAME_RE.test(profileName))) {
    throw new Error("profileName required, must be [A-Za-z0-9_-]+");
  }
  const isolatedDir = join(homedir(), ".pdpp", "profiles", profileName);
  if (!existsSync(isolatedDir)) {
    mkdirSync(isolatedDir, { recursive: true, mode: 0o700 });
  }

  // Patchright "Best Practice" config from the upstream README:
  //   chromium.launchPersistentContext(dir, {
  //     channel: "chrome", headless: false, viewport: null
  //   })
  // and: "do NOT add custom browser headers or userAgent." Patchright also
  // manages its own Chromium-flag set (adds `--disable-blink-features=
  // AutomationControlled`; removes `--enable-automation`,
  // `--disable-popup-blocking`, `--disable-component-update`,
  // `--disable-default-apps`, `--disable-extensions`); do not re-add those.
  //
  // patchright exports `chromium` whose runtime shape matches playwright's
  // (patchright is built as a drop-in replacement) but whose declared types
  // live in patchright-core's own module namespace, making them nominally
  // distinct from playwright's. We suppress the type mismatch rather than
  // double-cast — @ts-expect-error is self-healing if patchright ever
  // re-exports playwright-core's types directly.
  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");

  // Prefer Patchright's recommended real Chrome channel. If no Chrome install
  // exists on a host checkout, fall back to the bundled Chromium installed by
  // package postinstall so first-run local development still works. A non-empty
  // PDPP_BROWSER_CHANNEL is a strict operator override and does not fall back —
  // an operator who set the env clearly intends a specific binary; silent
  // fallback would hide real misconfiguration.
  const baseLaunchOptions: Parameters<typeof localChromium.launchPersistentContext>[1] = {
    headless,
    viewport: null,
    args: [
      // Workaround for microsoft/playwright#40158: headed Chrome's download
      // bubble races Playwright's CDP-based download interception. The
      // patchright README does not document `args` overrides, but absence of
      // this flag actively breaks multi-file downloads (USAA).
      "--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3",
    ],
  };

  const explicitChannel = configuredBrowserChannel();
  let context: BrowserContext;
  if (explicitChannel) {
    // Strict override: do not catch missing-binary errors here.
    context = await localChromium.launchPersistentContext(isolatedDir, {
      ...baseLaunchOptions,
      channel: explicitChannel,
    });
  } else {
    // Auto-detect: try real Chrome first, fall back to bundled Chromium only
    // when patchright reports the Chrome binary is not installed.
    try {
      context = await localChromium.launchPersistentContext(isolatedDir, {
        ...baseLaunchOptions,
        channel: "chrome",
      });
    } catch (error) {
      if (!isMissingChromeInstallError(error)) {
        throw error;
      }
      logChromiumFallback();
      context = await localChromium.launchPersistentContext(isolatedDir, baseLaunchOptions);
    }
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

let chromiumFallbackLogged = false;

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

// ─── Host bridge acquisition ───────────────────────────────────────────

/**
 * Acquire a browser by attaching to a host-side PDPP browser bridge over
 * CDP. Used when the connector runs in Docker and a visible host browser
 * is required. The bridge owns the persistent context against
 * `~/.pdpp/profiles/<profile>/` on the host; this function only attaches
 * to the bridge's CDP endpoint via Patchright's `connectOverCDP`. See
 * `bin/host-browser-bridge.ts` for the host side and
 * `openspec/changes/design-host-browser-bridge-for-docker/design.md`.
 */
export async function acquireRemoteHostBrowser(args: {
  bridgeUrl: string;
  bridgeToken: string;
}): Promise<IsolatedBrowser> {
  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");

  let browser: Browser;
  try {
    browser = await localChromium.connectOverCDP(args.bridgeUrl, {
      // The host bridge enforces the shared-secret token on the WS
      // upgrade. CDP connections accept arbitrary upgrade headers via
      // the `headers` option. We send a stable header name the bridge
      // recognizes; rejecting the connection there is what produces a
      // clean "unauthenticated" failure rather than a dangling socket.
      headers: { "x-pdpp-bridge-token": args.bridgeToken },
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new HostBrowserBridgeUnavailableError({
      bridgeUrl: args.bridgeUrl,
      message: hostBrowserBridgeUnavailableMessage({ url: args.bridgeUrl, cause }),
    });
  }

  // The bridge launches its persistent context first, so attaching via
  // CDP gives us back at least one default context. We use that — every
  // page in it shares the host profile by construction.
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    // Defensive: this should never happen because the bridge launches a
    // persistent context before accepting connections. If it does, we
    // surface the same error code so the dashboard treats it uniformly.
    await browser.close().catch(() => {
      /* ignore */
    });
    throw new HostBrowserBridgeUnavailableError({
      bridgeUrl: args.bridgeUrl,
      message: `Host browser bridge at ${args.bridgeUrl} returned no contexts; the bridge may have started without a persistent context.`,
    });
  }

  return {
    context,
    browser,
    release: async (): Promise<void> => {
      // Closing the CDP-attached browser detaches us from the host
      // browser without closing it on the host side. The host bridge
      // owns the host-browser lifecycle.
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// ─── Router ────────────────────────────────────────────────────────────

/**
 * Acquire a browser context for connector use, picking between the
 * native isolated launcher and the host browser bridge based on
 * environment variables.
 *
 * Routing:
 *   - If PDPP_HOST_BROWSER_BRIDGE_URL is set, the runtime attaches to
 *     the host bridge via `acquireRemoteHostBrowser`.
 *   - If the bridge is configured but malformed (missing token,
 *     non-ws URL), this throws `HostBrowserBridgeUnavailableError` so
 *     the run fails fast rather than silently launching an invisible
 *     in-container browser.
 *   - If the bridge is unconfigured AND the runtime is in a container,
 *     this throws `HostBrowserBridgeUnavailableError` rather than
 *     launching an invisible in-container Chromium. This is the
 *     fail-closed gate required by
 *     `openspec/changes/design-host-browser-bridge-for-docker/design.md`
 *     § "Failure Mode When Unavailable". The host-direct path is
 *     unaffected — without any container signal, the runtime still
 *     uses `acquireIsolatedBrowser` against `~/.pdpp/profiles/<name>/`.
 *   - Otherwise, the runtime uses `acquireIsolatedBrowser` against
 *     `~/.pdpp/profiles/<profileName>/` exactly as before.
 */
export async function acquireBrowserForConnector(options: AcquireIsolatedBrowserOptions): Promise<IsolatedBrowser> {
  const resolution = resolveHostBrowserBridgeConfig(process.env);

  if (resolution.mode === "misconfigured") {
    throw new HostBrowserBridgeUnavailableError({
      bridgeUrl: null,
      message: `Host browser bridge is misconfigured: ${resolution.reason}`,
    });
  }

  if (resolution.mode === "configured") {
    if (resolution.config.dailyChromeAcknowledged) {
      // Loud per-acquisition warning: the operator opted into pointing
      // the bridge at a host Chrome that may be their daily profile.
      // The dashboard surfaces this on the run page; we duplicate it on
      // stderr so it lands in container logs too.
      process.stderr.write(
        "[browser-launch] PDPP_HOST_BROWSER_BRIDGE_DAILY_CHROME=1 — connecting to a host browser " +
          "the operator has acknowledged may be their daily Chrome profile. Trust posture is non-default.\n"
      );
    }
    return await acquireRemoteHostBrowser({
      bridgeUrl: resolution.config.url,
      bridgeToken: resolution.config.token,
    });
  }

  // resolution.mode === "disabled" — bridge env vars are empty.
  //
  // When the runtime is in a container, an empty bridge URL is the
  // silent-fallback path that produces an invisible headed Chromium
  // inside the container. Fail closed with the same typed error code
  // the dashboard already renders for misconfigured/unreachable
  // bridges, so an operator gets one consistent diagnostic across all
  // bridge-failure modes instead of a multi-minute hang on the
  // `auto-login` interaction handshake.
  if (isRunningInContainer()) {
    throw new HostBrowserBridgeUnavailableError({
      bridgeUrl: null,
      message:
        "Browser-backed connector requested in a container with no host browser bridge configured. " +
        "Set PDPP_HOST_BROWSER_BRIDGE_URL and PDPP_HOST_BROWSER_BRIDGE_TOKEN to point at a running host bridge " +
        "(`pnpm --dir packages/polyfill-connectors exec tsx bin/host-browser-bridge.ts --profile <name>`), " +
        "or run the connector outside the container so the host-direct launcher can open a visible browser. " +
        "See README.md § 'Browser-backed connectors in Docker' for the platform-specific setup.",
    });
  }

  return await acquireIsolatedBrowser(options);
}
