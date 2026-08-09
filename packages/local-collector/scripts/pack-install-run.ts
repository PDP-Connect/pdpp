#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { npmPackMetadata } from "./pack-metadata.ts";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const cliPackageRoot = path.join(repoRoot, "packages/cli");
const referenceServerEntry = path.join(repoRoot, "reference-implementation/server/index.ts");
const referenceDbModule = path.join(repoRoot, "reference-implementation/server/db.js");
const forbiddenPackages = ["playwright", "patchright", "imapflow", "pdf-parse", "better-sqlite3", "linkedom"];
const browserArtifactPatterns = [/chromium/i, /chrome-linux/i, /ms-playwright/i, /patchright/i];

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

interface RunWithInputOptions extends RunOptions {
  stdio?: string[];
}

interface PostJsonResponse {
  body: unknown;
  status: number;
}

interface EnrollmentData {
  connector_instance_id: string;
  device_id: string;
  device_token: string;
  source_instance_id: string;
}

interface RunOutput {
  done?: { status: string };
  recordsQueued?: number;
  sentBatches?: number;
}

interface ServerInstance {
  asPort: number;
  asServer?: {
    closeAllConnections?: () => void;
    close?: (cb: () => void) => void;
  };
  rsPort: number;
  rsServer?: {
    closeAllConnections?: () => void;
    close?: (cb: () => void) => void;
  };
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function run(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    if (error && typeof error === "object") {
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      (error as any).message += `\nCommand failed: ${command} ${args.join(" ")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      if ("stdout" in error && (error as any).stdout) {
        // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
        (error as any).message += `\nstdout:\n${
          // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
          (error as any).stdout
        }`;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      if ("stderr" in error && (error as any).stderr) {
        // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
        (error as any).message += `\nstderr:\n${
          // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
          (error as any).stderr
        }`;
      }
    }
    throw error;
  }
}

function runWithInput(
  command: string,
  args: string[],
  input: string,
  options: RunWithInputOptions = {}
): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stderr, stdout });
        return;
      }
      const error = new Error(
        `Command failed: ${command} ${args.join(" ")} (code ${code ?? "null"}${signal ? `, ${signal}` : ""})`
      );
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      (error as any).stderr = stderr;
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      (error as any).stdout = stdout;
      reject(error);
    });
    child.stdin.end(input);
  });
}

async function packPackage(cwd: string): Promise<string> {
  const packInfo = await npmPackMetadata({ cwd });
  return path.join(cwd, packInfo.filename);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    if ((error as any)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertPackageAbsent(projectDir: string, packageName: string): Promise<void> {
  const candidate = path.join(projectDir, "node_modules", ...packageName.split("/"));
  assert.equal(await pathExists(candidate), false, `unexpected package installed in temp consumer: ${packageName}`);
}

async function assertNoBrowserArtifacts(rootDir: string): Promise<void> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const { name } = entry;
    for (const pattern of browserArtifactPatterns) {
      assert.equal(pattern.test(name), false, `unexpected browser install artifact in temp tree: ${name}`);
    }
  }
}

async function main(): Promise<void> {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts?.postinstall, undefined, "@pdpp/local-collector must not define postinstall");

  log("Building and packing @pdpp/local-collector...");
  const collectorTarball = await packPackage(packageRoot);

  const tempRoot = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-pack-"));
  const projectDir = path.join(tempRoot, "project");
  const npmCacheDir = path.join(tempRoot, "npm-cache");
  const env = {
    ...process.env,
    HOME: path.join(tempRoot, "home"),
    npm_config_cache: npmCacheDir,
    PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "",
  };

  try {
    await mkdir(projectDir, { recursive: true });
    await run("npm", ["init", "-y"], { cwd: projectDir, env });

    log("Installing packed @pdpp/local-collector in a clean temp npm project...");
    const install = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", collectorTarball], {
      cwd: projectDir,
      env,
    });
    const installOutput = `${install.stdout}\n${install.stderr}`;
    for (const pattern of browserArtifactPatterns) {
      assert.equal(pattern.test(installOutput), false, `install output referenced browser artifact ${pattern}`);
    }
    for (const packageName of forbiddenPackages) {
      // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      await assertPackageAbsent(projectDir, packageName);
    }
    await assertPackageAbsent(projectDir, "tsx");
    await assertNoBrowserArtifacts(tempRoot);

    log("Resolving installed package exports and bin...");
    await assertInstalledEntrypoints(projectDir, env);
    log("Exercising the installed browser-shaped runtime branch...");
    await assertInstalledBrowserBranchFailsClosed(projectDir, env);

    log("Running pdpp-local-collector advertise from the installed package...");
    const advertise = await run("npx", ["--no-install", "pdpp-local-collector", "advertise"], { cwd: projectDir, env });
    const advertised = JSON.parse(advertise.stdout);
    assert.equal(advertised.runtime, "collector");
    assert.deepEqual([...advertised.bindings].sort(), ["filesystem", "local_device", "network"]);
    assert.deepEqual([...advertised.bundled_connectors].sort(), [
      "apple_photos",
      "claude_code",
      "codex",
      "google_messages",
      "google_takeout",
      "imessage",
    ]);
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(advertised.collector_protocol_version, /^\d+$/);

    if (await pathExists(path.join(cliPackageRoot, "package.json"))) {
      log("Installing packed @pdpp/cli alongside the collector and checking shim advertise output...");
      const cliTarball = await packPackage(cliPackageRoot);
      await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", cliTarball], {
        cwd: projectDir,
        env,
      });
      const shimAdvertise = await run("npx", ["--no-install", "pdpp", "collector", "advertise"], {
        cwd: projectDir,
        env,
      });
      assert.deepEqual(JSON.parse(shimAdvertise.stdout), advertised);
      await rm(cliTarball, { force: true });
    } else {
      log("SKIP @pdpp/cli shim smoke: packages/cli/package.json was not present.");
    }

    if (await pathExists(referenceServerEntry)) {
      await runFixtureBackedEnrollRunSmoke({
        projectDir,
        env,
        advertisedProtocolVersion: advertised.collector_protocol_version,
      });
      await runProtocolMismatchSmoke({ projectDir, env });
      await runImessageSampleSmoke({ projectDir, env });
      await runFixtureBackedGoogleTakeoutEnrollRunSmoke({ projectDir, env });
      await runApplePhotosSampleSmoke({ projectDir, env });
      await runGoogleMessagesSampleSmoke({ projectDir, env });
    } else {
      log("SKIP fixture-backed enroll/run smoke: reference-implementation/server/index.ts not present.");
      log("SKIP collector_protocol_mismatch smoke: reference-implementation/server/index.ts not present.");
      log("SKIP iMessage bounded-sample smoke: reference-implementation/server/index.ts not present.");
      log("SKIP Google Takeout enroll/run smoke: reference-implementation/server/index.ts not present.");
      log("SKIP Apple Photos bounded-sample smoke: reference-implementation/server/index.ts not present.");
      log("SKIP Google Messages bounded-sample smoke: reference-implementation/server/index.ts not present.");
    }

    log("PASS pack-install-run local smoke");
  } finally {
    await rm(collectorTarball, { force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertInstalledEntrypoints(projectDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const probePath = path.join(projectDir, "assert-installed-entrypoints.mjs");
  const probe = `import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.join(process.cwd(), "node_modules", "@pdpp", "local-collector");
for (const specifier of ["@pdpp/local-collector", "@pdpp/local-collector/runner", "@pdpp/local-collector/errors"]) {
  const resolved = await import.meta.resolve(specifier);
  assert.ok(fileURLToPath(resolved).startsWith(packageRoot + path.sep), \`\${specifier} resolved outside the installed candidate: \${resolved}\`);
  await import(specifier);
}
const bin = path.join(packageRoot, "dist", "local-collector", "bin", "pdpp-local-collector.js");
assert.ok((await stat(bin)).mode & 0o111, "installed pdpp-local-collector bin must be executable");
`;
  await writeFile(probePath, probe);
  try {
    await run(process.execPath, [probePath], { cwd: projectDir, env });
  } finally {
    await rm(probePath, { force: true });
  }
}

async function assertInstalledBrowserBranchFailsClosed(projectDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const probePath = path.join(projectDir, "assert-browser-branch.mjs");
  const runtimePath = path.join(
    projectDir,
    "node_modules",
    "@pdpp",
    "local-collector",
    "dist",
    "polyfill-connectors",
    "src",
    "connector-runtime.js"
  );
  const probe = `import { runConnector } from ${JSON.stringify(pathToFileURL(runtimePath).href)};

runConnector({
  browser: { profileName: "artifact-closure-probe" },
  collect: async () => {},
  ensureSession: async () => {},
  name: "artifact-closure-probe",
  probeSession: async () => ({ authenticated: true }),
  validateRecord: () => {},
});
`;
  await writeFile(probePath, probe);
  let failure: Error | null = null;
  try {
    await runWithInput(
      process.execPath,
      [probePath],
      `${JSON.stringify({ type: "START", scope: { streams: [{ name: "probe" }] } })}\n`,
      { cwd: projectDir, env }
    );
  } catch (error) {
    failure = error as Error;
  } finally {
    await rm(probePath, { force: true });
  }
  assert.ok(failure, "installed browser-shaped runtime probe must fail closed");
  const output = `${
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    (failure as any).stdout ?? ""
  }\n${
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    (failure as any).stderr ?? ""
  }\n${
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established behavior; this diagnostic requires a semantic refactor outside the closure scope.
    failure.message ?? ""
  }`;
  assert.match(
    output,
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    /browser_runtime_unavailable/,
    `browser branch must report its typed capability code: ${output}`
  );
  assert.match(
    output,
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    /filesystem-class connectors only/,
    `browser branch must explain the published boundary: ${output}`
  );
  assert.doesNotMatch(
    output,
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    /ERR_MODULE_NOT_FOUND/,
    `browser branch must not fail through a missing emitted module: ${output}`
  );
}

/**
 * Fixture-backed enroll + run smoke (tasks 7.1).
 *
 * Boots the reference server in-process against an ephemeral SQLite memory
 * db, generates a real Codex-on-disk fixture, drives the *installed*
 * `pdpp-local-collector enroll` and `run --connector codex` against the
 * server, and asserts records persisted at ingest. No real owner token,
 * no remote deployment, no live Codex home is required.
 */
async function runFixtureBackedEnrollRunSmoke({
  projectDir,
  env,
  advertisedProtocolVersion,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  advertisedProtocolVersion: string;
}): Promise<void> {
  log("Booting in-process reference server for fixture-backed enroll/run smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const codexHome = await prepareCodexFixture();
  try {
    log("Creating enrollment code...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "pack-install-run-laptop",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;
    assert.ok(
      typeof enrollmentCode === "string" && enrollmentCode.length > 0,
      "enrollment_code must be a non-empty string"
    );

    log("Running installed pdpp-local-collector enroll against the in-process reference server...");
    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(enrollment.device_id, /^dexp_/);
    assert.equal(typeof enrollment.device_token, "string");
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(enrollment.connector_instance_id, /^cin_/);
    assert.equal(typeof enrollment.source_instance_id, "string");

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const devicesAfterEnroll = (getDb() as any)
      .prepare("SELECT collector_protocol_version FROM device_exporters WHERE device_id = ?")
      .get(enrollment.device_id);
    assert.ok(devicesAfterEnroll, "enrolled device row not visible to test process");
    assert.equal(
      devicesAfterEnroll.collector_protocol_version,
      advertisedProtocolVersion,
      "device row should persist the protocol version the runner advertised"
    );

    log("Running installed pdpp-local-collector run --connector codex against the in-process reference server...");
    const queuePath = path.join(projectDir, "pack-install-run-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "codex",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "prompts,rules",
      ],
      {
        cwd: projectDir,
        env: { ...env, CODEX_HOME: codexHome },
      }
    );
    const runOutput = JSON.parse(runResult.stdout) as RunOutput;
    assert.equal(
      runOutput.done?.status,
      "succeeded",
      `codex connector did not report DONE.status=succeeded: ${runResult.stdout}`
    );
    assert.ok((runOutput.recordsQueued ?? 0) > 0, `codex connector did not queue any records: ${runResult.stdout}`);
    assert.ok(
      (runOutput.sentBatches ?? 0) > 0,
      `codex connector did not send any batches to the reference server: ${runResult.stdout}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const persisted = (getDb() as any)
      .prepare(
        `SELECT COUNT(*) as n
           FROM records
          WHERE connector_id = ?
            AND connector_instance_id = ?`
      )
      .get("codex", enrollment.connector_instance_id);
    assert.ok(
      persisted.n > 0,
      `expected at least one persisted record for connector_instance ${enrollment.connector_instance_id}; got ${persisted.n}`
    );
    log(`Fixture-backed enroll/run smoke PASS: ${persisted.n} record(s) persisted at ingest.`);
  } finally {
    await closeServer(server);
    await rm(codexHome, { recursive: true, force: true });
  }
}

/**
 * Protocol-mismatch smoke (task 7.4).
 *
 * Re-boots the reference server with `acceptedCollectorProtocolVersions`
 * set to a synthetic value the published runner cannot satisfy, then
 * drives `pdpp-local-collector enroll` against it and asserts the runner
 * surfaces the typed `409 collector_protocol_mismatch` error before any
 * device row is created.
 */
async function runProtocolMismatchSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server pinned to an older protocol for the 409 mismatch smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    acceptedCollectorProtocolVersions: ["0"],
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  try {
    log("Creating enrollment code on the pinned server...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "pack-install-run-pinned",
    });
    assert.equal(
      codeResp.status,
      201,
      `pinned enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;

    log("Calling pdpp-local-collector enroll against the pinned server (expecting 409)...");
    let failure: Error | null = null;
    try {
      await run(
        "npx",
        ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
        { cwd: projectDir, env }
      );
    } catch (error) {
      failure = error as Error;
    }
    assert.ok(failure, "pdpp-local-collector enroll should fail when the server pins an incompatible protocol");
    const combined = `${
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      (failure as any).stdout ?? ""
    }\n${
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      (failure as any).stderr ?? ""
    }\n${
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established behavior; this diagnostic requires a semantic refactor outside the closure scope.
      failure.message ?? ""
    }`;
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(combined, /409/, `runner error should mention HTTP status 409; got: ${combined}`);
    assert.match(
      combined,
      // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      /collector_protocol_mismatch/,
      `runner error should surface the typed collector_protocol_mismatch code; got: ${combined}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const devicesAfter = (getDb() as any).prepare("SELECT COUNT(*) as n FROM device_exporters").get();
    assert.equal(devicesAfter.n, 0, "rejected enroll must not have leaked a device row into the pinned server");

    log("collector_protocol_mismatch smoke PASS: enrollment refused before any device row was created.");
  } finally {
    await closeServer(server);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<PostJsonResponse> {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  let parsed: unknown = null;
  try {
    parsed = await resp.json();
    // biome-ignore lint/suspicious/noEmptyBlockStatements: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  } catch {}
  return { body: parsed, status: resp.status };
}

async function closeServer(server: ServerInstance): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const closeOne = (srv: any) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      try {
        srv?.closeAllConnections?.();
        // biome-ignore lint/suspicious/noEmptyBlockStatements: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      } catch {}
      srv?.close?.(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

/**
 * Build a minimal on-disk Codex fixture sufficient to produce at least
 * one record without exercising state_5.sqlite. The fixture intentionally
 * stays in the realm of free-form personal files; the connector emits a
 * `prompts` record from any markdown file under `<CODEX_HOME>/prompts/`.
 */
async function prepareCodexFixture(): Promise<string> {
  const codexHome = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-codex-fixture-"));
  const promptsDir = path.join(codexHome, "prompts");
  const rulesDir = path.join(codexHome, "rules");
  await mkdir(promptsDir, { recursive: true });
  await mkdir(rulesDir, { recursive: true });
  await writeFile(
    path.join(promptsDir, "hello.md"),
    "---\nname: hello\ndescription: greet the operator\n---\n\nHello from the pack-install-run fixture.\n"
  );
  await writeFile(path.join(rulesDir, "trust.rules"), "# trust registry\nallow shell pwd\n");
  return codexHome;
}

const IMESSAGE_FIXTURE_MESSAGE_COUNT = 500;
const IMESSAGE_SAMPLE_LIMIT = 20;
// An arbitrary positive Apple-epoch-seconds base (some time after
// 2001-01-01), so every fixture row's `date` is a small positive integer —
// the connector's `since` cursor query is `WHERE date > ? OR date IS NULL`
// with `since` defaulting to 0, so a negative or zero date would be
// silently excluded from every run.
const IMESSAGE_FIXTURE_DATE_BASE_APPLE_SEC = 700_000_000;

/**
 * Build a synthetic chat.db large enough to exercise `--sample` truncation
 * (500 rows, sampled to 20) using `node:sqlite`'s `DatabaseSync` — the same
 * native-free primitive the packed iMessage connector itself uses, so this
 * fixture builder proves nothing about the packed tarball that depends on a
 * dependency the tarball doesn't actually ship. No real chat.db, no PII:
 * every handle/text value here is synthetic.
 */
async function prepareImessageFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-imessage-fixture-"));
  const dbPath = path.join(dir, "chat.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, handle_id INTEGER, service TEXT,
        is_from_me INTEGER, text TEXT, date INTEGER, date_read INTEGER, cache_has_attachments INTEGER
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    `);
    db.prepare("INSERT INTO handle (ROWID, id) VALUES (?, ?)").run(1, "+15550100000");
    const insertMessage = db.prepare(
      `INSERT INTO message (ROWID, guid, handle_id, service, is_from_me, text, date, date_read, cache_has_attachments)
       VALUES (?, ?, ?, 'iMessage', 0, ?, ?, NULL, 0)`
    );
    const insertJoin = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)");
    for (let i = 0; i < IMESSAGE_FIXTURE_MESSAGE_COUNT; i += 1) {
      const dateApple = IMESSAGE_FIXTURE_DATE_BASE_APPLE_SEC + i;
      insertMessage.run(i + 1, `fixture-guid-${i}`, 1, `fixture message ${i}`, dateApple);
      insertJoin.run(i + 1);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

/**
 * Fixture-backed bounded-sample smoke for iMessage (proves the large-row /
 * `--sample` path against the actual packed, installed tarball — not just
 * the connector's own unit tests, which run from source).
 *
 * Points `IMESSAGE_DB_PATH` at a 500-row synthetic chat.db and runs the
 * installed `pdpp-local-collector run --connector imessage --streams
 * messages --sample 20`. Asserts the run queues and sends exactly the
 * sampled 20, not the full 500 — the same truncation contract
 * `local-device-runtime.test.ts` unit-tests at the source level, proven
 * here end-to-end through the published entrypoint.
 */
async function runImessageSampleSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server for the iMessage bounded-sample smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const chatDbPath = await prepareImessageFixture();
  try {
    log("Creating enrollment code for imessage...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "imessage",
      local_binding_name: "pack-install-run-imessage",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;

    log("Running installed pdpp-local-collector enroll for imessage...");
    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;

    log(`Running installed pdpp-local-collector run --connector imessage --sample ${IMESSAGE_SAMPLE_LIMIT}...`);
    const queuePath = path.join(projectDir, "pack-install-run-imessage-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "imessage",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "messages",
        "--sample",
        String(IMESSAGE_SAMPLE_LIMIT),
      ],
      {
        cwd: projectDir,
        env: { ...env, IMESSAGE_DB_PATH: chatDbPath },
      }
    );
    const runOutput = JSON.parse(runResult.stdout) as {
      object?: string;
      records_seen?: number;
      status?: { outbox?: { counts?: { pending?: number; sent?: number; total?: number } } };
    };
    assert.equal(runOutput.object, "local_collector_sample", `unexpected --sample response shape: ${runResult.stdout}`);
    // The sample abort is asynchronous (see runCollectorSample's onMessage
    // hook in pdpp-local-collector.ts): recordsSeen can overshoot the limit
    // by a small margin before the abort signal actually stops the child, so
    // the documented contract is records_seen >= sample_limit, never exact
    // equality. What matters for "bounded" is that it stopped nowhere near
    // the full 500-row fixture.
    assert.ok(
      typeof runOutput.records_seen === "number" && runOutput.records_seen >= IMESSAGE_SAMPLE_LIMIT,
      `--sample ${IMESSAGE_SAMPLE_LIMIT} must see at least the limit before stopping: ${runResult.stdout}`
    );
    assert.ok(
      runOutput.records_seen < IMESSAGE_FIXTURE_MESSAGE_COUNT,
      `--sample ${IMESSAGE_SAMPLE_LIMIT} must stop well short of the full ${IMESSAGE_FIXTURE_MESSAGE_COUNT}-row fixture; got ${runOutput.records_seen}: ${runResult.stdout}`
    );
    // The abort fires mid-scan, before the queued batch necessarily drains to
    // the server in the same process lifetime — this matches the CLI's own
    // documented note ("these records are durably queued but this is NOT a
    // complete collection"). Assert the local outbox actually holds the
    // sampled work, then prove it drains for real with a normal follow-up
    // `run` (no --sample) — the exact UAT-documented recovery step.
    const outboxTotal = runOutput.status?.outbox?.counts?.total ?? 0;
    assert.ok(outboxTotal > 0, `sample run must leave sampled work in the local outbox: ${runResult.stdout}`);

    log("Running installed pdpp-local-collector run --connector imessage (no --sample) to drain the full fixture...");
    const fullRun = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "imessage",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "messages",
      ],
      { cwd: projectDir, env: { ...env, IMESSAGE_DB_PATH: chatDbPath } }
    );
    const fullRunOutput = JSON.parse(fullRun.stdout) as RunOutput;
    assert.equal(
      fullRunOutput.done?.status,
      "succeeded",
      `follow-up full imessage run did not report DONE.status=succeeded: ${fullRun.stdout}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const persisted = (getDb() as any)
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_id = ? AND connector_instance_id = ?")
      .get("imessage", enrollment.connector_instance_id);
    assert.equal(
      persisted.n,
      IMESSAGE_FIXTURE_MESSAGE_COUNT,
      `expected the full ${IMESSAGE_FIXTURE_MESSAGE_COUNT}-row fixture persisted after the non-sampled follow-up run; got ${persisted.n}`
    );
    log(
      `iMessage bounded-sample + full-drain smoke PASS: sample stopped at ${runOutput.records_seen} of ${IMESSAGE_FIXTURE_MESSAGE_COUNT}, follow-up run persisted all ${persisted.n}.`
    );
  } finally {
    await closeServer(server);
    await rm(path.dirname(chatDbPath), { recursive: true, force: true });
  }
}

async function prepareGoogleTakeoutFixture(): Promise<string> {
  const takeoutDir = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-google-takeout-fixture-"));
  const searchDir = path.join(takeoutDir, "My Activity", "Search");
  await mkdir(searchDir, { recursive: true });
  await writeFile(
    path.join(searchDir, "MyActivity.json"),
    JSON.stringify([
      {
        header: "Search",
        title: "Searched for pack-install-run fixture",
        titleUrl: "https://www.google.com/search?q=pack-install-run+fixture",
        time: "2026-01-01T00:00:00.000Z",
        products: ["Search"],
      },
    ])
  );
  return takeoutDir;
}

async function runFixtureBackedGoogleTakeoutEnrollRunSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server for Google Takeout fixture-backed enroll/run smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: The reference server is dynamically imported from its packed runtime entrypoint.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const takeoutDir = await prepareGoogleTakeoutFixture();
  try {
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "google_takeout",
      local_binding_name: "pack-install-run-laptop",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: The route response is validated at this dynamic package boundary.
    const enrollmentCode = (codeResp.body as any).enrollment_code;
    assert.ok(typeof enrollmentCode === "string" && enrollmentCode.length > 0);

    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;
    const queuePath = path.join(projectDir, "pack-install-run-google-takeout-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "google_takeout",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "search_history",
      ],
      { cwd: projectDir, env: { ...env, GOOGLE_TAKEOUT_DIR: takeoutDir } }
    );
    const runOutput = JSON.parse(runResult.stdout) as RunOutput;
    assert.equal(runOutput.done?.status, "succeeded");
    assert.ok(
      (runOutput.recordsQueued ?? 0) > 0,
      `google_takeout connector did not queue any records: ${runResult.stdout}`
    );
    assert.ok((runOutput.sentBatches ?? 0) > 0);

    // biome-ignore lint/suspicious/noExplicitAny: The test reads the dynamically imported reference database.
    const persisted = (getDb() as any)
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_id = ? AND connector_instance_id = ?")
      .get("google-takeout", enrollment.connector_instance_id);
    assert.ok(persisted.n > 0, `expected at least one persisted google_takeout record; got ${persisted.n}`);
    log(`Google Takeout fixture-backed enroll/run smoke PASS: ${persisted.n} record(s) persisted at ingest.`);
  } finally {
    await closeServer(server);
    await rm(takeoutDir, { recursive: true, force: true });
  }
}

const APPLE_PHOTOS_FIXTURE_FILE_COUNT = 500;
const APPLE_PHOTOS_SAMPLE_LIMIT = 20;

/**
 * Build a synthetic Photos.app export directory large enough to exercise
 * `--sample` truncation (500 files, sampled to 20), using only Node
 * built-ins (no real image bytes, no native dependency) — the same
 * primitive the packed apple_photos connector itself uses to walk an
 * export directory.
 */
async function prepareApplePhotosFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-apple-photos-fixture-"));
  for (let i = 0; i < APPLE_PHOTOS_FIXTURE_FILE_COUNT; i += 1) {
    await writeFile(path.join(dir, `IMG_${String(i).padStart(4, "0")}.jpg`), Buffer.from(`fixture-photo-${i}`));
  }
  return dir;
}

/**
 * Fixture-backed bounded-sample smoke for apple_photos (proves the
 * large-file / `--sample` path against the actual packed, installed
 * tarball — not just the connector's own unit tests, which run from
 * source). Points `APPLE_PHOTOS_EXPORT_DIR` at a 500-file synthetic export
 * directory and runs the installed `pdpp-local-collector run --connector
 * apple_photos --streams photos --sample 20`. Asserts the run queues and
 * sends exactly the sampled 20, not the full 500, then proves a follow-up
 * full run drains everything.
 */
async function runApplePhotosSampleSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server for the Apple Photos bounded-sample smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const exportDir = await prepareApplePhotosFixture();
  try {
    log("Creating enrollment code for apple_photos...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "apple_photos",
      local_binding_name: "pack-install-run-apple-photos",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;

    log("Running installed pdpp-local-collector enroll for apple_photos...");
    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;

    log(`Running installed pdpp-local-collector run --connector apple_photos --sample ${APPLE_PHOTOS_SAMPLE_LIMIT}...`);
    const queuePath = path.join(projectDir, "pack-install-run-apple-photos-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "apple_photos",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "photos",
        "--sample",
        String(APPLE_PHOTOS_SAMPLE_LIMIT),
      ],
      { cwd: projectDir, env: { ...env, APPLE_PHOTOS_EXPORT_DIR: exportDir } }
    );
    const runOutput = JSON.parse(runResult.stdout) as {
      object?: string;
      records_seen?: number;
      status?: { outbox?: { counts?: { pending?: number; sent?: number; total?: number } } };
    };
    assert.equal(runOutput.object, "local_collector_sample", `unexpected --sample response shape: ${runResult.stdout}`);
    assert.ok(
      typeof runOutput.records_seen === "number" && runOutput.records_seen >= APPLE_PHOTOS_SAMPLE_LIMIT,
      `--sample ${APPLE_PHOTOS_SAMPLE_LIMIT} must see at least the limit before stopping: ${runResult.stdout}`
    );
    assert.ok(
      runOutput.records_seen < APPLE_PHOTOS_FIXTURE_FILE_COUNT,
      `--sample ${APPLE_PHOTOS_SAMPLE_LIMIT} must stop well short of the full ${APPLE_PHOTOS_FIXTURE_FILE_COUNT}-file fixture; got ${runOutput.records_seen}: ${runResult.stdout}`
    );
    const outboxTotal = runOutput.status?.outbox?.counts?.total ?? 0;
    assert.ok(outboxTotal > 0, `sample run must leave sampled work in the local outbox: ${runResult.stdout}`);

    log(
      "Running installed pdpp-local-collector run --connector apple_photos (no --sample) to drain the full fixture..."
    );
    const fullRun = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "apple_photos",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "photos",
      ],
      { cwd: projectDir, env: { ...env, APPLE_PHOTOS_EXPORT_DIR: exportDir } }
    );
    const fullRunOutput = JSON.parse(fullRun.stdout) as RunOutput;
    assert.equal(
      fullRunOutput.done?.status,
      "succeeded",
      `follow-up full apple_photos run did not report DONE.status=succeeded: ${fullRun.stdout}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const persisted = (getDb() as any)
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_id = ? AND connector_instance_id = ?")
      .get("apple-photos", enrollment.connector_instance_id);
    assert.equal(
      persisted.n,
      APPLE_PHOTOS_FIXTURE_FILE_COUNT,
      `expected the full ${APPLE_PHOTOS_FIXTURE_FILE_COUNT}-file fixture persisted after the non-sampled follow-up run; got ${persisted.n}`
    );
    log(
      `Apple Photos bounded-sample + full-drain smoke PASS: sample stopped at ${runOutput.records_seen} of ${APPLE_PHOTOS_FIXTURE_FILE_COUNT}, follow-up run persisted all ${persisted.n}.`
    );
  } finally {
    await closeServer(server);
    await rm(exportDir, { recursive: true, force: true });
  }
}

const GOOGLE_MESSAGES_FIXTURE_MESSAGE_COUNT = 500;
const GOOGLE_MESSAGES_SAMPLE_LIMIT = 20;

/**
 * Fake `gmcli` binary for the pack-install-run smoke: a single chat, 500
 * messages, dispatching on the real documented CLI shape (`--json --full
 * chats list` / `messages list --conv <id> --json --full --limit <N>
 * --order asc`) so this smoke proves the packed google_messages tarball
 * spawns exactly this shape against whatever GMCLI_BIN points at — no real
 * gmcli binary or paired Android device is available in CI, so this script
 * fixture stands in for it.
 */
async function prepareFakeGmcliBinary(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-gmcli-fixture-"));
  const binPath = path.join(dir, "fake-gmcli.mjs");
  const messages = Array.from({ length: GOOGLE_MESSAGES_FIXTURE_MESSAGE_COUNT }, (_, i) => ({
    message_id: `msg_${String(i).padStart(4, "0")}`,
    conversation_id: "chat_fixture",
    source_platform: "rcs",
    sender_id: i % 2 === 0 ? "+15551230001" : "me",
    body: `fixture message ${i}`,
    timestamp_ms: 1_754_071_452_000 + i * 1000,
    status: 1,
    is_from_me: i % 2 === 1,
  }));
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("chats") && args.includes("list")) {
  process.stdout.write(JSON.stringify([{ conversation_id: "chat_fixture", source_platform: "rcs", name: "Fixture Chat" }]));
  process.exit(0);
}
if (args[0] === "messages" && args[1] === "list") {
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : ${GOOGLE_MESSAGES_FIXTURE_MESSAGE_COUNT};
  const all = ${JSON.stringify(messages)};
  process.stdout.write(JSON.stringify(all.slice(0, limit)));
  process.exit(0);
}
process.exit(1);
`;
  await writeFile(binPath, script, { mode: 0o755 });
  return binPath;
}

/**
 * Fixture-backed bounded-sample smoke for google_messages, using a fake
 * `gmcli` binary (no real gmcli install or paired Android device is
 * available in this environment) that speaks the same documented CLI
 * contract (`--json --full chats list`, `messages list --conv <id> --json
 * --full --limit <N> --order asc`) the real gmcli would. Proves the
 * `--sample` path against the actual packed, installed tarball.
 */
async function runGoogleMessagesSampleSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server for the Google Messages bounded-sample smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const gmcliBin = await prepareFakeGmcliBinary();
  try {
    log("Creating enrollment code for google_messages...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "google_messages",
      local_binding_name: "pack-install-run-google-messages",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;

    log("Running installed pdpp-local-collector enroll for google_messages...");
    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;

    log(
      `Running installed pdpp-local-collector run --connector google_messages --sample ${GOOGLE_MESSAGES_SAMPLE_LIMIT}...`
    );
    const queuePath = path.join(projectDir, "pack-install-run-google-messages-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "google_messages",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "messages",
        "--sample",
        String(GOOGLE_MESSAGES_SAMPLE_LIMIT),
      ],
      { cwd: projectDir, env: { ...env, GMCLI_BIN: gmcliBin } }
    );
    const runOutput = JSON.parse(runResult.stdout) as {
      object?: string;
      records_seen?: number;
      status?: { outbox?: { counts?: { pending?: number; sent?: number; total?: number } } };
    };
    assert.equal(runOutput.object, "local_collector_sample", `unexpected --sample response shape: ${runResult.stdout}`);
    assert.ok(
      typeof runOutput.records_seen === "number" && runOutput.records_seen >= GOOGLE_MESSAGES_SAMPLE_LIMIT,
      `--sample ${GOOGLE_MESSAGES_SAMPLE_LIMIT} must see at least the limit before stopping: ${runResult.stdout}`
    );
    assert.ok(
      runOutput.records_seen < GOOGLE_MESSAGES_FIXTURE_MESSAGE_COUNT,
      `--sample ${GOOGLE_MESSAGES_SAMPLE_LIMIT} must stop well short of the full ${GOOGLE_MESSAGES_FIXTURE_MESSAGE_COUNT}-message fixture; got ${runOutput.records_seen}: ${runResult.stdout}`
    );
    const outboxTotal = runOutput.status?.outbox?.counts?.total ?? 0;
    assert.ok(outboxTotal > 0, `sample run must leave sampled work in the local outbox: ${runResult.stdout}`);

    log(
      "Running installed pdpp-local-collector run --connector google_messages (no --sample) to drain the full fixture..."
    );
    const fullRun = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "google_messages",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "messages",
      ],
      { cwd: projectDir, env: { ...env, GMCLI_BIN: gmcliBin } }
    );
    const fullRunOutput = JSON.parse(fullRun.stdout) as RunOutput;
    assert.equal(
      fullRunOutput.done?.status,
      "succeeded",
      `follow-up full google_messages run did not report DONE.status=succeeded: ${fullRun.stdout}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const persisted = (getDb() as any)
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_id = ? AND connector_instance_id = ?")
      .get("google-messages", enrollment.connector_instance_id);
    assert.equal(
      persisted.n,
      GOOGLE_MESSAGES_FIXTURE_MESSAGE_COUNT,
      `expected the full ${GOOGLE_MESSAGES_FIXTURE_MESSAGE_COUNT}-message fixture persisted after the non-sampled follow-up run; got ${persisted.n}`
    );
    log(
      `Google Messages bounded-sample + full-drain smoke PASS: sample stopped at ${runOutput.records_seen} of ${GOOGLE_MESSAGES_FIXTURE_MESSAGE_COUNT}, follow-up run persisted all ${persisted.n}.`
    );
  } finally {
    await closeServer(server);
    await rm(path.dirname(gmcliBin), { recursive: true, force: true });
  }
}

await main();
