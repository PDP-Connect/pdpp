#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const cliPackageRoot = path.join(repoRoot, "packages/cli");
const referenceServerEntry = path.join(repoRoot, "reference-implementation/server/index.js");
const referenceDbModule = path.join(repoRoot, "reference-implementation/server/db.js");
const forbiddenPackages = ["playwright", "patchright", "imapflow", "pdf-parse", "better-sqlite3", "linkedom"];
const browserArtifactPatterns = [
  /chromium/i,
  /chrome-linux/i,
  /ms-playwright/i,
  /patchright/i,
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    if (error && typeof error === "object") {
      error.message += `\nCommand failed: ${command} ${args.join(" ")}`;
      if ("stdout" in error && error.stdout) {
        error.message += `\nstdout:\n${error.stdout}`;
      }
      if ("stderr" in error && error.stderr) {
        error.message += `\nstderr:\n${error.stderr}`;
      }
    }
    throw error;
  }
}

async function packPackage(cwd) {
  const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts"], { cwd });
  const [packInfo] = JSON.parse(stdout);
  return path.join(cwd, packInfo.filename);
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertPackageAbsent(projectDir, packageName) {
  const candidate = path.join(projectDir, "node_modules", ...packageName.split("/"));
  assert.equal(
    await pathExists(candidate),
    false,
    `unexpected browser-bound package installed: ${packageName}`
  );
}

async function assertNoBrowserArtifacts(rootDir) {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    for (const pattern of browserArtifactPatterns) {
      assert.equal(pattern.test(name), false, `unexpected browser install artifact in temp tree: ${name}`);
    }
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts?.postinstall, undefined, "@pdpp/local-collector must not define postinstall");

  log("Building and packing @pdpp/local-collector...");
  await run("pnpm", ["build"], { cwd: packageRoot });
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
    const install = await run("npm", ["install", collectorTarball], { cwd: projectDir, env });
    const installOutput = `${install.stdout}\n${install.stderr}`;
    for (const pattern of browserArtifactPatterns) {
      assert.equal(pattern.test(installOutput), false, `install output referenced browser artifact ${pattern}`);
    }
    for (const packageName of forbiddenPackages) {
      await assertPackageAbsent(projectDir, packageName);
    }
    await assertNoBrowserArtifacts(tempRoot);

    log("Running pdpp-local-collector advertise from the installed package...");
    const advertise = await run("npx", ["pdpp-local-collector", "advertise"], { cwd: projectDir, env });
    const advertised = JSON.parse(advertise.stdout);
    assert.equal(advertised.runtime, "collector");
    assert.deepEqual([...advertised.bindings].sort(), ["filesystem", "local_device", "network"]);
    assert.deepEqual([...advertised.bundled_connectors].sort(), ["claude_code", "codex"]);
    assert.match(advertised.collector_protocol_version, /^\d+$/);

    if (await pathExists(path.join(cliPackageRoot, "package.json"))) {
      log("Installing packed @pdpp/cli alongside the collector and checking shim advertise output...");
      const cliTarball = await packPackage(cliPackageRoot);
      await run("npm", ["install", cliTarball], { cwd: projectDir, env });
      const shimAdvertise = await run("npx", ["pdpp", "collector", "advertise"], { cwd: projectDir, env });
      assert.deepEqual(JSON.parse(shimAdvertise.stdout), advertised);
      await rm(cliTarball, { force: true });
    } else {
      log("SKIP @pdpp/cli shim smoke: packages/cli/package.json was not present.");
    }

    if (await pathExists(referenceServerEntry)) {
      await runFixtureBackedEnrollRunSmoke({ projectDir, env, advertisedProtocolVersion: advertised.collector_protocol_version });
      await runProtocolMismatchSmoke({ projectDir, env });
    } else {
      log("SKIP fixture-backed enroll/run smoke: reference-implementation/server/index.js not present.");
      log("SKIP collector_protocol_mismatch smoke: reference-implementation/server/index.js not present.");
    }

    log("PASS pack-install-run local smoke");
  } finally {
    await rm(collectorTarball, { force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
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
async function runFixtureBackedEnrollRunSmoke({ projectDir, env, advertisedProtocolVersion }) {
  log("Booting in-process reference server for fixture-backed enroll/run smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  });
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const codexHome = await prepareCodexFixture();
  try {
    log("Creating enrollment code...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "pack-install-run-laptop",
    });
    assert.equal(codeResp.status, 201, `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`);
    const enrollmentCode = codeResp.body.enrollment_code;
    assert.ok(typeof enrollmentCode === "string" && enrollmentCode.length > 0, "enrollment_code must be a non-empty string");

    log("Running installed pdpp-local-collector enroll against the in-process reference server...");
    const enroll = await run(
      "npx",
      [
        "pdpp-local-collector",
        "enroll",
        "--base-url",
        baseUrl,
        "--code",
        enrollmentCode,
      ],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout);
    assert.match(enrollment.device_id, /^dexp_/);
    assert.equal(typeof enrollment.device_token, "string");
    assert.match(enrollment.connector_instance_id, /^cin_/);
    assert.equal(typeof enrollment.source_instance_id, "string");

    const devicesAfterEnroll = getDb()
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
    // The fixture only populates the filesystem-only `prompts` and `rules`
    // sub-stores under CODEX_HOME; the default codex stream set also
    // requests sessions / messages / function_calls / skills which would
    // require a real state_5.sqlite + rollout JSONL on disk. Narrow the
    // stream set so the connector preflight is satisfied by what the
    // fixture actually provides — the goal here is "records hit ingest at
    // all", not exhaustive stream coverage.
    const runResult = await run(
      "npx",
      [
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
    const runOutput = JSON.parse(runResult.stdout);
    assert.equal(runOutput.done?.status, "succeeded", `codex connector did not report DONE.status=succeeded: ${runResult.stdout}`);
    assert.ok((runOutput.recordsQueued ?? 0) > 0, `codex connector did not queue any records: ${runResult.stdout}`);
    assert.ok((runOutput.sentBatches ?? 0) > 0, `codex connector did not send any batches to the reference server: ${runResult.stdout}`);

    // Records land under the bare canonical connector key (`codex`), NOT a
    // `local-device:codex` storage prefix — connection isolation is carried by
    // connector_instance_id. See reference-implementation/server/db.js and the
    // canonicalize-connector-keys design (Decision 7).
    const persisted = getDb()
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
async function runProtocolMismatchSmoke({ projectDir, env }) {
  log("Booting in-process reference server pinned to an older protocol for the 409 mismatch smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  const server = await startServer({
    acceptedCollectorProtocolVersions: ["0"],
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  });
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  try {
    log("Creating enrollment code on the pinned server...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "pack-install-run-pinned",
    });
    assert.equal(codeResp.status, 201, `pinned enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`);
    const enrollmentCode = codeResp.body.enrollment_code;

    log("Calling pdpp-local-collector enroll against the pinned server (expecting 409)...");
    let failure = null;
    try {
      await run(
        "npx",
        [
          "pdpp-local-collector",
          "enroll",
          "--base-url",
          baseUrl,
          "--code",
          enrollmentCode,
        ],
        { cwd: projectDir, env }
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "pdpp-local-collector enroll should fail when the server pins an incompatible protocol");
    const combined = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${failure.message ?? ""}`;
    assert.match(combined, /409/, `runner error should mention HTTP status 409; got: ${combined}`);
    assert.match(
      combined,
      /collector_protocol_mismatch/,
      `runner error should surface the typed collector_protocol_mismatch code; got: ${combined}`
    );

    const devicesAfter = getDb().prepare("SELECT COUNT(*) as n FROM device_exporters").get();
    assert.equal(devicesAfter.n, 0, "rejected enroll must not have leaked a device row into the pinned server");

    log("collector_protocol_mismatch smoke PASS: enrollment refused before any device row was created.");
  } finally {
    await closeServer(server);
  }
}

async function postJson(url, body, headers = {}) {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  let parsed = null;
  try {
    parsed = await resp.json();
  } catch {}
  return { body: parsed, status: resp.status };
}

async function closeServer(server) {
  const closeOne = (srv) =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      try {
        srv?.closeAllConnections?.();
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
async function prepareCodexFixture() {
  const codexHome = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-codex-fixture-"));
  const promptsDir = path.join(codexHome, "prompts");
  const rulesDir = path.join(codexHome, "rules");
  await mkdir(promptsDir, { recursive: true });
  await mkdir(rulesDir, { recursive: true });
  await writeFile(
    path.join(promptsDir, "hello.md"),
    "---\nname: hello\ndescription: greet the operator\n---\n\nHello from the pack-install-run fixture.\n"
  );
  await writeFile(
    path.join(rulesDir, "trust.rules"),
    "# trust registry\nallow shell pwd\n"
  );
  return codexHome;
}

await main();
