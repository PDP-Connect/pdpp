// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads every shipped connector manifest from this package's own
 * `manifests/` directory.
 *
 * This package owns connector/provider knowledge — the manifests here ARE
 * that knowledge, declared as data. The reference implementation must not
 * independently walk this directory itself (filesystem discovery of
 * connector manifests is connector-package knowledge, not RI knowledge), so
 * this is the one sanctioned place that enumerates and parses them; RI-side
 * consumers (the connector-registry generator, the seed command) import
 * `readPolyfillManifests` instead of touching `node:fs` against this
 * directory directly.
 *
 * `PDPP_POLYFILL_MANIFESTS_DIR` overrides the directory read, for tests that
 * need to inject a synthetic/probe manifest without writing into the real,
 * shared `manifests/` directory. Unset in normal use.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const realManifestsDir = join(packageDir, "..", "manifests");

export interface PolyfillManifestEntry {
  file: string;
  manifest: unknown;
}

function readManifestFile(manifestPath: string): unknown {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/** Every `*.json` file directly under this package's real, shipped `manifests/` directory, parsed. */
function readRealPolyfillManifests(): PolyfillManifestEntry[] {
  const out: PolyfillManifestEntry[] = [];
  for (const file of readdirSync(realManifestsDir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    out.push({ file, manifest: readManifestFile(join(realManifestsDir, file)) });
  }
  return out;
}

/** Every `*.json` file directly under an env-var-selected override directory (tests only), parsed. */
function readOverridePolyfillManifests(overrideDir: string): PolyfillManifestEntry[] {
  const out: PolyfillManifestEntry[] = [];
  for (const file of readdirSync(overrideDir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    out.push({ file, manifest: readManifestFile(join(overrideDir, file)) });
  }
  return out;
}

/** Every `*.json` file directly under this package's `manifests/` directory (or the test override), parsed. */
export function readPolyfillManifests(): PolyfillManifestEntry[] {
  return process.env.PDPP_POLYFILL_MANIFESTS_DIR
    ? readOverridePolyfillManifests(process.env.PDPP_POLYFILL_MANIFESTS_DIR)
    : readRealPolyfillManifests();
}
