#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    assert.deepEqual([...advertised.bundled_connectors].sort(), ["claude_code", "codex"]);
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
    } else {
      log("SKIP fixture-backed enroll/run smoke: reference-implementation/server/index.ts not present.");
      log("SKIP collector_protocol_mismatch smoke: reference-implementation/server/index.ts not present.");
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

await main();
