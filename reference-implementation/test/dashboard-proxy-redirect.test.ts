// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pins the proxy-layer owner-console auth gate in apps/console/src/proxy.ts.
//
// Before this gate existed, hitting the owner console without an owner session
// could surface a raw 401 from the data layer (the layout/page
// render race documented in the proxy file's header comment). The proxy
// now performs an optimistic cookie-presence check and 307-redirects
// unauthenticated browsers to `/owner/login?return_to=...` before any
// server component renders.
//
// What this test pins for the production standalone server:
//   1. GET /                  (no cookie) -> 307 to /owner/login?return_to=%2F
//   2. GET /sources/spotify   (no cookie) -> 307 to ...?return_to=%2Fsources%2Fspotify
//   3. The redirect carries X-Robots-Tag: noindex, nofollow
// The production standalone server defaults the operator console to redirecting
// unauthenticated owner-console navigations even when the password is only held
// by the AS. Local-dev opt-out policy is covered by apps/console's pure proxy
// policy tests; this integration test pins the production BFF behavior.
//
// The test uses the same composed-origin spawn pattern as
// `composed-origin.test.js` because the proxy is owned by the operator-console
// process while the authoritative owner-console DAL gate is owned by the AS.

import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerEphemeralOrigin, unregisterEphemeralOrigin } from "../../scripts/hermetic/guard.ts";
import { startServer as startServerUntyped } from "../server/index.ts";

/**
 * `server/index.js` (startServer) is untyped JS (allowJs, checkJs:false)
 * under server/**, forbidden to touch. Same boundary-cast pattern as
 * run-interaction-stream-routes.test.ts: model the real call/return shapes
 * locally from the source and cast the untyped import once, rather than
 * fighting incomplete structural inference at every call site.
 */
interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
}

interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  ownerAuthPassword?: string;
  quiet?: boolean;
  referenceMode?: string;
  referenceOrigin?: string;
  rsPort?: number;
}

const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const REPO_ROOT = join(REFERENCE_IMPL_DIR, "..");
const CONSOLE_DIR = join(REPO_ROOT, "apps/console");
const CONSOLE_BUILD_ID_PATH = join(CONSOLE_DIR, ".next/BUILD_ID");
const CONSOLE_PRERENDER_MANIFEST_PATH = join(CONSOLE_DIR, ".next/prerender-manifest.json");
const CONSOLE_STANDALONE_SERVER_PATH = join(CONSOLE_DIR, ".next/standalone/apps/console/server.js");
const OWNER_PASSWORD = "pdpp-owner-dev-password";

let consoleBuildPromise: Promise<void> | undefined;

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();

  const closeWithTimeout = (srv: ClosableServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);

      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });

  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

function runCommand(
  command: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          `Command failed: ${command} ${args.join(" ")}\n` +
            `exit=${code ?? "null"} signal=${signal ?? "none"}\n${output}`
        )
      );
    });
  });
}

async function ensureConsoleBuild() {
  if (!consoleBuildPromise) {
    consoleBuildPromise = (async () => {
      try {
        await assertCompleteConsoleBuild();
        return;
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}

      try {
        await runCommand("pnpm", ["--dir", "apps/console", "build"], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            NEXT_TELEMETRY_DISABLED: "1",
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("Another next build process is already running")) {
          await waitForExistingConsoleBuild();
          return;
        }
        throw error;
      }
    })();
  }
  await consoleBuildPromise;
}

async function waitForExistingConsoleBuild(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await assertCompleteConsoleBuild();
      return;
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for another next build process to finish");
}

async function assertCompleteConsoleBuild() {
  await access(CONSOLE_BUILD_ID_PATH);
  await access(CONSOLE_PRERENDER_MANIFEST_PATH);
  await access(CONSOLE_STANDALONE_SERVER_PATH);
}

async function allocatePort(): Promise<number> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) {
    throw new Error("Failed to allocate an ephemeral port");
  }
  return port;
}

async function waitForHttpStatus(
  url: string,
  { expectedStatus = 200, timeoutMs = 20_000 }: { expectedStatus?: number; timeoutMs?: number } = {}
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let lastStatus: number | null = null;
  let lastBody = "";

  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      const resp = await fetch(url, { redirect: "manual" });
      lastStatus = resp.status;
      if (resp.status === expectedStatus) {
        return resp;
      }
      lastBody = await resp.text().catch(() => "");
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }

  const lastErrorMessage = lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(
    `Timed out waiting for ${url} to return HTTP ${expectedStatus}: ${lastErrorMessage}` +
      `\nlastStatus=${lastStatus ?? "none"}` +
      `\nlastBody=${lastBody.slice(0, 500)}`
  );
}

// Mirrors composed-origin.test.js's startWebServer while keeping the web
// process env explicit. The production standalone server redirects logged-out
// dashboard navigations by default; the password is still passed here so the
// AS and web process match the self-hosted operator-console shape.
async function startWebServer({
  webOrigin,
  asUrl,
  rsUrl,
  ownerPassword,
}: {
  webOrigin: string;
  asUrl: string;
  rsUrl: string;
  ownerPassword: string;
}): Promise<{ child: ChildProcessByStdio<null, Readable, Readable>; getOutput: () => string }> {
  const webUrl = new URL(webOrigin);
  const port = Number.parseInt(webUrl.port, 10);
  const host = webUrl.hostname;

  // Build a clean env: copy the parent env, then explicitly delete
  // PDPP_OWNER_PASSWORD before optionally re-setting it. This keeps the
  // test honest even if the runner inherits secrets from a developer shell.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOSTNAME: host,
    NEXT_TELEMETRY_DISABLED: "1",
    PDPP_AS_URL: asUrl,
    PDPP_REFERENCE_MODE: "composed",
    PDPP_REFERENCE_ORIGIN: webOrigin,
    PDPP_RS_URL: rsUrl,
    PORT: String(port),
  };
  childEnv.PDPP_OWNER_PASSWORD = undefined;
  if (typeof ownerPassword === "string" && ownerPassword.length > 0) {
    childEnv.PDPP_OWNER_PASSWORD = ownerPassword;
  }

  const child = spawn(process.execPath, [CONSOLE_STANDALONE_SERVER_PATH], {
    cwd: dirname(CONSOLE_STANDALONE_SERVER_PATH),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  child.on("error", (error) => {
    output += `\n[spawn error] ${error.message}`;
  });

  // EXPLICIT TEST-OWNED HANDOFF for the hermetic network guard (see
  // scripts/hermetic/guard.ts). The console web server binds `webOrigin` in
  // THIS spawned child process, but the parent test process is the one that
  // fetches it below and in every assertion. The guard derives authority from
  // in-process binds, so a child's bound origin is not auto-trusted by the
  // parent — by design (no cross-process inheritance). This is the narrow,
  // explicit exception the guard's contract permits: the test owns this child
  // and configured the exact port it binds (PORT=webPort above), so it
  // explicitly declares authority for the origin it controls. Registered
  // before the readiness probe (which is itself a parent→child fetch) and
  // withdrawn when the child is torn down.
  registerEphemeralOrigin(webOrigin);

  // `/owner/login` is always reachable through the proxy regardless of
  // the owner-auth flag — same readiness probe used by composed-origin.test.js.
  try {
    await waitForHttpStatus(`${webOrigin}/owner/login`, { expectedStatus: 200 });
    return { child, getOutput: () => output };
  } catch (error) {
    unregisterEphemeralOrigin(webOrigin);
    child.kill("SIGTERM");
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/style/useErrorCause: the test double intentionally throws the original error shape.
    throw new Error(`${message}\n\nWeb server output:\n${output}`);
  }
}

async function stopChildProcess(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      resolve();
    }, 3000);

    child.once("exit", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

test("proxy redirects unauthenticated clean owner-console hits to /owner/login when owner-auth is enabled", async (t) => {
  await ensureConsoleBuild();
  const webPort = await allocatePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: OWNER_PASSWORD,
    quiet: true,
    referenceMode: "composed",
    referenceOrigin: webOrigin,
    rsPort: 0,
  });
  const asUrl = `http://127.0.0.1:${server.asPort}`;
  const rsUrl = `http://127.0.0.1:${server.rsPort}`;
  const webServer = await startWebServer({
    asUrl,
    ownerPassword: OWNER_PASSWORD,
    rsUrl,
    webOrigin,
  });

  try {
    await t.test("GET / with no cookie -> 307 to /owner/login?return_to=%2F", async () => {
      const resp = await fetch(`${webOrigin}/`, { redirect: "manual" });
      assert.equal(resp.status, 307, "expected proxy-issued 307 redirect, not a 200/401/500");
      assert.equal(resp.headers.get("location"), "/owner/login?return_to=%2F");
    });

    await t.test("GET /sources/spotify with no cookie -> 307 with deep return_to", async () => {
      const resp = await fetch(`${webOrigin}/sources/spotify`, { redirect: "manual" });
      assert.equal(resp.status, 307);
      assert.equal(resp.headers.get("location"), "/owner/login?return_to=%2Fsources%2Fspotify");
    });

    await t.test("redirect carries X-Robots-Tag: noindex, nofollow", async () => {
      const resp = await fetch(`${webOrigin}/`, { redirect: "manual" });
      assert.equal(resp.status, 307);
      assert.equal(resp.headers.get("x-robots-tag"), "noindex, nofollow");
    });
  } finally {
    // Withdraw the explicit guard handoff granted in startWebServer once the
    // console child is gone, so the port is not implicitly trusted afterward.
    unregisterEphemeralOrigin(webOrigin);
    await stopChildProcess(webServer.child);
    await closeServer(server);
  }
});
