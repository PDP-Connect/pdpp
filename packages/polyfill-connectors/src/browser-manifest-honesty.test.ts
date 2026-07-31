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

// Two distinct ways a connector can touch the reference browser runtime:
//
// 1. The whole-run framework mode: `runConnector({ ..., browser: {...} })`.
//    The `browser:` token here is an object-literal key (always followed by
//    `{` or another value), not a TS type annotation like `let browser:
//    SomeType` — requiring `{` after the colon distinguishes the two so a
//    local variable named `browser` cannot false-positive this check.
// 2. A scoped, ad-hoc acquisition for a bounded subset of a connector's own
//    logic, via the lower-level `acquireBrowserForConnector` primitive
//    directly (e.g. Slack's stars/user_groups/reminders/dm_read_states),
//    bypassing `runConnector`'s `browser:` config entirely. Importing that
//    primitive is what makes this reachable, regardless of what any local
//    variable is named.
export function connectorUsesBrowserRuntime(source: string): boolean {
  const usesRunConnectorBrowserConfig = /\brunConnector\s*\(/u.test(source) && /\bbrowser\s*:\s*\{/u.test(source);
  const usesScopedBrowserAcquisition = /\bacquireBrowserForConnector\b/u.test(source);
  return usesRunConnectorBrowserConfig || usesScopedBrowserAcquisition;
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

test("connectorUsesBrowserRuntime does not false-positive on a TS type annotation named browser", () => {
  const source = `
    runConnector({ name: "example" });
    async function f() {
      let browser: SomeIsolatedBrowserType;
      browser = await acquire();
    }
  `;
  assert.equal(connectorUsesBrowserRuntime(source), false);
});

test("connectorUsesBrowserRuntime detects the real runConnector({ browser: {...} }) shape", () => {
  const source = `
    runConnector({
      name: "example",
      browser: { profileName: "example" },
    });
  `;
  assert.equal(connectorUsesBrowserRuntime(source), true);
});

test("connectorUsesBrowserRuntime detects a scoped acquireBrowserForConnector() call outside runConnector's browser config", () => {
  const source = `
    import { acquireBrowserForConnector } from "../../src/browser-launch.ts";
    runConnector({ name: "example" });
    async function acquireScopedTransport() {
      const browser = await acquireBrowserForConnector({ headless: true, profileName: "example" });
      return browser;
    }
  `;
  assert.equal(connectorUsesBrowserRuntime(source), true);
});
