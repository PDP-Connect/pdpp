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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, chromium } from "playwright";
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
}: AcquireIsolatedBrowserOptions): Promise<IsolatedBrowser> {
  if (!(profileName && PROFILE_NAME_RE.test(profileName))) {
    throw new Error("profileName required, must be [A-Za-z0-9_-]+");
  }
  const isolatedDir = join(homedir(), ".pdpp", "profiles", profileName);
  if (!existsSync(isolatedDir)) {
    mkdirSync(isolatedDir, { recursive: true, mode: 0o700 });
  }

  // Patchright "Best Practice" config; do not re-add Chromium flags
  // patchright already manages.
  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");

  const baseLaunchOptions: Parameters<typeof localChromium.launchPersistentContext>[1] = {
    headless,
    viewport: null,
    args: [
      // Workaround for microsoft/playwright#40158: headed Chrome's download
      // bubble races Playwright's CDP-based download interception.
      "--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3",
    ],
  };

  const explicitChannel = configuredBrowserChannel();
  let context: BrowserContext;
  if (explicitChannel) {
    context = await localChromium.launchPersistentContext(isolatedDir, {
      ...baseLaunchOptions,
      channel: explicitChannel,
    });
  } else {
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
  });
  if (gate.kind === "fail_closed") {
    throw new HeadedBrowserUnavailableError({
      message:
        "Headed (visible) browser-backed connector requested in a container with no local collector runtime to render it. " +
        "Run this connector in a local collector runtime that advertises a `browser` binding " +
        "(`pnpm --dir packages/polyfill-connectors exec tsx bin/collector-runner.ts`), " +
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
