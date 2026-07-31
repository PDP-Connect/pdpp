// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { connectorUsesBrowserRuntimeTransitively } from "./browser-runtime-usage.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "browser-manifest-honesty-fixtures");

test("browser-backed connectors declare the browser runtime binding", () => {
  const missing: string[] = [];

  for (const name of readdirSync(CONNECTORS_DIR).sort()) {
    const connectorPath = join(CONNECTORS_DIR, name, "index.ts");
    if (!existsSync(connectorPath)) {
      continue;
    }
    if (!connectorUsesBrowserRuntimeTransitively(connectorPath)) {
      continue;
    }
    const manifestPath = join(MANIFESTS_DIR, `${name}.json`);
    assert.equal(existsSync(manifestPath), true, `${name} uses browser runtime but has no manifest`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      runtime_requirements?: { bindings?: { browser?: { required?: unknown } } };
    };
    // The binding must be DECLARED (required is an explicit boolean) so the
    // dependency stays visible to manifest reviewers — but `false` is a
    // legitimate, honest declaration for a connector that touches a browser
    // only for a bounded subset of optional streams and still spawns/collects
    // its non-browser streams normally with no browser binding available
    // (see openspec/specs/reference-implementation-architecture/spec.md
    // "Connector uses a browser only for a bounded set of optional streams").
    if (typeof manifest.runtime_requirements?.bindings?.browser?.required !== "boolean") {
      missing.push(name);
    }
  }

  assert.deepEqual(
    missing,
    [],
    "browser-backed connectors must declare runtime_requirements.bindings.browser.required as an explicit boolean"
  );
});

test("connectorUsesBrowserRuntimeTransitively does not false-positive on a TS type annotation named browser", () => {
  const entry = join(FIXTURES_DIR, "no-browser-type-annotation", "index.ts");
  assert.equal(connectorUsesBrowserRuntimeTransitively(entry), false);
});

test("connectorUsesBrowserRuntimeTransitively detects the real runConnector({ browser: {...} }) shape", () => {
  const entry = join(FIXTURES_DIR, "run-connector-literal-browser", "index.ts");
  assert.equal(connectorUsesBrowserRuntimeTransitively(entry), true);
});

test("connectorUsesBrowserRuntimeTransitively detects a scoped acquireBrowserForConnector() call outside runConnector's browser config", () => {
  const entry = join(FIXTURES_DIR, "scoped-acquire-direct", "index.ts");
  assert.equal(connectorUsesBrowserRuntimeTransitively(entry), true);
});

test("connectorUsesBrowserRuntimeTransitively catches a browser-acquisition helper factored into a separate imported module (helper-indirection bypass)", () => {
  const entry = join(FIXTURES_DIR, "helper-module-indirection", "index.ts");
  assert.equal(connectorUsesBrowserRuntimeTransitively(entry), true);
});

test("connectorUsesBrowserRuntimeTransitively catches runConnector({ browser: configVariable }) where the value is a variable, not a literal (non-literal-config bypass)", () => {
  const entry = join(FIXTURES_DIR, "run-connector-variable-browser", "index.ts");
  assert.equal(connectorUsesBrowserRuntimeTransitively(entry), true);
});

test("connectorUsesBrowserRuntimeTransitively catches an aliased import of acquireBrowserForConnector", () => {
  const entry = join(FIXTURES_DIR, "aliased-acquire-import", "index.ts");
  assert.equal(connectorUsesBrowserRuntimeTransitively(entry), true);
});

test("connectorUsesBrowserRuntimeTransitively catches a helper two hops deep (helper imports a helper)", () => {
  const entry = join(FIXTURES_DIR, "two-hop-helper-indirection", "index.ts");
  assert.equal(connectorUsesBrowserRuntimeTransitively(entry), true);
});

test("connectorUsesBrowserRuntimeTransitively returns false for a connector with no browser touch anywhere in its import closure", () => {
  const entry = join(FIXTURES_DIR, "no-browser-at-all", "index.ts");
  assert.equal(connectorUsesBrowserRuntimeTransitively(entry), false);
});
