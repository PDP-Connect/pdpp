// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

function connectorUsesBrowserRuntime(source: string): boolean {
  return /\brunConnector\s*\(/u.test(source) && /\bbrowser\s*:/u.test(source);
}

test("browser-backed connectors declare the browser runtime binding", () => {
  const missing: string[] = [];

  for (const name of readdirSync(CONNECTORS_DIR).sort()) {
    const connectorPath = join(CONNECTORS_DIR, name, "index.ts");
    if (!existsSync(connectorPath)) {
      continue;
    }
    const source = readFileSync(connectorPath, "utf8");
    if (!connectorUsesBrowserRuntime(source)) {
      continue;
    }
    const manifestPath = join(MANIFESTS_DIR, `${name}.json`);
    assert.equal(existsSync(manifestPath), true, `${name} uses browser runtime but has no manifest`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      runtime_requirements?: { bindings?: { browser?: { required?: unknown } } };
    };
    if (manifest.runtime_requirements?.bindings?.browser?.required !== true) {
      missing.push(name);
    }
  }

  assert.deepEqual(
    missing,
    [],
    "browser-backed connectors must declare runtime_requirements.bindings.browser.required"
  );
});
