// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { registerEphemeralOrigin, unregisterEphemeralOrigin } from "../../scripts/hermetic/guard.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { ingestRecord as ingestRecordUntyped } from "../server/records.ts";
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";

const TOP_REGEX_0 = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const TOP_REGEX_1 = /Longview/;
const TOP_REGEX_2 = /top artists/i;

/**
 * `server/index.js` (startServer) and `server/records.js` (ingestRecord) are
 * untyped JS (allowJs, checkJs:false) under server/**, forbidden to touch.
 * Same boundary-cast pattern as run-interaction-stream-routes.test.ts: model
 * the real call/return shapes locally from the source and cast the untyped
 * imports once. `ClosableServer` mirrors that file's shape exactly (this test
 * only reads asPort/asServer/rsPort/rsServer off the result).
 */
interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
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

interface IngestRecordInput {
  data: Record<string, unknown>;
  emitted_at: string;
  key: string;
  stream: string;
}

interface IngestStorageTarget {
  connector_id: string;
  connector_instance_id: string;
}

const ingestRecord = ingestRecordUntyped as unknown as (
  storageTarget: string | IngestStorageTarget,
  record: IngestRecordInput
) => Promise<unknown>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const REPO_ROOT = join(REFERENCE_IMPL_DIR, "..");
const CONSOLE_DIR = join(REPO_ROOT, "apps/console");
const CONSOLE_BUILD_ID_PATH = join(CONSOLE_DIR, ".next/BUILD_ID");
const CONSOLE_PRERENDER_MANIFEST_PATH = join(CONSOLE_DIR, ".next/prerender-manifest.json");
const CONSOLE_STANDALONE_SERVER_PATH = join(CONSOLE_DIR, ".next/standalone/apps/console/server.js");
const OWNER_PASSWORD = "pdpp-owner-dev-password";
const SPOTIFY_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/spotify";
const spotifyConnectorKeyLookup = canonicalConnectorKey(SPOTIFY_CONNECTOR_ID);
assert.ok(spotifyConnectorKeyLookup, `expected a canonical connector key for ${SPOTIFY_CONNECTOR_ID}`);
const SPOTIFY_CONNECTOR_KEY = spotifyConnectorKeyLookup;
const SPOTIFY_DEFAULT_CONNECTION_ID = makeDefaultAccountConnectorInstanceId(
  OWNER_AUTH_DEFAULT_SUBJECT_ID,
  SPOTIFY_CONNECTOR_KEY
);
const SPOTIFY_WORK_CONNECTION_ID = "cin_composed_origin_spotify_work";
const COMPOSED_EXPLORE_RECORD_ID = "artist_owner/top#1";
const HREF_ATTRIBUTE_PATTERN = /href="([^"]+)"/g;
const WORK_RECORD_NAME_RE = /Nils Frahm \(work\)/;
const PERSONAL_RECORD_NAME_RE = /Nils Frahm \(personal\)/;
const CLAUDE_CODE_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/claude-code";

let consoleBuildPromise: Promise<void> | null = null;

async function closeServer(server: ClosableServer) {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();

  const closeWithTimeout = (srv: { close: (cb: () => void) => void }) =>
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

function runCommand(command: string, args: string[], opts: Record<string, unknown> = {}) {
  return new Promise<string>((resolve, reject) => {
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
      } catch {
        // Build artifacts are absent or incomplete; build them below.
      }

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

async function materializeDefaultSpotifyConnection() {
  const now = "2026-04-23T10:00:00.000Z";
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: SPOTIFY_CONNECTOR_KEY,
    connectorInstanceId: SPOTIFY_DEFAULT_CONNECTION_ID,
    createdAt: now,
    displayName: "Spotify",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { kind: "test_account", label: "composed-origin-spotify" },
    sourceBindingKey: "composed-origin-spotify",
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function materializeSpotifyWorkConnection() {
  const now = "2026-04-23T10:00:01.000Z";
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: SPOTIFY_CONNECTOR_KEY,
    connectorInstanceId: SPOTIFY_WORK_CONNECTION_ID,
    createdAt: now,
    displayName: "Spotify - work",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { kind: "test_account", label: "composed-origin-spotify-work" },
    sourceBindingKey: "composed-origin-spotify-work",
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

function emittedHrefsForPath(html: string, origin: string, expectedPath: string): string[] {
  return [...html.matchAll(HREF_ATTRIBUTE_PATTERN)]
    .map((match) => match[1] ?? "")
    .filter((href) => {
      try {
        return new URL(href, origin).pathname === expectedPath;
      } catch {
        return false;
      }
    });
}

async function waitForExistingConsoleBuild(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: polling must observe one filesystem state at a time.
      await assertCompleteConsoleBuild();
      return;
    } catch {
      // Keep polling until the other build completes or the deadline expires.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for another next build process to finish");
}

async function assertCompleteConsoleBuild() {
  await access(CONSOLE_BUILD_ID_PATH);
  await access(CONSOLE_PRERENDER_MANIFEST_PATH);
  await access(CONSOLE_STANDALONE_SERVER_PATH);
}

async function allocatePort() {
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

interface TrappedRequest {
  method: string | undefined;
  url: string;
}

async function startPublicOriginTrap() {
  const requests: TrappedRequest[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url || "/" });
    if ((req.url || "").startsWith("/v1/ingest/")) {
      res.statusCode = 500;
      res.end("public origin must not receive server-side runtime ingest");
      return;
    }
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) {
    throw new Error("Failed to start public origin trap");
  }
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    origin: `http://127.0.0.1:${port}`,
    requests,
  };
}

interface WaitForHttpStatusOptions {
  expectedStatus?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

async function waitForHttpStatus(
  url: string,
  { expectedStatus = 200, headers, timeoutMs = 20_000 }: WaitForHttpStatusOptions = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let lastStatus: number | null = null;
  let lastBody = "";

  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: readiness probes must be sequential retries.
      const resp = await fetch(url, {
        redirect: "manual",
        ...(headers ? { headers } : {}),
      });
      lastStatus = resp.status;
      if (resp.status === expectedStatus) {
        return resp;
      }
      lastBody = await resp.text().catch(() => "");
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const lastErrorMessage = lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(
    `Timed out waiting for ${url} to return HTTP ${expectedStatus}: ${lastErrorMessage}` +
      `\nlastStatus=${lastStatus ?? "none"}` +
      `\nlastBody=${lastBody.slice(0, 500)}`
  );
}

interface StartWebServerOptions {
  asUrl: string;
  rsUrl: string;
  webOrigin: string;
}

async function startWebServer({ webOrigin, asUrl, rsUrl }: StartWebServerOptions) {
  const webUrl = new URL(webOrigin);
  const port = Number.parseInt(webUrl.port, 10);
  const host = webUrl.hostname;
  const child = spawn(process.execPath, [CONSOLE_STANDALONE_SERVER_PATH], {
    cwd: dirname(CONSOLE_STANDALONE_SERVER_PATH),
    env: {
      ...process.env,
      HOSTNAME: host,
      NEXT_TELEMETRY_DISABLED: "1",
      PDPP_AS_URL: asUrl,
      PDPP_OWNER_PASSWORD: OWNER_PASSWORD,
      PDPP_REFERENCE_MODE: "composed",
      PDPP_REFERENCE_ORIGIN: webOrigin,
      PDPP_RS_URL: rsUrl,
      PORT: String(port),
    },
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
  // fetches it in every assertion below. The guard derives authority from
  // in-process binds and does not auto-trust a child's origin (no
  // cross-process inheritance, by design). This is the narrow, explicit
  // exception the guard's contract permits: the test owns this child and
  // configured the exact port it binds (PORT=port above), so it explicitly
  // declares authority for the origin it controls. Registered before the
  // readiness probe (itself a parent→child fetch) and withdrawn on teardown.
  registerEphemeralOrigin(webOrigin);

  try {
    await waitForHttpStatus(`${webOrigin}/owner/login`, { expectedStatus: 200 });
    return { child, getOutput: () => output };
  } catch (error) {
    unregisterEphemeralOrigin(webOrigin);
    child.kill("SIGTERM");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\nWeb server output:\n${output}`, { cause: error });
  }
}

async function stopChildProcess(child: ChildProcessByStdio<null, Readable, Readable>) {
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

function extractCookie(resp: Response) {
  if (typeof resp.headers.getSetCookie === "function") {
    const cookies = resp.headers.getSetCookie();
    const [cookie] = cookies;
    return cookie?.split(";", 1)[0] ?? null;
  }
  const raw = resp.headers.get("set-cookie");
  return raw ? raw.split(";", 1)[0] : null;
}

function getRawSetCookieList(resp: Response) {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: string[], name: string) {
  for (const header of setCookies) {
    const [pair] = header.split(";", 1);
    if (pair?.startsWith(`${name}=`)) {
      return pair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string) {
  const match = html.match(TOP_REGEX_0);
  return match ? match[1] : null;
}

async function fetchJson(url: string, opts: RequestInit = {}) {
  const resp = await fetch(url, opts);
  const body: unknown = await resp.json();
  return { body, resp };
}

interface TimelineEvent {
  event_type: string;
  [key: string]: unknown;
}

interface TimelineBody {
  data: TimelineEvent[];
}

async function waitForRunTerminal(asUrl: string, runId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling must wait for each timeline response before retrying.
    const { resp, body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    const timeline = body as Partial<TimelineBody> | null;
    if (resp.status === 200 && Array.isArray(timeline?.data)) {
      const terminal = timeline.data.find(
        (event) => event.event_type === "run.completed" || event.event_type === "run.failed"
      );
      if (terminal) {
        return timeline as TimelineBody;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function makeClaudeCodeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pdpp-claude-code-ingest-"));
  const claudeHome = join(root, ".claude");
  const projectsDir = join(claudeHome, "projects");
  const projectDir = join(projectsDir, "-home-test-safe-project");
  await mkdir(projectDir, { recursive: true });
  // The Claude Code connector reads .claude/skills and .claude/commands
  // even when empty; create them so the run doesn't fail before exercising
  // the origin-routing behavior this test targets.
  await mkdir(join(claudeHome, "skills"), { recursive: true });
  await mkdir(join(claudeHome, "commands"), { recursive: true });
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const lines = [
    {
      cwd: "/home/user/safe-project",
      entrypoint: "cli",
      gitBranch: "main",
      message: { content: [{ text: "synthetic safe prompt", type: "text" }] },
      sessionId,
      timestamp: "2026-04-24T15:00:00.000Z",
      type: "user",
      userType: "external",
      uuid: "msg-safe-1",
      version: "1.0.0",
    },
    {
      message: { content: [{ text: "synthetic safe response", type: "text" }] },
      sessionId,
      timestamp: "2026-04-24T15:00:01.000Z",
      type: "assistant",
      uuid: "msg-safe-2",
    },
  ];
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return {
    claudeHome,
    cleanup: () => rm(root, { force: true, recursive: true }),
    projectsDir,
  };
}

test("composed controller runs ingest against the internal RS, not the public browser origin", async () => {
  const publicOrigin = await startPublicOriginTrap();
  const fixture = await makeClaudeCodeFixture();
  const manifest = JSON.parse(
    await readFile(join(REPO_ROOT, "packages/polyfill-connectors/manifests/claude_code.json"), "utf8")
  );
  const previousEnv = {
    CLAUDE_CODE_HOME: process.env.CLAUDE_CODE_HOME,
    CLAUDE_CODE_PROJECTS_DIR: process.env.CLAUDE_CODE_PROJECTS_DIR,
  };
  process.env.CLAUDE_CODE_HOME = fixture.claudeHome;
  process.env.CLAUDE_CODE_PROJECTS_DIR = fixture.projectsDir;

  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    referenceMode: "composed",
    referenceOrigin: publicOrigin.origin,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const registerConnector = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerConnector.status, 201);

    const runResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(CLAUDE_CODE_CONNECTOR_ID)}/run`, {
      method: "POST",
    });
    assert.equal(runResp.status, 202);
    const started = (await runResp.json()) as { run_id: string };

    const timeline = await waitForRunTerminal(asUrl, started.run_id);
    const completed = timeline.data.find((event) => event.event_type === "run.completed");
    assert.ok(completed, "Claude Code run should complete using the internal RS URL");
    assert.deepEqual(
      publicOrigin.requests.filter((req) => req.url.startsWith("/v1/ingest/")),
      [],
      "server-side runtime ingest must not traverse the public composed origin"
    );
  } finally {
    if (previousEnv.CLAUDE_CODE_HOME === undefined) {
      delete process.env.CLAUDE_CODE_HOME;
    } else {
      process.env.CLAUDE_CODE_HOME = previousEnv.CLAUDE_CODE_HOME;
    }
    if (previousEnv.CLAUDE_CODE_PROJECTS_DIR === undefined) {
      delete process.env.CLAUDE_CODE_PROJECTS_DIR;
    } else {
      process.env.CLAUDE_CODE_PROJECTS_DIR = previousEnv.CLAUDE_CODE_PROJECTS_DIR;
    }
    await closeServer(server);
    await fixture.cleanup();
    await publicOrigin.close();
  }
});

interface AuthorizationServerMetadataBody {
  device_authorization_endpoint: string;
  issuer: string;
  pushed_authorization_request_endpoint: string;
}

interface DeviceStartBody {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
}

interface OwnerTokenBody {
  access_token: string;
}

interface StreamMetadata {
  name: string;
}

interface StreamListBody {
  data: StreamMetadata[];
}

interface StagedRequestBody {
  authorization_url: string;
  request_uri: string;
}

interface ApprovedGrantBody {
  grant: { source: { id: string; kind: string } };
  token: string;
}

test("composed browser origin carries metadata, owner session, console, device flow, and consent end to end", async () => {
  await ensureConsoleBuild();
  const webPort = await allocatePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const spotifyManifest = JSON.parse(await readFile(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));

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
  const webServer = await startWebServer({ asUrl, rsUrl, webOrigin });

  try {
    const metadata = await fetchJson(`${webOrigin}/.well-known/oauth-authorization-server`);
    assert.equal(metadata.resp.status, 200);
    const metadataBody = metadata.body as AuthorizationServerMetadataBody;
    assert.equal(metadataBody.issuer, webOrigin);
    assert.equal(metadataBody.device_authorization_endpoint, `${webOrigin}/oauth/device_authorization`);
    assert.equal(metadataBody.pushed_authorization_request_endpoint, `${webOrigin}/oauth/par`);

    const consoleGate = await fetch(`${webOrigin}/`, { redirect: "manual" });
    assert.equal(consoleGate.status, 307);
    assert.equal(consoleGate.headers.get("location"), "/owner/login?return_to=%2F");

    const loginPage = await fetch(`${webOrigin}/owner/login?return_to=%2F`, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(loginPage.status, 200);
    const csrfCookie = findSetCookiePair(getRawSetCookieList(loginPage), "pdpp_owner_csrf");
    const csrfField = extractCsrfFieldValue(await loginPage.text());
    assert.ok(csrfCookie, "owner login GET should issue a CSRF cookie");
    assert.ok(csrfField, "owner login GET should render a CSRF field");

    const loginResp = await fetch(`${webOrigin}/owner/login`, {
      body: new URLSearchParams({
        _csrf: csrfField,
        password: OWNER_PASSWORD,
        return_to: "/",
      }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: csrfCookie,
      },
      method: "POST",
      redirect: "manual",
    });
    assert.ok(
      loginResp.status === 302 || loginResp.status === 303,
      `expected redirect after owner login, got ${loginResp.status}`
    );
    assert.equal(loginResp.headers.get("location"), "/");
    const ownerCookieLookup = extractCookie(loginResp);
    assert.ok(ownerCookieLookup, "owner login should issue a session cookie");
    assert.ok(ownerCookieLookup.startsWith("pdpp_owner_session="), "owner login should issue a session cookie");
    const ownerCookie = ownerCookieLookup;

    const consoleResp = await fetch(`${webOrigin}/`, {
      headers: {
        Cookie: ownerCookie,
      } satisfies Record<string, string>,
    });
    assert.equal(consoleResp.status, 200);
    const consoleHtml = await consoleResp.text();
    assert.ok(!consoleHtml.includes(asUrl), "console should not leak the internal AS origin");
    assert.ok(!consoleHtml.includes(rsUrl), "console should not leak the internal RS origin");

    const registerConnector = await fetch(`${webOrigin}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerConnector.status, 201);

    await materializeDefaultSpotifyConnection();
    await materializeSpotifyWorkConnection();
    await ingestRecord(
      { connector_id: SPOTIFY_CONNECTOR_KEY, connector_instance_id: SPOTIFY_DEFAULT_CONNECTION_ID },
      {
        data: {
          id: COMPOSED_EXPLORE_RECORD_ID,
          name: "Nils Frahm (personal)",
          popularity: 96,
        },
        emitted_at: "2026-04-23T10:00:00Z",
        key: COMPOSED_EXPLORE_RECORD_ID,
        stream: "top_artists",
      }
    );
    await ingestRecord(
      { connector_id: SPOTIFY_CONNECTOR_KEY, connector_instance_id: SPOTIFY_WORK_CONNECTION_ID },
      {
        data: {
          id: COMPOSED_EXPLORE_RECORD_ID,
          name: "Nils Frahm (work)",
          popularity: 96,
        },
        emitted_at: "2026-04-23T10:00:01Z",
        key: COMPOSED_EXPLORE_RECORD_ID,
        stream: "top_artists",
      }
    );
    const exploreResp = await fetch(`${webOrigin}/explore`, {
      headers: { Accept: "text/html", Cookie: ownerCookie },
    });
    assert.equal(exploreResp.status, 200);
    const exploreHtml = await exploreResp.text();
    const encodedRecordId = encodeURIComponent(COMPOSED_EXPLORE_RECORD_ID);
    const connectionPaths = [SPOTIFY_DEFAULT_CONNECTION_ID, SPOTIFY_WORK_CONNECTION_ID].map((connectionId) => ({
      connectionId,
      detailPath: `/sources/${encodeURIComponent(connectionId)}/top_artists/${encodedRecordId}`,
    }));
    for (const { detailPath } of connectionPaths) {
      assert.ok(
        emittedHrefsForPath(exploreHtml, webOrigin, detailPath).length > 0,
        `Explore must emit a record-detail href for ${detailPath}`
      );
    }

    const workDetailPath = connectionPaths[1]?.detailPath;
    assert.ok(workDetailPath, "work connection route should be present");
    const [workDetailHref] = emittedHrefsForPath(exploreHtml, webOrigin, workDetailPath);
    assert.ok(workDetailHref, "Explore should emit the work record href that the journey follows");
    const detailResp = await fetch(new URL(workDetailHref, webOrigin), {
      headers: { Accept: "text/html", Cookie: ownerCookie },
    });
    assert.equal(detailResp.status, 200);
    const detailHtml = await detailResp.text();
    assert.match(detailHtml, WORK_RECORD_NAME_RE, "the composed detail route must render the addressed work record");
    assert.doesNotMatch(
      detailHtml,
      PERSONAL_RECORD_NAME_RE,
      "the record-detail route must not resolve the sibling same-connector account"
    );

    const legacyPath = `/records/${encodeURIComponent(SPOTIFY_WORK_CONNECTION_ID)}/top_artists/${encodedRecordId}`;
    const legacyMutation = await fetch(`${webOrigin}${legacyPath}`, {
      body: "{}",
      headers: { Accept: "text/html", "Content-Type": "application/json", Cookie: ownerCookie },
      method: "POST",
      redirect: "manual",
    });
    assert.ok(
      legacyMutation.status === 404 || legacyMutation.status === 405,
      `legacy ${legacyPath} mutation should fail without a redirect band-aid (got ${legacyMutation.status})`
    );
    assert.equal(legacyMutation.headers.get("location"), null, "legacy /records must not redirect to the new route");

    const deviceStart = await fetchJson(`${webOrigin}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: "pdpp-web-dashboard" }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(deviceStart.resp.status, 200);
    const deviceStartBody = deviceStart.body as DeviceStartBody;
    assert.equal(deviceStartBody.verification_uri, `${webOrigin}/device`);
    assert.match(
      deviceStartBody.verification_uri_complete,
      new RegExp(`^${webOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/device\\?user_code=`)
    );

    const devicePage = await fetch(`${webOrigin}/device?user_code=${encodeURIComponent(deviceStartBody.user_code)}`, {
      headers: {
        Accept: "text/html",
        Cookie: ownerCookie,
      } satisfies Record<string, string>,
      redirect: "manual",
    });
    assert.equal(devicePage.status, 200);
    const deviceCsrfCookie = findSetCookiePair(getRawSetCookieList(devicePage), "pdpp_owner_csrf");
    const deviceCsrfField = extractCsrfFieldValue(await devicePage.text());
    assert.ok(deviceCsrfCookie, "device approval page should issue a CSRF cookie");
    assert.ok(deviceCsrfField, "device approval page should render a CSRF field");

    const approveDevice = await fetch(`${webOrigin}/device/approve`, {
      body: new URLSearchParams({
        _csrf: deviceCsrfField,
        user_code: deviceStartBody.user_code,
      }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `${ownerCookie}; ${deviceCsrfCookie}`,
      },
      method: "POST",
    });
    assert.equal(approveDevice.status, 200);

    const ownerToken = await fetchJson(`${webOrigin}/oauth/token`, {
      body: new URLSearchParams({
        client_id: "pdpp-web-dashboard",
        device_code: deviceStartBody.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(ownerToken.resp.status, 200);
    const ownerTokenBody = ownerToken.body as OwnerTokenBody;
    assert.equal(typeof ownerTokenBody.access_token, "string");

    const streamList = await fetchJson(
      `${webOrigin}/v1/streams?connector_id=${encodeURIComponent(SPOTIFY_CONNECTOR_ID)}`,
      {
        headers: {
          Authorization: `Bearer ${ownerTokenBody.access_token}`,
        },
      }
    );
    assert.equal(streamList.resp.status, 200);
    const streamListBody = streamList.body as StreamListBody;
    assert.ok(
      Array.isArray(streamListBody.data) && streamListBody.data.some((stream) => stream.name === "top_artists"),
      "owner token over the composed origin should reach RS stream metadata"
    );

    const stagedRequest = await fetchJson(`${webOrigin}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "single_use",
            purpose_code: "https://pdpp.dev/purpose/recommendation",
            purpose_description: "Review top artists",
            retention: { max_duration: "P30D", on_expiry: "delete" },
            source: { id: SPOTIFY_CONNECTOR_ID, kind: "connector" },
            streams: [{ instance_ids: [SPOTIFY_DEFAULT_CONNECTION_ID], name: "top_artists" }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_display: { name: "Longview" },
        client_id: "cli_longview",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(stagedRequest.resp.status, 201);
    const stagedRequestBody = stagedRequest.body as StagedRequestBody;
    assert.match(
      stagedRequestBody.authorization_url,
      new RegExp(`^${webOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/consent\\?request_uri=`)
    );

    const consentPage = await fetch(stagedRequestBody.authorization_url, {
      headers: {
        Accept: "text/html",
        Cookie: ownerCookie,
      } satisfies Record<string, string>,
    });
    assert.equal(consentPage.status, 200);
    const consentHtml = await consentPage.text();
    assert.match(consentHtml, TOP_REGEX_1);
    assert.match(consentHtml, TOP_REGEX_2);
    assert.ok(!consentHtml.includes(asUrl), "consent page should not leak the internal AS origin");

    const reviewedGrant = await fetchJson(`${webOrigin}/consent/review`, {
      body: JSON.stringify({ request_uri: stagedRequestBody.request_uri }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: ownerCookie,
      },
      method: "POST",
    });
    assert.equal(reviewedGrant.resp.status, 200);
    const reviewRevision = (reviewedGrant.body as { approval_review_revision?: unknown }).approval_review_revision;
    assert.equal(typeof reviewRevision, "string", "consent review returns a revision");
    const approvedGrant = await fetchJson(`${webOrigin}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: reviewRevision,
        request_uri: stagedRequestBody.request_uri,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: ownerCookie,
      },
      method: "POST",
    });
    assert.equal(approvedGrant.resp.status, 200);
    const approvedGrantBody = approvedGrant.body as ApprovedGrantBody;
    assert.equal(typeof approvedGrantBody.token, "string");
    assert.deepEqual(approvedGrantBody.grant.source, { id: SPOTIFY_CONNECTOR_ID, kind: "connector" });
  } finally {
    // Withdraw the explicit guard handoff granted in startWebServer once the
    // console child is gone, so the port is not implicitly trusted afterward.
    unregisterEphemeralOrigin(webOrigin);
    await stopChildProcess(webServer.child);
    await closeServer(server);
  }
});
