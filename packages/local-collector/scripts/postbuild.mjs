import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");

const declarationKeep = new Set(
  [
    "local-collector/src/errors.d.ts",
    "local-collector/src/runner.d.ts",
    "polyfill-connectors/src/collector-protocol.d.ts",
    "polyfill-connectors/src/collector-runner.d.ts",
    "polyfill-connectors/src/connector-runtime-protocol.d.ts",
    "polyfill-connectors/src/is-main-module.d.ts",
    "polyfill-connectors/src/local-device-client.d.ts",
    "polyfill-connectors/src/local-device-envelope.d.ts",
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
