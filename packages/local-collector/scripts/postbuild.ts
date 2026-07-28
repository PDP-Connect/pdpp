// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");

const shortShaPattern = /^[0-9a-f]{7,40}$/;
const testFilePattern = /(^|\/).+\.test\.js$/;
const tsImportPattern = /((?:\.\.?\/)[^"']+)\.ts(["'])/g;

const declarationKeep = new Set(
  [
    "local-collector/src/errors.d.ts",
    "local-collector/src/runner.d.ts",
    "polyfill-connectors/src/collector-build-info.d.ts",
    "polyfill-connectors/src/collector-protocol.d.ts",
    "polyfill-connectors/src/collector-runner.d.ts",
    "polyfill-connectors/src/connector-runtime-protocol.d.ts",
    "polyfill-connectors/src/is-main-module.d.ts",
    "polyfill-connectors/src/local-device-client.d.ts",
    "polyfill-connectors/src/local-device-envelope.d.ts",
    "polyfill-connectors/src/local-device-outbox.d.ts",
    "polyfill-connectors/src/local-device-queue.d.ts",
    "polyfill-connectors/src/runner/index.d.ts",
    "polyfill-connectors/src/runtime-capabilities.d.ts",
    "polyfill-connectors/src/safe-emit.d.ts",
    "polyfill-connectors/src/scope-filters.d.ts",
  ].map((entry) => path.normalize(entry))
);

await rewriteDeclarations(distRoot);
await replaceBrowserLauncherWithPublishedGuard();
await rm(path.join(distRoot, ".tsbuildinfo"), { force: true });
await chmod(path.join(distRoot, "local-collector", "bin", "pdpp-local-collector.js"), 0o755);
await stampBuildInfo();

/**
 * Overwrite the compiled `collector-build-info.js` with the real build identity.
 *
 * The committed source module reports the `source` sentinel so dev/`tsx`/test
 * runs are deterministic; here, where a build is necessarily running inside the
 * repo, we bake in the resolved package version, a short git revision, and the
 * build timestamp so a *built* artifact reports its true revision on heartbeats.
 *
 * Honest fallback: when neither `git` nor `PDPP_BUILD_REVISION` yields a
 * revision (a git-less CI build), keep the `source` sentinel rather than
 * fabricating one or crashing the build. Redaction-safe: only a version string,
 * a short SHA, and an ISO timestamp are written — never a path, branch, or token.
 */
async function stampBuildInfo(): Promise<void> {
  const compiled = path.join(distRoot, "polyfill-connectors", "src", "collector-build-info.js");
  const version = await resolvePackageVersion();
  const revision = resolveBuildRevision();
  const builtAt = resolveBuildTimestamp();
  const body = `const COLLECTOR_BUILD_SOURCE_SENTINEL = "source";
const COLLECTOR_BUILD_INFO = {
    builtAt: ${JSON.stringify(builtAt)},
    revision: ${JSON.stringify(revision)},
    version: ${JSON.stringify(version)},
};
function buildAgentVersion(info = COLLECTOR_BUILD_INFO) {
    return \`\${info.version}+\${info.revision}\`;
}
export { COLLECTOR_BUILD_INFO, COLLECTOR_BUILD_SOURCE_SENTINEL, buildAgentVersion };
`;
  await writeFile(compiled, body);
}

/** Use a validated release timestamp when the matrix needs byte-identical rows. */
function resolveBuildTimestamp() {
  const fromEnv = process.env.PDPP_BUILD_TIMESTAMP;
  // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  if (typeof fromEnv === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fromEnv.trim())) {
    const normalized = new Date(fromEnv.trim()).toISOString();
    if (normalized === fromEnv.trim()) {
      return normalized;
    }
  }
  return new Date().toISOString();
}

/** Resolve the published collector package version from its own manifest. */
async function resolvePackageVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    return typeof manifest.version === "string" && manifest.version ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Short build revision: an explicit `PDPP_BUILD_REVISION` (CI/release override)
 * wins; otherwise a 12-char git short-SHA from the repo the build runs in; else
 * the honest `source` sentinel. The value is validated to a hex short-SHA or the
 * sentinel so a malformed override can never inject a path or arbitrary text.
 */
function resolveBuildRevision(): string {
  const fromEnv = process.env.PDPP_BUILD_REVISION;
  if (typeof fromEnv === "string" && shortShaPattern.test(fromEnv.trim())) {
    return fromEnv.trim();
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (shortShaPattern.test(sha)) {
      return sha;
    }
  } catch {
    // No git available (e.g. a tarball build outside a checkout); fall through.
  }
  return "source";
}

async function rewriteDeclarations(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs: string[] = [];
  const deletes: Promise<void>[] = [];
  const updates: Promise<void>[] = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.push(full);
      continue;
    }
    const rel = path.relative(distRoot, full);
    if (
      testFilePattern.test(rel) ||
      [
        "polyfill-connectors/src/pilot-fixture-test-helper.js",
        "polyfill-connectors/src/profile-lock.js",
        "polyfill-connectors/src/runtime-environment.js",
        "polyfill-connectors/src/test-harness.js",
      ].includes(path.normalize(rel))
    ) {
      deletes.push(rm(full, { force: true }));
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) {
      continue;
    }
    if (!declarationKeep.has(path.normalize(rel))) {
      deletes.push(rm(full, { force: true }));
      continue;
    }
    updates.push(readFile(full, "utf8").then((text) => writeFile(full, text.replace(tsImportPattern, "$1.js$2"))));
  }

  await Promise.all([...deletes, ...updates, ...dirs.map((d) => rewriteDeclarations(d))]);
}

/**
 * Replace the private browser launcher with a closure-complete, fail-closed
 * facade. `connector-runtime.js` keeps a literal lazy import so the generic
 * runtime can be shared with the workspace, but this package deliberately
 * ships only filesystem-class connectors. Leaving the target absent turns an
 * unsupported browser request into ERR_MODULE_NOT_FOUND instead of the typed,
 * actionable capability failure promised by the package boundary.
 */
async function replaceBrowserLauncherWithPublishedGuard(): Promise<void> {
  const target = path.join(distRoot, "polyfill-connectors", "src", "browser-launch.js");
  const body = `const BROWSER_RUNTIME_UNAVAILABLE_CODE = "browser_runtime_unavailable";
class HeadedBrowserUnavailableError extends Error {
    constructor({ message }) {
        super(message);
        this.name = "HeadedBrowserUnavailableError";
        this.code = BROWSER_RUNTIME_UNAVAILABLE_CODE;
    }
}
class CdpAttachSessionRaceExhaustedError extends Error {
    constructor(message) {
        super(message);
        this.name = "CdpAttachSessionRaceExhaustedError";
        this.code = "browser_surface_attach_exhausted";
    }
}
async function acquireBrowserForConnector() {
    throw new HeadedBrowserUnavailableError({
        message: "browser runtime unavailable: @pdpp/local-collector bundles filesystem-class connectors only; run browser-bound connectors from the PDPP monorepo until a browser-collector publishability decision lands.",
    });
}
export { CdpAttachSessionRaceExhaustedError, HeadedBrowserUnavailableError, acquireBrowserForConnector };
`;
  await writeFile(target, body);
}
