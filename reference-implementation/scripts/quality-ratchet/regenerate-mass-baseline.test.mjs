// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { regenerateMassBaseline } from "./regenerate-mass-baseline.mjs";

test("regenerateMassBaseline measures the real workspace and writes a fingerprinted baseline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pdpp-mass-regen-test-"));
  const baselinePath = path.join(dir, "mass-baseline.json");
  try {
    const { fingerprint, files } = await regenerateMassBaseline({ baselinePath });
    assert.equal(fingerprint.biomeVersion, "2.4.12");
    assert.equal(fingerprint.maxAllowedComplexity, 5);
    assert.ok(Object.keys(files).length > 0);

    const written = JSON.parse(await readFile(baselinePath, "utf8"));
    assert.deepEqual(written.meta, fingerprint);
    assert.deepEqual(written.files, files);
    assert.equal(written.total, Object.values(files).reduce((sum, mass) => sum + mass, 0));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
