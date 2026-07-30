// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// The installed tarball has no access to reference-implementation/server
// (it's outside the packed npm tree and not a runtime dependency of
// @pdpp/cli), so the fixture server below is started IN THIS SCRIPT's own
// process — same relative-import pattern packages/cli/test/
// owner-agent-reference-smoke.test.ts already uses, valid because this
// script runs via tsx inside the monorepo, never from the packed tarball
// itself. Only the CLI command under test executes from the installed
// tarball via npx.
import { startServer } from "../../../reference-implementation/server/index.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../../../reference-implementation/server/stores/credential-encryption.ts";
import {
  addNodeProbeToEnvironment,
  assertArtifactReceipt,
  bindNodeEnvironment,
  createNodeProbe,
  fileSha256,
  gitHeadSha,
  labelChildEnvironment,
  packageContentSha256,
  readNodeProbe,
} from "./artifact-receipt.ts";
import { parseNpmPackOutput } from "./package-contract.ts";

const MONOREPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_OWNER_PASSWORD = "pdpp-cli-pack-smoke-owner-password";
const FIXTURE_CREDENTIAL_ENCRYPTION_KEY = "pdpp-cli-pack-smoke-credential-key";
// Static-secret manifest (gmail, not an OAuth connector like spotify):
// registering a manifest and even completing an OAuth PAR/device flow does
// NOT create a `connector_instances` row (confirmed against
// reference-implementation/test/owner-auth.test.ts and packages/cli/test/
// owner-agent-reference-smoke.test.ts — neither ever produces a row
// `/_ref/connectors` can see). The ONLY route that inserts a `draft` row is
// `POST /_ref/connectors/:id/draft-connection` (owner-session gated,
// static-secret manifests only) — see reference-implementation/test/
// static-secret-draft-connection-route.test.ts's "pre-first-record" case,
// which this fixture mirrors exactly.
const FIXTURE_MANIFEST = JSON.parse(
  readFileSync(join(MONOREPO_ROOT, "packages", "polyfill-connectors", "manifests", "gmail.json"), "utf8")
) as {
  connector_id: string;
  connector_key?: string;
  [key: string]: unknown;
};
const FIXTURE_CONNECTOR_KEY = FIXTURE_MANIFEST.connector_key ?? "gmail";

interface FixtureServer {
  asServer: { close: (cb?: (err?: Error) => void) => unknown; closeAllConnections: () => void };
  rsServer: { close: (cb?: (err?: Error) => void) => unknown; closeAllConnections: () => void };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort());
  });
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!address || typeof address === "string") {
    throw new Error("could not determine a free port");
  }
  return address.port;
}

async function closeFixtureServer(server: FixtureServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: FixtureServer["asServer"]) =>
    new Promise<void>((resolveClosed) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolveClosed();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolveClosed();
        }
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

function getRawSetCookieList(resp: Response): string[] {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    const [firstPair] = header.split(";");
    if (firstPair.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  // biome-ignore lint/performance/useTopLevelRegex: single call site; scoped to this one fixture helper.
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match ? match[1] : null;
}

async function loginAsFixtureOwner(asUrl: string): Promise<string> {
  const csrfResp = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(csrfResp), "pdpp_owner_csrf");
  const csrfField = extractCsrfFieldValue(await csrfResp.text());
  assert.ok(csrfCookie, "fixture server must issue a CSRF cookie");
  assert.ok(csrfField, "fixture server must render a CSRF form field");

  const loginResp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({
      _csrf: csrfField ?? "",
      password: FIXTURE_OWNER_PASSWORD,
      return_to: "/deployment/tokens",
    }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie ?? "",
    },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(loginResp.status, 302, "fixture owner login must redirect on success");
  const sessionCookie = findSetCookiePair(getRawSetCookieList(loginResp), "pdpp_owner_session");
  assert.ok(sessionCookie, "fixture owner login must issue an owner session cookie");
  return sessionCookie as string;
}

// Registers the fixture manifest, then creates a static-secret DRAFT
// connection via the owner-session-gated /_ref/connectors/:id/draft-connection
// route — the one route that actually inserts a connector_instances row
// visible to /_ref/connectors before any credential is captured or record
// ingested. Returns the created connection_id.
async function seedFixtureConnection(asUrl: string, ownerSessionCookie: string): Promise<string> {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(FIXTURE_MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(registerResp.status, 201, "fixture connector registration must succeed");

  const draftResp = await fetch(
    `${asUrl}/_ref/connectors/${encodeURIComponent(FIXTURE_CONNECTOR_KEY)}/draft-connection`,
    {
      body: JSON.stringify({ setup_fields: { account_email: "owner@example.com" } }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: ownerSessionCookie,
      },
      method: "POST",
    }
  );
  const draftText = await draftResp.text();
  assert.equal(draftResp.status, 201, `fixture draft-connection request must succeed: ${draftText}`);
  const draftBody = JSON.parse(draftText) as { connection_id?: string };
  assert.ok(draftBody.connection_id, "fixture draft-connection response must include connection_id");
  return draftBody.connection_id as string;
}

interface Manifest {
  exports: Record<string, unknown>;
  name: string;
  version: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Manifest;
const tempRoot = mkdtempSync(join(tmpdir(), "pdpp-cli-consumer-"));
const consumerRoot = join(tempRoot, "consumer");
const packRoot = join(tempRoot, "pack");
const probe = process.env.PDPP_ARTIFACT_NODE_PROBE_FILE
  ? {
      file: process.env.PDPP_ARTIFACT_NODE_PROBE_FILE,
      script: process.env.PDPP_ARTIFACT_NODE_PROBE_SCRIPT,
    }
  : createNodeProbe(tempRoot);
const expectedNodeVersion = process.env.PDPP_ARTIFACT_EXPECTED_NODE_VERSION;
const expectedNodeExecPath = process.env.PDPP_ARTIFACT_EXPECTED_NODE_EXEC_PATH;
const expectedGitHeadSha = process.env.PDPP_ARTIFACT_EXPECTED_GIT_HEAD_SHA;
const expectedContentSha256 = process.env.PDPP_ARTIFACT_EXPECTED_CONTENT_SHA256;
const packageEnv = {
  ...process.env,
  HOME: join(tempRoot, "home"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
};
const env = addNodeProbeToEnvironment(bindNodeEnvironment(packageEnv, process.execPath), probe);

interface ExecFileOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  [key: string]: unknown;
}

function run(command: string, args: string[], options: ExecFileOptions = {}): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: labelChildEnvironment(env, `${command} ${args.join(" ")}`),
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function runFailure(command: string, args: string[], options: ExecFileOptions = {}): string {
  try {
    run(command, args, options);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.fail(`${command} ${args.join(" ")} unexpectedly succeeded`);
}

const execFileAsync = promisify(execFile);

// execFileSync (via `run`/`runFailure` above) blocks this process's ENTIRE
// event loop for the duration of the child process. That's fine for every
// other command in this script, but the fixture server started below runs
// IN THIS PROCESS (see `startServer` import) — its Fastify/Node HTTP
// listener needs the event loop free to accept and answer the installed
// CLI's request. A synchronous `run()` call here would freeze the very
// server the command is trying to reach, hanging forever. Use the async
// child-process API for the two commands that must talk to the in-process
// fixture server.
async function runAsync(command: string, args: string[], options: ExecFileOptions = {}): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    env: labelChildEnvironment(env, `${command} ${args.join(" ")}`),
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return stdout;
}

async function runFailureAsync(command: string, args: string[], options: ExecFileOptions = {}): Promise<string> {
  try {
    await runAsync(command, args, options);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  assert.fail(`${command} ${args.join(" ")} unexpectedly succeeded`);
}

try {
  mkdirSync(consumerRoot, { recursive: true });
  mkdirSync(packRoot, { recursive: true });
  const [packResult] = parseNpmPackOutput(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot], {
      cwd: packageRoot,
    })
  );
  const tarball = join(packRoot, packResult.filename);

  run("npm", ["init", "-y"], { cwd: consumerRoot });
  run("npm", ["install", "--ignore-scripts", "--offline", tarball], { cwd: consumerRoot });

  const tree = JSON.parse(run("npm", ["ls", "--all", "--json"], { cwd: consumerRoot })) as {
    dependencies?: { [key: string]: { version: string } };
  };
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established behavior; this diagnostic requires a semantic refactor outside the closure scope.
  assert.equal(tree.dependencies?.["@pdpp/cli"]?.version, manifest.version, "consumer resolved the candidate CLI");
  assert.equal(
    existsSync(join(consumerRoot, "node_modules", "@pdpp", "local-collector")),
    false,
    "CLI-only consumer must not contain the optional collector"
  );

  const exportSpecifiers = Object.keys(manifest.exports).map((subpath) =>
    subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(exportSpecifiers)}.map((specifier) => import(specifier)));`,
    ],
    { cwd: consumerRoot }
  );

  const resolvedRoot = run(
    process.execPath,
    ["--input-type=module", "--eval", `console.log(import.meta.resolve(${JSON.stringify(manifest.name)}));`],
    { cwd: consumerRoot }
  ).trim();
  assert.match(resolvedRoot, /node_modules\/@pdpp\/cli\/dist\/src\/index\.js$/, "consumer must resolve emitted CLI JS");

  const help = run("npx", ["--no-install", "pdpp", "--help"], { cwd: consumerRoot });
  assert.match(help, /PDPP CLI/, "installed pdpp help must run through npx without download");

  const collectorFailure = runFailure("npx", ["--no-install", "pdpp", "collector", "advertise"], {
    cwd: consumerRoot,
  });
  assert.match(collectorFailure, /@pdpp\/local-collector/, "CLI-only collector failure must name the optional package");
  assert.match(collectorFailure, /npm i -g @pdpp\/local-collector|npx -y @pdpp\/local-collector/);
  assert.doesNotMatch(collectorFailure, /not distributed with @pdpp\/cli yet/);

  // Deterministic local authenticated fixture: exercises the INSTALLED
  // tarball's `ref connectors list` end to end (real HTTP request against a
  // real reference server, real owner-session cookie auth, real response
  // parsed through the packed dist/src/ref/list-envelope.js), not merely a
  // source-level unit test. This is the release-blocker gate finding 4 fix —
  // pack-install-run.ts previously only ran --help and the offline collector
  // failure, never a command that touches the generated validator.
  const asPort = await freePort();
  const rsPort = await freePort();
  const asUrl = `http://127.0.0.1:${asPort}`;
  const rsUrl = `http://127.0.0.1:${rsPort}`;
  const previousCredentialKey = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = FIXTURE_CREDENTIAL_ENCRYPTION_KEY;
  const fixtureServer = (await startServer({
    asPort,
    asPublicUrl: asUrl,
    bindHost: "127.0.0.1",
    dbPath: ":memory:",
    ignoreAmbientPublicUrls: true,
    ownerAuthPassword: FIXTURE_OWNER_PASSWORD,
    quiet: true,
    referenceMode: "composed",
    referenceOrigin: rsUrl,
    rsPort,
    rsPublicUrl: rsUrl,
    // A permissive deterministic prober so capturing this static-secret
    // connector never triggers a real network probe — draft creation itself
    // does not call the prober, but startServer requires the option to be
    // wired for the connector's credential-capture route family to boot.
    // Signature/shape mirrors static-secret-draft-connection-route.test.ts's
    // permissiveProber().
    staticSecretCredentialProber: ({ context }: { context?: { setupFields?: Record<string, unknown> } }) =>
      Promise.resolve({
        detail: null,
        identity: context?.setupFields?.account_email ?? "owner@example.com",
        ok: true,
      }),
    trustedMetadataHosts: ["127.0.0.1"],
  })) as unknown as FixtureServer;
  try {
    const sessionCookie = await loginAsFixtureOwner(asUrl);
    const connectionId = await seedFixtureConnection(asUrl, sessionCookie);

    const connectorsListJson = await runAsync(
      "npx",
      [
        "--no-install",
        "pdpp",
        "ref",
        "connectors",
        "list",
        "--as-url",
        asUrl,
        "--owner-session",
        sessionCookie,
        "--format",
        "json",
        "--verbose",
      ],
      { cwd: consumerRoot }
    );
    const connectorsListBody = JSON.parse(connectorsListJson) as {
      data?: unknown[];
      has_more?: unknown;
      object?: unknown;
    };
    assert.equal(connectorsListBody.object, "list", "installed CLI must parse a real object: 'list' envelope");
    assert.ok(Array.isArray(connectorsListBody.data), "installed CLI must parse a real array data field");
    assert.equal(typeof connectorsListBody.has_more, "boolean", "installed CLI must parse a real boolean has_more");
    assert.ok(
      connectorsListBody.data?.some(
        (row) =>
          (row as { connection_id?: string; connector_instance_id?: string }).connection_id === connectionId ||
          (row as { connection_id?: string; connector_instance_id?: string }).connector_instance_id === connectionId
      ),
      "installed CLI must surface the seeded draft connection by its connection_id"
    );

    const missingSessionFailure = await runFailureAsync(
      "npx",
      ["--no-install", "pdpp", "ref", "connectors", "list", "--as-url", asUrl, "--format", "json"],
      { cwd: consumerRoot }
    );
    assert.match(
      missingSessionFailure,
      /Owner session required/i,
      "installed CLI must surface the real server's owner-session rejection, not a silently-empty list"
    );
  } finally {
    await closeFixtureServer(fixtureServer);
    if (previousCredentialKey === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = previousCredentialKey;
    }
  }

  interface Receipt {
    environment: {
      path: string;
      npmConfig: {
        audit: string;
        fund: string;
        offline: string;
        updateNotifier: string;
      };
    };
    gitHeadSha: string;
    nodeExecPath: string;
    nodeVersion: string;
    packageContentSha256: string;
    subprocesses: Array<{ label: string; version: string; execPath: string }>;
    tarballSha256: string;
  }

  const receipt: Receipt = {
    nodeVersion: process.version,
    nodeExecPath: process.execPath,
    environment: {
      path: env.PATH || "",
      npmConfig: {
        audit: (env.npm_config_audit as string) || "",
        fund: (env.npm_config_fund as string) || "",
        offline: (env.npm_config_offline as string) || "",
        updateNotifier: (env.npm_config_update_notifier as string) || "",
      },
    },
    gitHeadSha: gitHeadSha(packageRoot),
    packageContentSha256: packageContentSha256(packageRoot),
    tarballSha256: fileSha256(tarball),
    subprocesses: readNodeProbe(probe.file),
  };
  assertArtifactReceipt(receipt, {
    nodeVersion: expectedNodeVersion,
    nodeExecPath: expectedNodeExecPath,
    gitHeadSha: expectedGitHeadSha,
    packageContentSha256: expectedContentSha256,
  });
  process.stdout.write(`ARTIFACT_RECEIPT ${JSON.stringify(receipt)}\n`);
  process.stdout.write(
    `Installed CLI consumer passed: ${exportSpecifiers.length} exports, pdpp --help, offline collector failure.\n`
  );
} finally {
  rmSync(tempRoot, { force: true, recursive: true });
}
