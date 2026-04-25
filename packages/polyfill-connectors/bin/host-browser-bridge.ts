#!/usr/bin/env node
/**
 * PDPP Host Browser Bridge
 *
 * A small host-side process that owns a Patchright `launchPersistentContext`
 * against `~/.pdpp/profiles/<profile>/` and exposes the resulting browser's
 * CDP endpoint over loopback for a Dockerized connector runtime to attach
 * to via `chromium.connectOverCDP()`.
 *
 * Spec: openspec/changes/design-host-browser-bridge-for-docker/design.md
 *
 * Security posture:
 *   - Binds 127.0.0.1 only (never 0.0.0.0).
 *   - Requires a shared-secret token on every WebSocket upgrade. The
 *     token is supplied via `PDPP_HOST_BRIDGE_TOKEN` or generated and
 *     printed at startup.
 *   - Uses dedicated PDPP profiles (`~/.pdpp/profiles/<name>/`) by
 *     default — same root the native runtime uses. Daily Chrome
 *     profile is not supported here; it is documented as an
 *     operator-side escape hatch only and lives outside this CLI.
 *
 * Operator flow:
 *   1. `pnpm --dir packages/polyfill-connectors exec tsx bin/host-browser-bridge.ts --profile chatgpt`
 *      The bridge prints:
 *        PDPP_HOST_BROWSER_BRIDGE_URL=ws://host.docker.internal:7670
 *        PDPP_HOST_BROWSER_BRIDGE_TOKEN=<random-32-hex>
 *   2. Export those into the Compose stack.
 *   3. Trigger a connector run; a real Chrome window opens on the host.
 *   4. Ctrl-C the bridge to close the browser and stop accepting
 *      connections.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { BrowserContext, chromium } from "playwright";
import { WebSocket, WebSocketServer } from "ws";
import { isMainModule } from "../src/is-main-module.ts";

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MISSING_CHROME_INSTALL_RE = /Chromium distribution 'chrome' is not found|Executable doesn't exist.*chrome/i;

// ─── Argv parsing ──────────────────────────────────────────────────────

interface BridgeOptions {
  generatedToken: boolean;
  port: number;
  profile: string;
  token: string;
}

function parseArgs(argv: readonly string[]): BridgeOptions {
  let profile: string | undefined;
  let port = Number(process.env.PDPP_HOST_BRIDGE_PORT ?? "7670");
  let token = process.env.PDPP_HOST_BRIDGE_TOKEN?.trim() ?? "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      profile = argv[i + 1];
      i += 1;
    } else if (arg === "--port") {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--token") {
      token = (argv[i + 1] ?? "").trim();
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  if (!profile) {
    process.stderr.write("error: --profile <name> is required (e.g. --profile chatgpt)\n\n");
    printUsage();
    process.exit(2);
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    process.stderr.write(`error: --port must be a valid TCP port (got ${String(port)})\n`);
    process.exit(2);
  }

  let generatedToken = false;
  if (!token) {
    token = randomBytes(16).toString("hex");
    generatedToken = true;
  }

  return { profile, port, token, generatedToken };
}

function printUsage(): void {
  process.stderr.write(
    [
      "PDPP Host Browser Bridge",
      "",
      "Usage:",
      "  tsx bin/host-browser-bridge.ts --profile <name> [--port 7670] [--token <secret>]",
      "",
      "Options:",
      "  --profile <name>   Profile directory under ~/.pdpp/profiles (required)",
      "  --port <number>    TCP port to bind on 127.0.0.1 (default 7670, env PDPP_HOST_BRIDGE_PORT)",
      "  --token <secret>   Shared secret required on every connection (default random, env PDPP_HOST_BRIDGE_TOKEN)",
      "  --help             Show this help",
      "",
    ].join("\n")
  );
}

// ─── Connection guards ─────────────────────────────────────────────────

const ALLOWED_HOST_HEADER_RE = /^(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?$/i;

// Narrowed input type: isAuthorized only ever reads `headers`. Tests can
// pass a `Pick<IncomingMessage, "headers">` without forcing a double-cast
// through unknown that the project's no-double-cast hook flags.
type AuthorizableRequest = Pick<IncomingMessage, "headers">;

function isAuthorized(req: AuthorizableRequest, expectedToken: string): boolean {
  const presented = req.headers["x-pdpp-bridge-token"];
  const presentedString = Array.isArray(presented) ? presented[0] : presented;
  if (typeof presentedString !== "string" || presentedString !== expectedToken) {
    return false;
  }
  const host = req.headers.host;
  if (typeof host !== "string" || !ALLOWED_HOST_HEADER_RE.test(host)) {
    return false;
  }
  return true;
}

// ─── WebSocket reverse proxy ───────────────────────────────────────────

/**
 * Proxy a CDP WebSocket connection from the connector (downstream) to
 * the host browser's CDP endpoint (upstream). Forwards binary and text
 * frames in both directions. Closes the other side when either end
 * closes or errors. Patchright runs on both ends so launch-side and
 * client-side stealth are preserved end-to-end.
 */
function proxyCdpFrames(downstream: WebSocket, upstreamUrl: string): void {
  const upstream = new WebSocket(upstreamUrl);
  let upstreamReady = false;
  const queued: (Buffer | string)[] = [];

  upstream.on("open", () => {
    upstreamReady = true;
    for (const msg of queued) {
      upstream.send(msg);
    }
    queued.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (downstream.readyState === WebSocket.OPEN) {
      downstream.send(data, { binary: isBinary });
    }
  });
  upstream.on("close", (code, reason) => {
    if (downstream.readyState === WebSocket.OPEN) {
      downstream.close(code === 1006 ? 1011 : code, reason);
    }
  });
  upstream.on("error", (err) => {
    process.stderr.write(`[host-browser-bridge] upstream error: ${err.message}\n`);
    if (downstream.readyState === WebSocket.OPEN) {
      downstream.close(1011, "upstream error");
    }
  });

  downstream.on("message", (data, isBinary) => {
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      // Buffer until upstream completes its handshake. CDP clients
      // typically send commands as soon as they connect; without this
      // queue the first message is lost.
      queued.push(data as Buffer);
    }
  });
  downstream.on("close", (code, reason) => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(code, reason);
    }
  });
  downstream.on("error", () => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(1011, "downstream error");
    }
  });
}

// ─── Bridge server ─────────────────────────────────────────────────────

interface RunningBridge {
  close: () => Promise<void>;
}

/**
 * Launch a Patchright persistent context with the same shape
 * `acquireIsolatedBrowser` uses, plus `--remote-debugging-port=0` so
 * Chromium writes the chosen port to `<userDataDir>/DevToolsActivePort`
 * after binding. The bridge reads that file to discover the upstream
 * CDP WebSocket URL — `Browser` returned by `launchPersistentContext`
 * does not expose `wsEndpoint()`, so this is the supported way to get
 * a CDP endpoint out of a persistent context.
 *
 * Profile path matches the native runtime's convention so a single
 * profile root works for both. Stealth options match
 * `acquireIsolatedBrowser` exactly so the two paths share posture by
 * construction.
 */
async function launchHostPersistentContext(profileName: string): Promise<{
  context: BrowserContext;
  cdpUrl: string;
}> {
  if (!PROFILE_NAME_RE.test(profileName)) {
    throw new Error("--profile must match [A-Za-z0-9_-]+");
  }
  const profileDir = join(homedir(), ".pdpp", "profiles", profileName);
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  }

  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");

  // Mirror acquireIsolatedBrowser's shape, plus --remote-debugging-port=0
  // so Chromium picks an ephemeral port and writes it to
  // <profileDir>/DevToolsActivePort. Real Chrome is preferred per
  // Patchright's recommendation; the bundled Chromium is the documented
  // fallback when Chrome is not installed.
  const args = [
    "--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3",
    "--remote-debugging-port=0",
    // Bind the debugging socket to loopback only. Without this flag
    // Chromium may bind 0.0.0.0 on some platforms.
    "--remote-debugging-address=127.0.0.1",
  ];
  const launchOptions = {
    headless: false,
    viewport: null,
    args,
  } as const;

  let context: BrowserContext;
  try {
    context = await localChromium.launchPersistentContext(profileDir, {
      ...launchOptions,
      channel: "chrome",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!MISSING_CHROME_INSTALL_RE.test(message)) {
      throw err;
    }
    process.stderr.write(
      "[host-browser-bridge] Real Chrome not installed; falling back to bundled Patchright Chromium.\n"
    );
    context = await localChromium.launchPersistentContext(profileDir, launchOptions);
  }

  // Chromium writes "<port>\n<browser-target-path>" to DevToolsActivePort
  // immediately after the debugger binds. Poll briefly because the
  // persistent-context promise resolves before the file appears in some
  // builds; bound the wait so a misbehaving launch fails fast rather
  // than hanging the operator.
  const portFile = join(profileDir, "DevToolsActivePort");
  const cdpUrl = await readDevToolsActivePort(portFile);
  return { context, cdpUrl };
}

async function readDevToolsActivePort(portFile: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(portFile, "utf8");
      const [portLine, browserPath] = raw.split("\n");
      const port = Number(portLine);
      if (Number.isFinite(port) && port > 0 && browserPath?.startsWith("/devtools/browser/")) {
        return `ws://127.0.0.1:${String(port)}${browserPath}`;
      }
    } catch (err) {
      lastError = err as Error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Could not read CDP endpoint from ${portFile}: ${lastError?.message ?? "timed out"}`);
}

async function startBridge(options: BridgeOptions): Promise<RunningBridge> {
  const { context, cdpUrl } = await launchHostPersistentContext(options.profile);
  const upstreamUrl = cdpUrl;

  const httpServer = createServer((_req, res) => {
    // Plain HTTP requests are not part of the bridge contract. Return a
    // small status string instead of leaving them dangling, and explicitly
    // do not echo the token even if presented.
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pdpp-host-browser-bridge\n");
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (!isAuthorized(req, options.token)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket as Duplex, head, (downstream) => {
      const remote = `${req.socket.remoteAddress ?? "?"}:${String(req.socket.remotePort ?? 0)}`;
      process.stderr.write(`[host-browser-bridge] accepted connection from ${remote}\n`);
      proxyCdpFrames(downstream, upstreamUrl);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    // Bind to loopback only. host.docker.internal resolves to a host
    // gateway interface that, by Docker's design, is reachable from
    // containers but not from the LAN. Loopback bind is still correct
    // because the gateway delivers packets to the host's loopback.
    httpServer.listen(options.port, "127.0.0.1", () => resolve());
  });

  process.stderr.write(
    [
      "[host-browser-bridge] ready",
      `[host-browser-bridge] profile: ${options.profile} (~/.pdpp/profiles/${options.profile}/)`,
      `[host-browser-bridge] upstream CDP: ${upstreamUrl}`,
      "",
      "Export these into your Compose environment:",
      `  export PDPP_HOST_BROWSER_BRIDGE_URL=ws://host.docker.internal:${String(options.port)}`,
      `  export PDPP_HOST_BROWSER_BRIDGE_TOKEN=${options.token}${options.generatedToken ? "  # generated" : ""}`,
      "",
      "On Linux Compose, ensure the connector service has:",
      '  extra_hosts: ["host.docker.internal:host-gateway"]',
      "",
      "Press Ctrl-C to stop the bridge (closes the host browser).",
      "",
    ].join("\n")
  );

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = `${reason}\n`;
  const message = [
    `HTTP/1.1 ${String(status)} ${reason}`,
    "Connection: close",
    "Content-Type: text/plain",
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    "",
    body,
  ].join("\r\n");
  socket.write(message);
  socket.destroy();
}

// ─── Entrypoint ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const bridge = await startBridge(options);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`\n[host-browser-bridge] received ${signal}, shutting down\n`);
    try {
      await bridge.close();
    } catch (err) {
      process.stderr.write(
        `[host-browser-bridge] error during shutdown: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch(() => {
      /* swallowed: shutdown already best-effort */
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => {
      /* swallowed: shutdown already best-effort */
    });
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[host-browser-bridge] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
}

// Exports for unit tests; do not consume from production code paths.
export { isAuthorized, parseArgs };
