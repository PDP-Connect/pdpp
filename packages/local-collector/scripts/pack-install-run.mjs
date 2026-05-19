#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const cliPackageRoot = path.join(repoRoot, "packages/cli");
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

    log("PASS pack-install-run local smoke");
    log("NOTE fixture-backed enroll/run ingest smoke is not covered by this no-secrets local script.");
    log("NOTE collector_protocol_mismatch smoke requires a reference deployment pinned to an older protocol.");
  } finally {
    await rm(collectorTarball, { force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
