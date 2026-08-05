#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Built-Core friend journey acceptance gate.
//
// This is deliberately one live, fail-closed command rather than a collection
// of source-regex assertions. It exercises the rendered Core routes, owner
// session, SQLite/semantic diagnostics, scoped MCP query, restart durability,
// and the browser/CDP runtime in one run. Provider account credentials are not
// accepted as command-line flags: a successful setup form is not evidence that
// Gmail or an arbitrary source has actually collected data.
//
// Usage:
//   pnpm friend-journey:acceptance -- \
//     --origin http://127.0.0.1:3019 \
//     --owner-password "$PDPP_OWNER_PASSWORD" \
//     --container pdpp-friend-semantic-c663e6383 \
//     --semantic-query "durable local database"
//
// The command exits 1 for any blocker. A container is optional for partial
// HTTP evidence, but omitting it creates explicit browser-CDP and restart
// blockers instead of silently downgrading the acceptance contract.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { establishOwnerSessionCookie } from "./lib/owner-session.ts";
import { mintOwnerToken, runLiveSmoke } from "./railway-mcp-query-smoke.ts";

const execFileAsync = promisify(execFile);
const TRAILING_SLASH_PATTERN = /\/$/;
const DEFAULT_SEMANTIC_QUERY = "durable local database";
const FRIEND_SEED_SUBJECT = "friend-readiness-gate";
const SEMANTIC_FIXTURE_CONNECTOR_ID = "friend-semantic-full";
const SEMANTIC_FIXTURE_MANIFEST_URI = "https://registry.pdpp.org/connectors/friend-semantic-full";
const SEMANTIC_FIXTURE_STREAM = "playlists";
const FORM_PATTERN = /<form\b/i;
const SITE_ASSERTIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["durable SQLite", /sqlite/i],
  ["semantic search", /semantic\s+search/i],
  ["bundled browser/direct CDP", /\bcdp\b/i],
  ["Gmail", /gmail/i],
  ["public hosted HTTPS boundary", /publicly reachable HTTPS|hosted[^.]{0,80}HTTPS/i],
];

type CheckStatus = "pass" | "blocker";

interface Check {
  evidence: string;
  id: string;
  label: string;
  status: CheckStatus;
}

interface ParsedArgs {
  container?: string;
  help?: boolean;
  json: boolean;
  origin?: string;
  ownerPassword?: string;
  semanticQuery: string;
  siteOrigin?: string;
}

interface ResponseBody {
  json: unknown;
  text: string;
}

interface GateContext {
  diagnostics: Record<string, unknown> | null;
  origin: string;
  ownerCookie: string;
  ownerToken: string;
}

class GateBlocker extends Error {}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: exhaustive CLI parser keeps every gate input visible at the command boundary.
function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { json: false, semanticQuery: DEFAULT_SEMANTIC_QUERY };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--origin") {
      i += 1;
      const value = argv[i];
      if (value !== undefined) {
        args.origin = value;
      }
    } else if (arg === "--owner-password") {
      i += 1;
      const value = argv[i];
      if (value !== undefined) {
        args.ownerPassword = value;
      }
    } else if (arg === "--container") {
      i += 1;
      const value = argv[i];
      if (value !== undefined) {
        args.container = value;
      }
    } else if (arg === "--semantic-query") {
      i += 1;
      args.semanticQuery = argv[i] ?? DEFAULT_SEMANTIC_QUERY;
    } else if (arg === "--site-origin") {
      i += 1;
      const value = argv[i];
      if (value !== undefined) {
        args.siteOrigin = value;
      }
    } else if (arg?.startsWith("--origin=")) {
      args.origin = arg.slice("--origin=".length);
    } else if (arg?.startsWith("--owner-password=")) {
      args.ownerPassword = arg.slice("--owner-password=".length);
    } else if (arg?.startsWith("--container=")) {
      args.container = arg.slice("--container=".length);
    } else if (arg?.startsWith("--semantic-query=")) {
      args.semanticQuery = arg.slice("--semantic-query=".length) || DEFAULT_SEMANTIC_QUERY;
    } else if (arg?.startsWith("--site-origin=")) {
      args.siteOrigin = arg.slice("--site-origin=".length);
    }
    i += 1;
  }
  return args;
}

const USAGE = `Usage: pnpm friend-journey:acceptance -- --origin <core-origin> [options]

Options:
  --origin <url>              Built Core origin (or PDPP_FRIEND_ORIGIN).
  --owner-password <secret>   Owner password (or PDPP_OWNER_PASSWORD).
  --container <name>          Explicit Core container for CDP + restart probes
                              (or PDPP_FRIEND_CONTAINER).
  --semantic-query <text>     Query requiring a semantic result (default:
                              "${DEFAULT_SEMANTIC_QUERY}").
  --site-origin <url>         Public docs/reference origin to probe (or
                              PDPP_FRIEND_SITE_ORIGIN).
  --json                      Emit machine-readable results.
  -h, --help                  Show this help.

Exit codes: 0 = every asserted step passed; 1 = one or more blockers;
2 = usage error.`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedRecord(value: unknown, ...keys: string[]): Record<string, unknown> | null {
  let current = value;
  for (const key of keys) {
    const record = asRecord(current);
    current = record?.[key];
  }
  return asRecord(current);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function summarizeBody(body: ResponseBody): string {
  const compact = body.text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

async function readBody(response: Response): Promise<ResponseBody> {
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // HTML routes are intentionally checked as text.
  }
  return { json, text };
}

function request(origin: string, route: string, init: RequestInit = {}, cookie = ""): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Accept", headers.get("Accept") ?? "text/html, application/json");
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  return fetch(`${origin}${route}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(20_000),
  });
}

async function requireStatus(
  context: GateContext,
  route: string,
  expected: number,
  cookie = context.ownerCookie,
  init: RequestInit = {}
): Promise<ResponseBody> {
  const response = await request(context.origin, route, init, cookie);
  const body = await readBody(response);
  if (response.status !== expected) {
    throw new GateBlocker(`${route} returned HTTP ${response.status}; expected ${expected}. ${summarizeBody(body)}`);
  }
  return body;
}

async function runCheck(
  checks: Check[],
  id: string,
  label: string,
  probe: () => string | Promise<string>
): Promise<void> {
  try {
    checks.push({ id, label, status: "pass", evidence: await probe() });
  } catch (error) {
    const evidence = error instanceof Error ? error.message : String(error);
    checks.push({ id, label, status: "blocker", evidence });
  }
}

async function waitForCore(origin: string, attempt = 0): Promise<void> {
  try {
    const response = await request(origin, "/", { redirect: "manual" }, "");
    if (response.status === 200 || response.status === 307 || response.status === 308) {
      return;
    }
  } catch {
    // The container may still be replacing the process.
  }
  if (attempt >= 59) {
    throw new GateBlocker("Core did not become reachable within 60 seconds after restart");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return waitForCore(origin, attempt + 1);
}

async function waitForOwnerGate(origin: string, attempt = 0): Promise<void> {
  try {
    const response = await request(
      origin,
      "/_ref/deployment",
      { redirect: "manual", headers: { Accept: "application/json" } },
      ""
    );
    if (response.status === 401) {
      return;
    }
  } catch {
    // The owner route may still be waiting for the reference process.
  }
  if (attempt >= 59) {
    throw new GateBlocker("Core owner-gated diagnostics did not settle to HTTP 401 within 60 seconds after restart");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return waitForOwnerGate(origin, attempt + 1);
}

async function runCdpProbe(container: string): Promise<string> {
  const cdpScript = `
    import { chromium } from "patchright";
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("data:text/html,<title>PDPP CDP probe</title>");
      const cdp = await context.newCDPSession(page);
      const version = await cdp.send("Browser.getVersion");
      const evaluation = await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
      console.log(JSON.stringify({ browser: version.product, protocol: version.protocolVersion, title: evaluation.result?.value ?? evaluation.result?.result?.value }));
    } finally {
      await browser.close();
    }
  `;
  const result = await execFileAsync(
    "docker",
    ["exec", "-w", "/app/packages/polyfill-connectors", container, "node", "--input-type=module", "-e", cdpScript],
    { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }
  );
  const line = result.stdout
    .trim()
    .split("\n")
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
  if (!line) {
    throw new GateBlocker(
      `bundled browser/CDP probe returned no JSON: ${result.stdout.trim()} ${result.stderr.trim()}`
    );
  }
  const probe = asRecord(JSON.parse(line));
  if (!probe) {
    throw new GateBlocker(`bundled browser/CDP probe returned incomplete evidence: ${line}`);
  }
  const browser = stringValue(probe.browser);
  const protocol = stringValue(probe.protocol);
  if (!(browser && protocol) || probe.title !== "PDPP CDP probe") {
    throw new GateBlocker(`bundled browser/CDP probe returned incomplete evidence: ${line}`);
  }
  return `Patchright Chromium ${browser}; CDP protocol ${protocol}; Runtime.evaluate + Emulation.setDeviceMetricsOverride passed`;
}

async function runSemanticSearch(context: GateContext, query: string): Promise<string> {
  const token =
    context.ownerToken ||
    (await mintOwnerToken(context.origin, context.ownerCookie, FRIEND_SEED_SUBJECT, () => undefined));
  context.ownerToken = token;
  const response = await request(
    context.origin,
    `/v1/search/semantic?q=${encodeURIComponent(query)}&limit=10`,
    { headers: { Authorization: `Bearer ${token}` } },
    ""
  );
  const body = await readBody(response);
  if (response.status !== 200) {
    throw new GateBlocker(`semantic search returned HTTP ${response.status}: ${summarizeBody(body)}`);
  }
  const payload = asRecord(body.json);
  const { data: dataValue, results: resultsValue } = payload ?? {};
  let results: unknown[] = [];
  if (Array.isArray(resultsValue)) {
    results = resultsValue;
  } else if (Array.isArray(dataValue)) {
    results = dataValue;
  }
  const semanticResults = results.filter((result) => asRecord(result)?.retrieval_mode === "semantic");
  if (semanticResults.length === 0) {
    throw new GateBlocker(
      `semantic search returned HTTP 200 but no retrieval_mode=semantic result for ${JSON.stringify(query)} (result count ${results.length})`
    );
  }
  const refreshedDiagnostics = await requireStatus(context, "/_ref/deployment", 200);
  context.diagnostics = asRecord(refreshedDiagnostics.json);
  const backend = nestedRecord(context.diagnostics, "semantic", "backend");
  if (backend?.model_cache_present !== true) {
    throw new GateBlocker(
      "semantic search returned a result but the deployment diagnostic says model_cache_present is not true"
    );
  }
  return `HTTP 200; ${semanticResults.length} semantic result(s); model cache present at ${stringValue(backend.model_cache_path) ?? "configured path"}`;
}

async function seedSemanticFixture(context: GateContext): Promise<string> {
  const source = JSON.parse(
    await readFile(new URL("../packages/polyfill-connectors/manifests/spotify.json", import.meta.url), "utf8")
  );
  const manifest = asRecord(source);
  const streams = Array.isArray(manifest?.streams)
    ? manifest.streams.filter((candidate): candidate is Record<string, unknown> => Boolean(asRecord(candidate)))
    : [];
  const stream = streams.find((candidate) => candidate.name === SEMANTIC_FIXTURE_STREAM);
  if (!(manifest && stream)) {
    throw new GateBlocker(`semantic fixture source manifest has no ${SEMANTIC_FIXTURE_STREAM} stream`);
  }
  const query = asRecord(stream.query) ?? {};
  const search = asRecord(query.search) ?? {};
  search.semantic_fields = ["description"];
  query.search = search;
  stream.query = query;
  manifest.connector_id = SEMANTIC_FIXTURE_CONNECTOR_ID;
  manifest.connector_key = SEMANTIC_FIXTURE_CONNECTOR_ID;
  manifest.manifest_uri = SEMANTIC_FIXTURE_MANIFEST_URI;
  manifest.display_name = "Friend readiness semantic fixture";

  const registration = await request(
    context.origin,
    "/connectors",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    },
    context.ownerCookie
  );
  const registrationBody = await readBody(registration);
  if (![200, 201, 409].includes(registration.status)) {
    throw new GateBlocker(
      `semantic fixture manifest registration returned HTTP ${registration.status}: ${summarizeBody(registrationBody)}`
    );
  }

  const token =
    context.ownerToken ||
    (await mintOwnerToken(context.origin, context.ownerCookie, FRIEND_SEED_SUBJECT, () => undefined));
  context.ownerToken = token;
  const record = {
    key: "friend-semantic-record-1",
    data: {
      id: "friend-semantic-record-1",
      name: "Semantic Fixture Playlist",
      description: "A durable local database with semantic search for the friend readiness gate.",
    },
    emitted_at: "2026-01-01T00:00:03.000Z",
  };
  const ingest = await request(
    context.origin,
    `/v1/ingest/${encodeURIComponent(SEMANTIC_FIXTURE_STREAM)}?connector_id=${encodeURIComponent(SEMANTIC_FIXTURE_CONNECTOR_ID)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
      body: JSON.stringify(record),
    },
    ""
  );
  const ingestBody = await readBody(ingest);
  const ingestResult = asRecord(ingestBody.json);
  if (ingest.status !== 200 || ingestResult?.records_accepted !== 1) {
    throw new GateBlocker(`semantic fixture ingest returned HTTP ${ingest.status}: ${summarizeBody(ingestBody)}`);
  }
  return `registered ${SEMANTIC_FIXTURE_CONNECTOR_ID} and ingested one semantic record`;
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const origin = (args.origin ?? process.env.PDPP_FRIEND_ORIGIN ?? process.env.PDPP_ACCEPTANCE_ORIGIN ?? "").replace(
    TRAILING_SLASH_PATTERN,
    ""
  );
  const ownerPassword = args.ownerPassword ?? process.env.PDPP_OWNER_PASSWORD ?? "";
  const container = args.container ?? process.env.PDPP_FRIEND_CONTAINER ?? "";
  if (!origin) {
    process.stderr.write(`--origin or PDPP_FRIEND_ORIGIN is required.\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const context: GateContext = {
    diagnostics: null,
    ownerCookie: "",
    ownerToken: "",
    origin,
  };
  const checks: Check[] = [];

  await runCheck(checks, "core.public-surface", "Core public protocol surface", async () => {
    const [authorizationServer, protectedResource, root] = await Promise.all([
      request(origin, "/.well-known/oauth-authorization-server", {}, ""),
      request(origin, "/.well-known/oauth-protected-resource", {}, ""),
      request(origin, "/", { redirect: "manual" }, ""),
    ]);
    const rootLocation = root.headers.get("location") ?? "";
    if (authorizationServer.status !== 200 || protectedResource.status !== 200) {
      throw new GateBlocker(
        `OAuth discovery statuses were ${authorizationServer.status}/${protectedResource.status}; expected 200/200`
      );
    }
    if (root.status !== 307 || !rootLocation.includes("/owner/login")) {
      throw new GateBlocker(`GET / returned ${root.status} ${rootLocation}; expected a 307 owner-login redirect`);
    }
    return `OAuth discovery 200/200; GET / redirects 307 to ${rootLocation}`;
  });

  await runCheck(checks, "owner.login", "Owner sign-in", async () => {
    if (!ownerPassword) {
      throw new GateBlocker("no owner password supplied; a durable owner-authenticated Core cannot be accepted");
    }
    context.ownerCookie = (await establishOwnerSessionCookie({ origin, ownerPassword })) ?? "";
    if (!context.ownerCookie) {
      throw new GateBlocker("owner login returned no session cookie");
    }
    return "CSRF-protected /owner/login issued an owner session cookie (value withheld)";
  });

  await runCheck(checks, "core.storage-semantic", "SQLite durability and semantic backend", async () => {
    const body = await requireStatus(context, "/_ref/deployment", 200);
    const diagnostics = asRecord(body.json);
    context.diagnostics = diagnostics;
    const database = nestedRecord(diagnostics, "database");
    const semantic = nestedRecord(diagnostics, "semantic");
    const backend = nestedRecord(semantic, "backend");
    const index = nestedRecord(semantic, "index");
    if (database?.path !== "/var/lib/pdpp/pdpp.sqlite") {
      throw new GateBlocker(
        `diagnostic database.path=${JSON.stringify(database?.path)}; expected /var/lib/pdpp/pdpp.sqlite`
      );
    }
    if (
      backend?.available !== true ||
      backend.configured !== true ||
      index?.kind !== "sqlite-vec" ||
      index.state !== "built"
    ) {
      throw new GateBlocker(
        `semantic diagnostic incomplete: available=${String(backend?.available)} configured=${String(backend?.configured)} index=${String(index?.kind)}/${String(index?.state)}`
      );
    }
    return `SQLite ${database.path}; semantic ${stringValue(backend.model) ?? "configured model"}; sqlite-vec index built`;
  });

  await runCheck(checks, "core.browser-binding", "Browser binding and collector pairing", () => {
    const capabilities = nestedRecord(context.diagnostics, "runtime_capabilities");
    const bindings = nestedRecord(capabilities, "bindings");
    if (bindings?.browser !== true || capabilities?.collector_paired !== true) {
      const warnings = Array.isArray(context.diagnostics?.warnings)
        ? context.diagnostics.warnings
            .map((warning) => stringValue(asRecord(warning)?.message))
            .filter((message): message is string => Boolean(message))
            .join(" | ")
        : "no warning detail";
      throw new GateBlocker(
        `runtime_capabilities.bindings.browser=${String(bindings?.browser)}, collector_paired=${String(capabilities?.collector_paired)}; ${warnings}`
      );
    }
    return "Core advertises a browser binding and a paired collector";
  });

  await runCheck(checks, "owner.routes", "Owner data and deployment routes", async () => {
    const routes = ["/connect", "/sources", "/explore", "/deployment", "/deployment/tokens"];
    const responses = await Promise.all(routes.map((route) => request(origin, route, {}, context.ownerCookie)));
    const statuses = responses.map((response, index) => `${routes[index]}=${response.status}`);
    const failed = responses.findIndex((response) => response.status !== 200);
    if (failed >= 0) {
      throw new GateBlocker(`${routes[failed]} returned HTTP ${responses[failed]?.status}; expected 200`);
    }
    return statuses.join(", ");
  });

  await runCheck(checks, "source-picker", "Gmail, ChatGPT, and arbitrary-source setup surfaces", async () => {
    const body = await requireStatus(context, "/sources/add", 200);
    const requiredMarkers = ["source-setup-gmail", "source-setup-chatgpt", "Notion"];
    const missing = requiredMarkers.filter((marker) => !body.text.includes(marker));
    if (missing.length > 0) {
      throw new GateBlocker(`/sources/add is missing rendered source marker(s): ${missing.join(", ")}`);
    }
    return "Rendered source picker contains Gmail, ChatGPT, and Notion/arbitrary-source choices";
  });

  await runCheck(checks, "mcp.scoped-read", "Scoped localhost MCP connection and data read", async () => {
    const steps: string[] = [];
    await runLiveSmoke({
      origin,
      ownerPassword,
      seed: true,
      subjectId: FRIEND_SEED_SUBJECT,
      logger: (message) => steps.push(message),
    });
    return steps.join("; ");
  });

  await runCheck(checks, "data.explore", "Collected data appears in the owner UI", async () => {
    const body = await requireStatus(context, "/explore", 200);
    const expected = ["Deploy Test Quartet", "Restart Survival Band"];
    const missing = expected.filter((value) => !body.text.includes(value));
    if (missing.length > 0) {
      throw new GateBlocker(`/explore did not render seeded data: missing ${missing.join(", ")}`);
    }
    return "Owner /explore rendered both durable seed records";
  });

  await runCheck(checks, "semantic.search", "Semantic search returns a semantic result", async () => {
    const fixture = await seedSemanticFixture(context);
    return `${fixture}; ${await runSemanticSearch(context, args.semanticQuery)}`;
  });

  await runCheck(checks, "browser.cdp", "Bundled non-neko browser and direct CDP", () => {
    if (!container) {
      throw new GateBlocker(
        "--container or PDPP_FRIEND_CONTAINER is required to execute the bundled browser/CDP probe"
      );
    }
    return runCdpProbe(container);
  });

  await runCheck(checks, "browser.auth", "Interactive browser authentication can start", async () => {
    const page = await requireStatus(context, "/connect/browser-session/chatgpt", 200);
    const start = await request(
      origin,
      "/connect/browser-session/chatgpt/start",
      {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      },
      context.ownerCookie
    );
    const startBody = await readBody(start);
    const location = start.headers.get("location") ?? "";
    if (!location.includes("/launch")) {
      const decoded = (() => {
        try {
          return decodeURIComponent(location);
        } catch {
          return location;
        }
      })();
      throw new GateBlocker(
        `browser setup page was HTTP 200 (${page.text.includes("add-new") ? "repair-only copy" : "rendered"}), but POST /connect/browser-session/chatgpt/start returned ${start.status} ${decoded || summarizeBody(startBody)}`
      );
    }
    return `browser setup returned launch redirect ${location}`;
  });

  await runCheck(checks, "source.gmail.setup", "Gmail setup form", async () => {
    const body = await requireStatus(context, "/connect/static-secret/gmail", 200);
    if (!FORM_PATTERN.test(body.text)) {
      throw new GateBlocker("Gmail setup route rendered without a form");
    }
    return "Gmail static-secret setup form rendered; provider collection still requires a real account credential";
  });

  await runCheck(checks, "source.gmail.collection", "Gmail collection", () => {
    throw new GateBlocker(
      "not proven: this machine run supplied no Gmail account credential and therefore did not claim collected Gmail data"
    );
  });

  await runCheck(checks, "source.arbitrary.setup", "Arbitrary supported-source setup form", async () => {
    const body = await requireStatus(context, "/connect/static-secret/notion", 200);
    if (!FORM_PATTERN.test(body.text)) {
      throw new GateBlocker("Notion/arbitrary-source setup route rendered without a form");
    }
    return "Notion setup form rendered as the arbitrary supported-source surface";
  });

  await runCheck(checks, "source.arbitrary.collection", "Arbitrary-source collection", () => {
    throw new GateBlocker(
      "not proven: this machine run supplied no arbitrary-source account credential and therefore did not claim collected data"
    );
  });

  await runCheck(checks, "mcp.local-instructions", "Claude Code/Codex localhost MCP instructions", async () => {
    const body = await requireStatus(context, "/connect", 200);
    const lower = body.text.toLowerCase();
    if (!(lower.includes("claude mcp add") && lower.includes("codex mcp add"))) {
      throw new GateBlocker("/connect did not render both Claude Code and Codex MCP commands");
    }
    return "Rendered Claude Code and Codex localhost MCP commands; no local client config was mutated";
  });

  await runCheck(checks, "hosted.https-boundary", "Hosted Claude.ai/ChatGPT HTTPS boundary", async () => {
    const siteOrigin = (args.siteOrigin ?? process.env.PDPP_FRIEND_SITE_ORIGIN ?? "").replace(
      TRAILING_SLASH_PATTERN,
      ""
    );
    if (!siteOrigin) {
      throw new GateBlocker(
        "--site-origin or PDPP_FRIEND_SITE_ORIGIN is required to execute the /reference assertion; localhost MCP is for local Claude Code/Codex and hosted Claude.ai/ChatGPT require a publicly reachable HTTPS Core origin"
      );
    }
    const reference = await request(siteOrigin, "/reference", { redirect: "manual" }, "");
    const referenceBody = await readBody(reference);
    if (reference.status !== 200) {
      throw new GateBlocker(`GET ${siteOrigin}/reference returned HTTP ${reference.status}; expected 200`);
    }
    const mcp = await request(siteOrigin, "/mcp", { redirect: "manual" }, "");
    const ownerLogin = await request(siteOrigin, "/owner/login", { redirect: "manual" }, "");
    const missing = SITE_ASSERTIONS.filter(([, pattern]) => !pattern.test(referenceBody.text)).map(([label]) => label);
    const renderedLocalMcp = referenceBody.text.includes(`${siteOrigin}/mcp`);
    if (missing.length > 0 || (renderedLocalMcp && mcp.status !== 200)) {
      throw new GateBlocker(
        `/reference=200 but required assertion(s) are missing: ${missing.join(", ") || "none"}; site-origin /mcp=${mcp.status}, /owner/login=${ownerLogin.status}; rendered MCP URL points at ${siteOrigin}/mcp=${renderedLocalMcp}`
      );
    }
    return `/reference=200; promise/storage/browser/HTTPS assertions present; site /mcp=${mcp.status}, /owner/login=${ownerLogin.status}`;
  });

  await runCheck(checks, "restart.persistence", "Container restart preserves SQLite data and auth", async () => {
    if (!container) {
      throw new GateBlocker("--container or PDPP_FRIEND_CONTAINER is required to execute the restart probe");
    }
    await execFileAsync("docker", ["restart", container], { timeout: 60_000, maxBuffer: 256 * 1024 });
    await waitForCore(origin);
    await waitForOwnerGate(origin);
    const steps: string[] = [];
    await runLiveSmoke({
      origin,
      ownerPassword,
      seed: false,
      subjectId: FRIEND_SEED_SUBJECT,
      logger: (message) => steps.push(message),
    });
    return `container ${container} restarted; owner auth re-established; existing records returned without re-seeding (${steps.join("; ")})`;
  });

  const ok = checks.every((check) => check.status === "pass");
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok, origin, checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`friend journey acceptance: ${ok ? "PASS" : "BLOCKED"}\n`);
    for (const check of checks) {
      process.stdout.write(`  [${check.status.toUpperCase()}] ${check.id}: ${check.label} — ${check.evidence}\n`);
    }
  }
  process.exitCode = ok ? 0 : 1;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await main(process.argv.slice(2));
}
