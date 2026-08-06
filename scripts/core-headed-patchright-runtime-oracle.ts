#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production-image oracle for Core's local browser runtime.
 *
 * This deliberately checks properties that a headless-shell substitution could
 * not satisfy: the managed X display is live, the launched process is the
 * full Patchright Chromium binary, the browser owns the deployment profile,
 * the interaction-scoped CDP target is registered and removed, and the same
 * profile survives a browser release/reacquire cycle.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  prepareBrowserInteractionTarget,
  unregisterBrowserInteractionTarget,
} from "../packages/polyfill-connectors/src/browser-handoff.ts";
import { acquireBrowserForConnector } from "../packages/polyfill-connectors/src/browser-launch.ts";
import {
  BROWSER_HEADLESS_ENV,
  resolveBrowserRuntimeVisibility,
} from "../packages/polyfill-connectors/src/connector-runtime.ts";

const PROFILE_NAME = "core-headed-patchright-oracle";
const RUN_ID = "run_core_oracle";
const INTERACTION_ID = "int_core_oracle";
const REGISTRATION_TOKEN = "core-headed-patchright-oracle-token";
const PERSISTENCE_MARKER = "core-headed-patchright-runtime-oracle.completed";
const STORAGE_KEY = "core-headed-patchright-oracle";
const STORAGE_VALUE = "headed-patchright-oracle-v1";
const REGISTRATION_PATH = `/admin/runs/${RUN_ID}/interactions/${INTERACTION_ID}/streaming-target`;
const NUMERIC_PID_RE = /^\d+$/u;
const DISPLAY_RE = /^:\d+$/u;
const PATCHRIGHT_ENTRY_RE = /patchright/u;
const PATCHRIGHT_VERSION_RE = /^\d+\.\d+\.\d+$/u;
const CHROMIUM_PRODUCT_RE = /Chrome|Chromium/u;
const HEADLESS_PRODUCT_RE = /HeadlessChrome|headless_shell|chrome-headless-shell/iu;
const FULL_CHROMIUM_COMMAND_RE = /\/opt\/patchright-browsers\/[^\s]+\/chrome-(?:linux64|linux)\/chrome(?:\s|$)/u;
const HEADLESS_COMMAND_RE = /chromium_headless_shell|chrome-headless-shell|--headless(?:[=\s]|$)/iu;
const CDP_WS_URL_RE = /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\//u;

interface CapturedRegistration {
  readonly authenticated: boolean;
  readonly body: Record<string, unknown> | null;
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

interface OracleServer {
  readonly activeRegistrationPaths: Set<string>;
  readonly baseUrl: string;
  readonly requests: CapturedRegistration[];
  readonly server: Server;
}

function fail(message: string): never {
  throw new Error(`[core-runtime-oracle] ${message}`);
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function responseJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseRegistrationBody(rawBody: string): {
  readonly body: Record<string, unknown> | null;
  readonly valid: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    return {
      body,
      valid: typeof body?.ws_url === "string" && CDP_WS_URL_RE.test(body.ws_url),
    };
  } catch {
    return { body: null, valid: false };
  }
}

function resolveRegistrationStatus(args: {
  readonly activeRegistrationPaths: Set<string>;
  readonly authenticated: boolean;
  readonly bodyIsValid: boolean;
  readonly method: "DELETE" | "PUT";
  readonly path: string;
}): number {
  if (!args.authenticated) {
    return 401;
  }
  if (args.method === "PUT") {
    return args.bodyIsValid ? 200 : 400;
  }
  return args.activeRegistrationPaths.has(args.path) ? 200 : 404;
}

async function handleOracleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedRegistration[],
  activeRegistrationPaths: Set<string>
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const { method } = request;
  if (path === "/oracle-page") {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Core headed Patchright oracle</title><main>oracle</main>");
    return;
  }
  if (path !== REGISTRATION_PATH || (method !== "PUT" && method !== "DELETE")) {
    responseJson(response, 404, { error: "not_found" });
    return;
  }
  const parsed = method === "PUT" ? parseRegistrationBody(await readRequestBody(request)) : { body: null, valid: true };
  const { body, valid: bodyIsValid } = parsed;
  const authenticated = request.headers.authorization === `Bearer ${REGISTRATION_TOKEN}`;
  const status = resolveRegistrationStatus({
    activeRegistrationPaths,
    authenticated,
    bodyIsValid,
    method,
    path,
  });
  if (status === 200) {
    if (method === "PUT") {
      activeRegistrationPaths.add(path);
    } else {
      activeRegistrationPaths.delete(path);
    }
  }
  requests.push({
    authenticated,
    body,
    method,
    path,
    status,
  });
  responseJson(response, status, status === 200 ? { ok: true } : { error: "registration_rejected" });
}

async function startOracleServer(): Promise<OracleServer> {
  const requests: CapturedRegistration[] = [];
  const activeRegistrationPaths = new Set<string>();
  const server = createServer((request, response) =>
    handleOracleRequest(request, response, requests, activeRegistrationPaths).catch((error: unknown) => {
      responseJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    })
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assertCondition(address && typeof address !== "string", "oracle HTTP server did not expose a TCP address");
  return { activeRegistrationPaths, baseUrl: `http://127.0.0.1:${String(address.port)}`, requests, server };
}

async function closeOracleServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function processCommandLines(): string[] {
  const lines: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!NUMERIC_PID_RE.test(entry)) {
      continue;
    }
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`).toString("utf8").split("\0").filter(Boolean).join(" ");
      if (command) {
        lines.push(command);
      }
    } catch {
      // Processes can disappear between readdir and readFileSync.
    }
  }
  return lines;
}

function profileCommands(profileDir: string): string[] {
  return processCommandLines().filter((command) => command.includes(profileDir));
}

function assertManagedDisplay(): string {
  assert.equal(process.env.PDPP_RUNTIME_BROWSER, "1", "Core image did not advertise PDPP_RUNTIME_BROWSER=1");
  const display = process.env.DISPLAY?.trim();
  assertCondition(display && DISPLAY_RE.test(display), "Core supervisor did not inject a managed DISPLAY");
  const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
  assertCondition(existsSync(socket), `managed Xvfb socket is missing: ${socket}`);
  assertCondition(
    processCommandLines().some((command) =>
      new RegExp(`(?:^|\\s)(?:/usr/bin/)?Xvfb\\s+${display}(?:\\s|$)`, "u").test(command)
    ),
    `no Xvfb process owns ${display}`
  );
  return display;
}

function profileDirectory(): string {
  const root = process.env.PDPP_BROWSER_PROFILE_ROOT?.trim() || join(homedir(), ".pdpp", "profiles");
  return join(root, PROFILE_NAME);
}

function assertPatchrightRuntime(): void {
  const require = createRequire(join("/app/packages/polyfill-connectors", "package.json"));
  const entry = require.resolve("patchright");
  assert.match(entry, PATCHRIGHT_ENTRY_RE, "the runtime did not resolve the Patchright package");
  const manifest = JSON.parse(readFileSync("/app/packages/polyfill-connectors/package.json", "utf8")) as {
    dependencies?: Record<string, unknown>;
  };
  assert.match(String(manifest.dependencies?.patchright ?? ""), PATCHRIGHT_VERSION_RE);
}

interface BrowserVersionPage {
  context: () => {
    newCDPSession: (page: unknown) => Promise<{
      detach: () => Promise<void>;
      send: (method: string) => Promise<unknown>;
    }>;
  };
}

async function assertBrowserVersion(page: unknown): Promise<void> {
  const browserPage = page as BrowserVersionPage;
  const session = await browserPage.context().newCDPSession(page);
  try {
    const version = (await session.send("Browser.getVersion")) as { product?: string; userAgent?: string };
    const product = `${version.product ?? ""} ${version.userAgent ?? ""}`;
    assert.doesNotMatch(product, HEADLESS_PRODUCT_RE, "Chromium reports a headless product");
    assert.match(product, CHROMIUM_PRODUCT_RE, "CDP did not report a Chromium browser product");
  } finally {
    await session.detach();
  }
}

function assertFullChromiumProcess(profileDir: string): void {
  const commands = profileCommands(profileDir);
  assertCondition(commands.length > 0, "no live Chromium process references the persistent profile");
  assertCondition(
    commands.some((command) => FULL_CHROMIUM_COMMAND_RE.test(command)),
    `profile process is not the full bundled Chromium binary: ${commands.join(" | ")}`
  );
  assertCondition(
    commands.every((command) => !HEADLESS_COMMAND_RE.test(command)),
    `profile process contains a headless shell or headless flag: ${commands.join(" | ")}`
  );
}

function assertPersistedProfileFiles(profileDir: string): void {
  assertCondition(
    [join(profileDir, "Preferences"), join(profileDir, "Default", "Preferences")].some((path) => existsSync(path)),
    "persistent profile has no Chromium Preferences file after release"
  );
}

async function waitForActiveProfile(profileDir: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(join(profileDir, "DevToolsActivePort")) && profileCommands(profileDir).length > 0) {
      assertFullChromiumProcess(profileDir);
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: this is a bounded filesystem/process readiness poll for the oracle
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(`persistent profile did not become active with DevToolsActivePort: ${profileDir}`);
}

async function waitForProfileShutdown(profileDir: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (profileCommands(profileDir).length === 0 && !existsSync(join(profileDir, "SingletonLock"))) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: this is a bounded process-cleanup poll for the oracle
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(`browser lifecycle cleanup left profile processes or SingletonLock: ${profileCommands(profileDir).join(" | ")}`);
}

async function main(): Promise<void> {
  assert.equal(
    process.env[BROWSER_HEADLESS_ENV],
    undefined,
    "the headed oracle must run without PDPP_BROWSER_HEADLESS=1"
  );
  const display = assertManagedDisplay();
  const visibility = resolveBrowserRuntimeVisibility({ profileName: PROFILE_NAME }, PROFILE_NAME, process.env);
  assert.deepEqual(visibility, {
    envKey: BROWSER_HEADLESS_ENV,
    headless: false,
    profileName: PROFILE_NAME,
  });
  assertPatchrightRuntime();

  const profileDir = profileDirectory();
  const persistenceMarker = join(profileDir, PERSISTENCE_MARKER);
  if (process.env.PDPP_CORE_RUNTIME_ORACLE_EXPECT_PERSISTED === "1") {
    assertCondition(existsSync(persistenceMarker), "profile did not survive the production-container restart");
    assert.equal(readFileSync(persistenceMarker, "utf8"), "Core runtime oracle completed\n");
    assertPersistedProfileFiles(profileDir);
  }

  const oracleServer = await startOracleServer();
  process.env.PDPP_RUN_ID = RUN_ID;
  process.env.PDPP_REFERENCE_BASE_URL = oracleServer.baseUrl;
  process.env.PDPP_STREAMING_REGISTRATION_TOKEN = REGISTRATION_TOKEN;

  try {
    const first = await acquireBrowserForConnector({ profileName: PROFILE_NAME, streamingEnabled: true });
    try {
      const page = first.context.pages()[0] ?? (await first.context.newPage());
      await page.goto(`${oracleServer.baseUrl}/oracle-page`, { waitUntil: "domcontentloaded" });
      assert.equal(await page.title(), "Core headed Patchright oracle");
      await page.evaluate(({ key, value }: { key: string; value: string }) => localStorage.setItem(key, value), {
        key: STORAGE_KEY,
        value: STORAGE_VALUE,
      });
      await waitForActiveProfile(profileDir);
      await assertBrowserVersion(page);

      const registration = await prepareBrowserInteractionTarget({
        interactionId: INTERACTION_ID,
        page,
      });
      assert.equal(registration.registered, true, "direct-CDP streaming target registration failed");
      const put = oracleServer.requests.find((request) => request.method === "PUT");
      assertCondition(put, "stream registration server received no PUT");
      assert.equal(put.path, REGISTRATION_PATH);
      assert.equal(put.status, 200, "stream registration server accepted only a valid authenticated PUT");
      assert.equal(put.authenticated, true, "stream registration did not carry the bearer credential");
      assert.match(String(put.body?.ws_url ?? ""), CDP_WS_URL_RE);

      assert.equal(
        await unregisterBrowserInteractionTarget({ interactionId: INTERACTION_ID }),
        true,
        "direct-CDP streaming target cleanup failed"
      );
      const deletion = oracleServer.requests.find((request) => request.method === "DELETE");
      assertCondition(deletion, "stream registration server received no DELETE");
      assert.equal(deletion.path, REGISTRATION_PATH);
      assert.equal(deletion.status, 200, "stream cleanup server accepted only an active authenticated DELETE");
      assert.equal(deletion.authenticated, true, "stream cleanup did not carry the bearer credential");
      assert.equal(oracleServer.activeRegistrationPaths.size, 0, "stream target remained active after unregister");
    } finally {
      await first.release();
    }
    await waitForProfileShutdown(profileDir);
    assertPersistedProfileFiles(profileDir);

    const second = await acquireBrowserForConnector({ profileName: PROFILE_NAME, streamingEnabled: true });
    try {
      const page = second.context.pages()[0] ?? (await second.context.newPage());
      await page.goto(`${oracleServer.baseUrl}/oracle-page`, { waitUntil: "domcontentloaded" });
      // Read-only assertion: this second container never writes STORAGE_VALUE.
      // Seeing it here proves the mounted profile, not a repeated setup step.
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY),
        STORAGE_VALUE,
        "persistent profile state did not survive browser release/reacquire"
      );
      await waitForActiveProfile(profileDir);
      await assertBrowserVersion(page);
    } finally {
      await second.release();
    }
    await waitForProfileShutdown(profileDir);
    assertPersistedProfileFiles(profileDir);
    assert.equal(oracleServer.activeRegistrationPaths.size, 0, "stream target remained active at oracle shutdown");
    writeFileSync(persistenceMarker, "Core runtime oracle completed\n", { mode: 0o600 });
    console.log(
      `[core-runtime-oracle] PASS display=${display} profile=${profileDir} stream=registered-and-cleaned restart=persistent`
    );
  } finally {
    await closeOracleServer(oracleServer.server);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
