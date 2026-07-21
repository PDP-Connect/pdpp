import { execFileSync } from "node:child_process";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");

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
await rm(path.join(distRoot, "polyfill-connectors", "src", "browser-launch.js"), { force: true });
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
async function stampBuildInfo() {
  const compiled = path.join(distRoot, "polyfill-connectors", "src", "collector-build-info.js");
  const version = await resolvePackageVersion();
  const revision = resolveBuildRevision();
  const builtAt = new Date().toISOString();
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

/** Resolve the published collector package version from its own manifest. */
async function resolvePackageVersion() {
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
function resolveBuildRevision() {
  const fromEnv = process.env.PDPP_BUILD_REVISION;
  if (typeof fromEnv === "string" && /^[0-9a-f]{7,40}$/.test(fromEnv.trim())) {
    return fromEnv.trim();
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{7,40}$/.test(sha)) {
      return sha;
    }
  } catch {
    // No git available (e.g. a tarball build outside a checkout); fall through.
  }
  return "source";
}

async function rewriteDeclarations(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteDeclarations(full);
      continue;
    }
    const rel = path.relative(distRoot, full);
    if (
      /(^|\/).+\.test\.js$/.test(rel) ||
      [
        "polyfill-connectors/src/pilot-fixture-test-helper.js",
        "polyfill-connectors/src/profile-lock.js",
        "polyfill-connectors/src/runtime-environment.js",
        "polyfill-connectors/src/test-harness.js",
      ].includes(path.normalize(rel))
    ) {
      await rm(full, { force: true });
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) {
      continue;
    }
    if (!declarationKeep.has(path.normalize(rel))) {
      await rm(full, { force: true });
      continue;
    }
    const text = await readFile(full, "utf8");
    await writeFile(full, text.replace(/((?:\.\.?\/)[^"']+)\.ts(["'])/g, "$1.js$2"));
  }
}
