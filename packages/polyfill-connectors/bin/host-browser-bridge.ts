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
 *   - Default bind is 127.0.0.1. This works on macOS and Windows Docker
 *     Desktop because Docker forwards `host.docker.internal` to host
 *     loopback. On Linux Docker, `host.docker.internal:host-gateway`
 *     resolves to the docker bridge IP (typically 172.17.0.1), which is
 *     NOT host loopback — verified empirically. Linux operators MUST
 *     pass `--bind-host=<docker-bridge-ip>` (or
 *     `PDPP_HOST_BRIDGE_BIND_HOST=...`). The startup banner emits a
 *     loud warning when this configuration is wrong.
 *   - Binding 0.0.0.0 is allowed only with `--allow-public-bind` (or
 *     `PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND=1`). Prefer the docker bridge
 *     IP, which limits exposure to local containers.
 *   - Requires a shared-secret token on every WebSocket upgrade. The
 *     token is supplied via `PDPP_HOST_BRIDGE_TOKEN` or generated and
 *     printed at startup.
 *   - Uses dedicated PDPP profiles (`~/.pdpp/profiles/<name>/`) by
 *     default — same root the native runtime uses. Daily Chrome
 *     profile is not supported here; it is documented as an
 *     operator-side escape hatch only and lives outside this CLI.
 *
 * Operator flow (macOS / Windows Docker Desktop):
 *   1. `pnpm --dir packages/polyfill-connectors exec tsx bin/host-browser-bridge.ts --profile chatgpt`
 *      The bridge prints `PDPP_HOST_BROWSER_BRIDGE_URL=ws://host.docker.internal:7670`
 *      and `PDPP_HOST_BROWSER_BRIDGE_TOKEN=<hex>`.
 *   2. Export those into the Compose stack.
 *   3. Trigger a connector run; a real Chrome window opens on the host.
 *   4. Ctrl-C the bridge to close the browser and stop accepting connections.
 *
 * Operator flow (Linux Docker):
 *   1. Discover the docker bridge IP, e.g.
 *        ip -4 addr show docker0 | awk '/inet /{print $2}' | cut -d/ -f1
 *      (typically 172.17.0.1).
 *   2. Start the bridge with `--bind-host=<that-ip>`. The bridge
 *      advertises `PDPP_HOST_BROWSER_BRIDGE_URL=ws://<that-ip>:7670`.
 *   3. Otherwise the same as the macOS/Windows flow.
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
  bindHost: string;
  generatedToken: boolean;
  port: number;
  profile: string;
  token: string;
}

const DEFAULT_BIND_HOST = "127.0.0.1";

// Allowed shapes for --bind-host. We accept only:
//   - 127.0.0.1 / localhost (loopback; the safe default that works
//     unmodified on macOS and Windows Docker Desktop)
//   - any other IPv4 address (operator chose a docker-bridge IP, e.g.
//     172.17.0.1; common for Linux Docker)
//   - 0.0.0.0 (broad bind; only allowed with explicit acknowledgement
//     because it accepts LAN traffic too)
//
// We deliberately do not accept hostnames or IPv6. Operators name a
// numeric IP they got from `ip route show docker0`. Hostnames would
// re-introduce ambiguity about what's actually bound.
const BIND_HOST_RE = /^(\d{1,3}\.){3}\d{1,3}$|^localhost$/;

interface ParsedFlags {
  allowBroadBind: boolean;
  bindHost: string;
  port: number;
  profile: string | undefined;
  token: string;
}

function readFlags(argv: readonly string[]): ParsedFlags {
  const flags: ParsedFlags = {
    allowBroadBind: process.env.PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND === "1",
    bindHost: process.env.PDPP_HOST_BRIDGE_BIND_HOST?.trim() ?? "",
    port: Number(process.env.PDPP_HOST_BRIDGE_PORT ?? "7670"),
    profile: undefined,
    token: process.env.PDPP_HOST_BRIDGE_TOKEN?.trim() ?? "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1] ?? "";
    if (arg === "--profile") {
      flags.profile = next;
      i += 1;
    } else if (arg === "--port") {
      flags.port = Number(next);
      i += 1;
    } else if (arg === "--token") {
      flags.token = next.trim();
      i += 1;
    } else if (arg === "--bind-host") {
      flags.bindHost = next.trim();
      i += 1;
    } else if (arg === "--allow-public-bind") {
      flags.allowBroadBind = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return flags;
}

function dieWith(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function validateBindHost(bindHost: string, allowBroadBind: boolean): string {
  const resolved = bindHost || DEFAULT_BIND_HOST;
  if (!BIND_HOST_RE.test(resolved)) {
    dieWith(2, `error: --bind-host must be an IPv4 address or 'localhost' (got '${resolved}')`);
  }
  if (resolved === "0.0.0.0" && !allowBroadBind) {
    dieWith(
      2,
      "error: --bind-host=0.0.0.0 exposes the bridge on every interface, including the LAN. " +
        "Pass --allow-public-bind (or PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND=1) to acknowledge, " +
        "or pick the specific docker bridge IP (e.g. 172.17.0.1 on Linux)."
    );
  }
  return resolved;
}

function parseArgs(argv: readonly string[]): BridgeOptions {
  const flags = readFlags(argv);

  if (!flags.profile) {
    process.stderr.write("error: --profile <name> is required (e.g. --profile chatgpt)\n\n");
    printUsage();
    process.exit(2);
  }
  if (!Number.isFinite(flags.port) || flags.port <= 0 || flags.port > 65_535) {
    dieWith(2, `error: --port must be a valid TCP port (got ${String(flags.port)})`);
  }

  const bindHost = validateBindHost(flags.bindHost, flags.allowBroadBind);

  const generatedToken = flags.token === "";
  const token = generatedToken ? randomBytes(16).toString("hex") : flags.token;

  return { bindHost, profile: flags.profile, port: flags.port, token, generatedToken };
}

function printUsage(): void {
  process.stderr.write(
    [
      "PDPP Host Browser Bridge",
      "",
      "Usage:",
      "  tsx bin/host-browser-bridge.ts --profile <name> [--port 7670] [--token <secret>] [--bind-host <ip>]",
      "",
      "Options:",
      "  --profile <name>     Profile directory under ~/.pdpp/profiles (required)",
      "  --port <number>      TCP port (default 7670, env PDPP_HOST_BRIDGE_PORT)",
      "  --token <secret>     Shared secret required on every connection (default random, env PDPP_HOST_BRIDGE_TOKEN)",
      "  --bind-host <ip>     IP to bind on (default 127.0.0.1, env PDPP_HOST_BRIDGE_BIND_HOST).",
      "                       On macOS/Windows Docker Desktop, the default works because Docker",
      "                       forwards host.docker.internal to host loopback. On Linux Docker,",
      "                       host.docker.internal resolves to the docker bridge gateway IP, so",
      "                       a 127.0.0.1-only bind is NOT reachable from the container — set",
      "                       --bind-host=172.17.0.1 (or your custom docker bridge IP from",
      "                       `ip -4 addr show docker0`).",
      "  --allow-public-bind  Required to bind 0.0.0.0 (env PDPP_HOST_BRIDGE_ALLOW_PUBLIC_BIND=1).",
      "                       Exposes the bridge on every interface incl. LAN; prefer the bridge IP.",
      "  --help               Show this help",
      "",
    ].join("\n")
  );
}

// ─── Connection guards ─────────────────────────────────────────────────

// Defense-in-depth Host-header allowlist. Token is the primary auth;
// this guard mainly stops DNS-rebinding shapes. Always accept the
// well-known loopback names plus `host.docker.internal` (the standard
// alias from inside Docker), and additionally accept whatever IP the
// bridge actually bound to so an operator on Linux can use the docker
// bridge IP directly.
const STATIC_ALLOWED_HOST_RE = /^(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?$/i;

function isAllowedHostHeader(host: string, boundHost: string): boolean {
  if (STATIC_ALLOWED_HOST_RE.test(host)) {
    return true;
  }
  // Also accept the IP the bridge bound to (e.g. 172.17.0.1 on Linux),
  // with or without a port. We never accept 0.0.0.0 here because that's
  // the listen-everywhere placeholder, never the address a client would
  // legitimately put in their Host header.
  if (boundHost && boundHost !== "0.0.0.0") {
    const escaped = boundHost.replaceAll(".", "\\.");
    const ipRe = new RegExp(`^${escaped}(:\\d+)?$`);
    if (ipRe.test(host)) {
      return true;
    }
  }
  return false;
}

// Narrowed input type: isAuthorized only ever reads `headers`. Tests can
// pass a `Pick<IncomingMessage, "headers">` without forcing a double-cast
// through unknown that the project's no-double-cast hook flags.
type AuthorizableRequest = Pick<IncomingMessage, "headers">;

function isAuthorized(req: AuthorizableRequest, expectedToken: string, boundHost: string): boolean {
  const presented = req.headers["x-pdpp-bridge-token"];
  const presentedString = Array.isArray(presented) ? presented[0] : presented;
  if (typeof presentedString !== "string" || presentedString !== expectedToken) {
    return false;
  }
  const host = req.headers.host;
  if (typeof host !== "string" || !isAllowedHostHeader(host, boundHost)) {
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
// A queued downstream frame, tagged with whether it was a binary or
// text frame. We must preserve this so we can replay it upstream with
// the matching `binary` flag — CDP is JSON-RPC over text frames, but
// nothing in the proxy should depend on that and silently downgrade
// binary frames to text via `as Buffer`.
interface QueuedFrame {
  data: WebSocket.RawData;
  isBinary: boolean;
}

/**
 * Translate a close-event `(code, reason)` pair into arguments safe to
 * pass to `WebSocket.close()`. The wire protocol reserves 1004, 1005,
 * and 1006 as "MUST NOT be sent" status codes — they're synthesized by
 * the receiver when there's no real close frame — and 1015 is similar.
 * Passing any of these to `ws.close()` raises a TypeError. Replace them
 * with 1011 ("internal error") so the proxy stays robust regardless of
 * how either side terminated.
 */
function sanitizeCloseArgs(
  code: number | undefined,
  reason: Buffer | string | undefined,
  fallback: string
): [number, string] {
  const RESERVED_RECEIVE_ONLY = new Set([1004, 1005, 1006, 1015]);
  const isSendable =
    typeof code === "number" &&
    ((code >= 1000 && code <= 1014 && !RESERVED_RECEIVE_ONLY.has(code)) || (code >= 3000 && code <= 4999));
  const safeCode = isSendable ? (code as number) : 1011;
  const safeReason = renderReason(reason, fallback);
  return [safeCode, safeReason];
}

function renderReason(reason: Buffer | string | undefined, fallback: string): string {
  if (reason === undefined) {
    return fallback;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return reason.toString("utf8");
}

function proxyCdpFrames(downstream: WebSocket, upstreamUrl: string): void {
  const upstream = new WebSocket(upstreamUrl);
  let upstreamReady = false;
  const queued: QueuedFrame[] = [];

  upstream.on("open", () => {
    upstreamReady = true;
    for (const msg of queued) {
      upstream.send(msg.data, { binary: msg.isBinary });
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
      downstream.close(...sanitizeCloseArgs(code, reason, "upstream closed"));
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
      queued.push({ data, isBinary });
    }
  });
  downstream.on("close", (code, reason) => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(...sanitizeCloseArgs(code, reason, "downstream closed"));
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

/**
 * Stand up the HTTP+WS proxy layer against a known upstream CDP URL.
 * Split out from `startBridge` so integration tests can exercise the
 * auth and proxy paths against a fake upstream WS without launching
 * Patchright. Returns the bound port (useful when callers pass `0`).
 */
export async function startBridgeServer(args: {
  bindHost: string;
  port: number;
  token: string;
  upstreamUrl: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const httpServer = createServer((_req, res) => {
    // Plain HTTP requests are not part of the bridge contract. Return a
    // small status string instead of leaving them dangling, and explicitly
    // do not echo the token even if presented.
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pdpp-host-browser-bridge\n");
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (!isAuthorized(req, args.token, args.bindHost)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket as Duplex, head, (downstream) => {
      const remote = `${req.socket.remoteAddress ?? "?"}:${String(req.socket.remotePort ?? 0)}`;
      process.stderr.write(`[host-browser-bridge] accepted connection from ${remote}\n`);
      proxyCdpFrames(downstream, args.upstreamUrl);
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(args.port, args.bindHost, () => resolve());
  });

  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : args.port;

  return {
    port: boundPort,
    close: async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

async function startBridge(options: BridgeOptions): Promise<RunningBridge> {
  const { context, cdpUrl } = await launchHostPersistentContext(options.profile);

  // Bind to the operator-chosen host. Default 127.0.0.1 works on
  // macOS/Windows Docker Desktop because Docker forwards
  // host.docker.internal to host loopback. On Linux Docker the
  // operator must set --bind-host to the docker bridge IP (e.g.
  // 172.17.0.1); a 127.0.0.1-only bind there is NOT reachable from
  // the container — verified empirically on Docker 29.4.1.
  const server = await startBridgeServer({
    bindHost: options.bindHost,
    port: options.port,
    token: options.token,
    upstreamUrl: cdpUrl,
  });

  process.stderr.write(buildBanner(options, cdpUrl));

  return {
    close: async () => {
      await server.close();
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Compose the startup banner. Honest about which platforms can use the
 * default loopback bind and which need the docker bridge IP. Pure
 * function so the test suite can assert on its output without spinning
 * up a real bridge.
 */
export function buildBanner(options: BridgeOptions, upstreamUrl: string): string {
  const isLoopbackBind = options.bindHost === "127.0.0.1" || options.bindHost === "localhost";
  const isLinux = process.platform === "linux";
  const lines: string[] = [
    "[host-browser-bridge] ready",
    `[host-browser-bridge] profile: ${options.profile} (~/.pdpp/profiles/${options.profile}/)`,
    `[host-browser-bridge] bind: ${options.bindHost}:${String(options.port)}`,
    `[host-browser-bridge] upstream CDP: ${upstreamUrl}`,
    "",
  ];

  if (isLoopbackBind && isLinux) {
    // The single most likely operator footgun: Linux Docker can't reach
    // a 127.0.0.1-bound bridge via host.docker.internal (verified
    // empirically). Surface this loudly at startup, with a
    // copy-pasteable fix derived from `ip -4 addr show docker0`.
    lines.push(
      "WARNING: --bind-host is 127.0.0.1 on Linux. Containers using",
      "  host.docker.internal will NOT reach this bridge — that name resolves",
      "  to the docker bridge gateway IP (typically 172.17.0.1), not host",
      "  loopback. Restart with --bind-host=<docker-bridge-ip>:",
      "    DOCKER_BRIDGE_IP=$(ip -4 addr show docker0 | awk '/inet /{print $2}' | cut -d/ -f1)",
      '    --bind-host="$DOCKER_BRIDGE_IP"',
      ""
    );
  }

  const containerSideHost = isLoopbackBind ? "host.docker.internal" : options.bindHost;
  lines.push(
    "Export these into your Compose environment:",
    `  export PDPP_HOST_BROWSER_BRIDGE_URL=ws://${containerSideHost}:${String(options.port)}`,
    `  export PDPP_HOST_BROWSER_BRIDGE_TOKEN=${options.token}${options.generatedToken ? "  # generated" : ""}`,
    ""
  );

  if (isLoopbackBind) {
    lines.push(
      "On Linux Compose, also set in the connector service (already in docker-compose.yml):",
      '  extra_hosts: ["host.docker.internal:host-gateway"]',
      ""
    );
  }

  lines.push(
    "Verify a container can reach the bridge:",
    "  docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl:latest \\",
    `    curl -sf -H "x-pdpp-bridge-token: <wrong-token>" ${containerSideHost.startsWith("172.") || containerSideHost.startsWith("10.") || containerSideHost.startsWith("192.") ? "http" : "http"}://${containerSideHost}:${String(options.port)}/ \\`,
    "    && echo OK || echo UNREACHABLE",
    "  (200 OK on the HTTP root means TCP reachability; an HTTP 401 on a WS",
    "   upgrade with the wrong token means the auth path is wired up.)",
    "",
    "Press Ctrl-C to stop the bridge (closes the host browser).",
    ""
  );

  return lines.join("\n");
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
export { isAllowedHostHeader, isAuthorized, parseArgs };
