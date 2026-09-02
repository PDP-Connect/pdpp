// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fleet check: every polyfill-connectors manifest's declared `icon` (if any)
 * must pass the real connector-manifest-validation allowlist gate. Regression
 * coverage for the fleet's icon data itself, distinct from
 * manifest-icon.test.ts (which covers the validator's behavior directly with
 * synthetic fixtures).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateManifestIcon } from "../server/connector-manifest-validation.ts";

const MANIFESTS_DIR = join(import.meta.dirname, "..", "..", "packages", "polyfill-connectors", "manifests");

test("every manifest's declared icon passes validateManifestIcon", () => {
  const files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith(".json"));
  assert.ok(files.length > 0, "expected manifest files to exist");
  let withIcon = 0;
  for (const file of files) {
    const raw = readFileSync(join(MANIFESTS_DIR, file), "utf8");
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    if (manifest.icon !== undefined) {
      withIcon++;
      assert.doesNotThrow(
        () => validateManifestIcon(manifest, "invalid_request"),
        `${file}: icon failed validation`
      );
    }
  }
  console.log(`${withIcon} of ${files.length} manifests declare an icon`);
});
