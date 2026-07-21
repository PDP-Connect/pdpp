import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

const KNOWN_EXTERNAL_TOOLS = ["slackdump"] as const;

test("connectors that reference known external tools declare them in manifests", () => {
  const missing: string[] = [];

  for (const name of readdirSync(CONNECTORS_DIR).sort()) {
    const connectorPath = join(CONNECTORS_DIR, name, "index.ts");
    if (!existsSync(connectorPath)) {
      continue;
    }
    const source = readFileSync(connectorPath, "utf8").toLowerCase();
    const referencedTools = KNOWN_EXTERNAL_TOOLS.filter((tool) => source.includes(tool));
    if (referencedTools.length === 0) {
      continue;
    }

    const manifestPath = join(MANIFESTS_DIR, `${name}.json`);
    assert.equal(existsSync(manifestPath), true, `${name} references external tools but has no manifest`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      runtime_requirements?: { external_tools?: Array<{ name?: unknown }> };
    };
    const declaredTools = new Set(
      (manifest.runtime_requirements?.external_tools || [])
        .map((tool) => tool.name)
        .filter((tool): tool is string => typeof tool === "string")
    );

    for (const tool of referencedTools) {
      if (!declaredTools.has(tool)) {
        missing.push(`${name}:${tool}`);
      }
    }
  }

  assert.deepEqual(missing, [], "external subprocess tool references must be declared in manifest metadata");
});
