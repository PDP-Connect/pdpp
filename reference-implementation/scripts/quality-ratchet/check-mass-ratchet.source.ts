// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { MassFingerprint } from "./check-mass-ratchet.ts";
import { runMassRatchet } from "./check-mass-ratchet.ts";
import type { MassObject, MassWithTotal, MeasureMassOptions } from "./measure-mass.ts";

const FIXTURE_FINGERPRINT = { biomeVersion: "2.4.12", maxAllowedComplexity: 5 };
const OTHER_FINGERPRINT = { biomeVersion: "0.3.3", maxAllowedComplexity: 5 };

type FixtureFingerprint = typeof FIXTURE_FINGERPRINT | typeof OTHER_FINGERPRINT | null;
interface ResolveFingerprintOptions {
  rootDir?: string;
}
interface FixtureFiles {
  baseline?: { files: MassObject; total: number };
  justifications?: Record<string, { allowed_mass: number; date: string; reason: string }>;
  meta?: FixtureFingerprint;
}
interface FixturePaths {
  baselinePath: string;
  justificationsPath: string;
}

async function withFixture(files: FixtureFiles, fn: (paths: FixturePaths) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdpp-mass-ratchet-test-"));
  const baselinePath = path.join(dir, "mass-baseline.json");
  const justificationsPath = path.join(dir, "mass-justifications.json");
  const baseline = files.baseline ?? { files: {}, total: 0 };
  const meta = "meta" in files ? files.meta : FIXTURE_FINGERPRINT;
  await writeFile(baselinePath, `${JSON.stringify({ ...baseline, meta }, null, 2)}\n`);
  await writeFile(justificationsPath, `${JSON.stringify(files.justifications ?? {}, null, 2)}\n`);
  try {
    return await fn({ baselinePath, justificationsPath });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function fixtureMeasure(measuredFiles: MassObject): (options: MeasureMassOptions) => Promise<MassWithTotal> {
  return async () => ({
    files: measuredFiles,
    total: Object.values(measuredFiles).reduce((sum, mass) => sum + mass, 0),
  });
}

function fixtureFingerprint(
  fingerprint: Exclude<FixtureFingerprint, null> = FIXTURE_FINGERPRINT
): (options?: ResolveFingerprintOptions) => Promise<MassFingerprint> {
  return async () => fingerprint;
}

test("unchanged mass passes", async () => {
  await withFixture(
    {
      baseline: { files: { "server/a.js": 3 }, total: 3 },
    },
    async ({ baselinePath, justificationsPath }) => {
      const result = await runMassRatchet({
        all: false,
        baselinePath,
        files: ["server/a.js"],
        justificationsPath,
        measure: fixtureMeasure({ "server/a.js": 3 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.failures, []);
    }
  );
});

test("mass increase fails", async () => {
  await withFixture(
    {
      baseline: { files: { "server/a.js": 3 }, total: 3 },
    },
    async ({ baselinePath, justificationsPath }) => {
      const result = await runMassRatchet({
        all: false,
        baselinePath,
        files: ["server/a.js"],
        justificationsPath,
        measure: fixtureMeasure({ "server/a.js": 4 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.failures, [
        { allowed: 3, baseline: 3, current: 4, file: "server/a.js", justified: false },
      ]);
    }
  );
});

test("mass decrease auto-tightens baseline", async () => {
  await withFixture(
    {
      baseline: { files: { "server/a.js": 4, "server/b.js": 2 }, total: 6 },
    },
    async ({ baselinePath, justificationsPath }) => {
      const result = await runMassRatchet({
        all: false,
        baselinePath,
        files: ["server/a.js"],
        justificationsPath,
        measure: fixtureMeasure({ "server/a.js": 1 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.tightened, [{ after: 1, before: 4, file: "server/a.js" }]);
      assert.deepEqual(JSON.parse(await readFile(baselinePath, "utf8")), {
        files: { "server/a.js": 1, "server/b.js": 2 },
        meta: FIXTURE_FINGERPRINT,
        total: 3,
      });
    }
  );
});

test("new file with mass fails against zero baseline", async () => {
  await withFixture(
    {
      baseline: { files: {}, total: 0 },
    },
    async ({ baselinePath, justificationsPath }) => {
      const result = await runMassRatchet({
        all: false,
        baselinePath,
        files: ["runtime/new.js"],
        justificationsPath,
        measure: fixtureMeasure({ "runtime/new.js": 2 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.failures, [
        { allowed: 0, baseline: 0, current: 2, file: "runtime/new.js", justified: false },
      ]);
    }
  );
});

test("justification admits and reports mass above baseline", async () => {
  await withFixture(
    {
      baseline: { files: { "lib/legacy.js": 1 }, total: 1 },
      justifications: {
        "lib/legacy.js": {
          allowed_mass: 5,
          date: "2026-07-06",
          reason: "temporary migration bridge",
        },
      },
    },
    async ({ baselinePath, justificationsPath }) => {
      const result = await runMassRatchet({
        all: false,
        baselinePath,
        files: ["lib/legacy.js"],
        justificationsPath,
        measure: fixtureMeasure({ "lib/legacy.js": 5 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, true);
      // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
      assert.match(result.messages.join("\n"), /ACTIVE MASS JUSTIFICATIONS:/);
      // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
      assert.match(result.messages.join("\n"), /temporary migration bridge/);
    }
  );
});

test("true zero-diagnostic clean run passes when fingerprint matches", async () => {
  await withFixture(
    {
      baseline: { files: { "server/a.js": 2 }, total: 2 },
    },
    async ({ baselinePath, justificationsPath }) => {
      const result = await runMassRatchet({
        all: false,
        baselinePath,
        files: ["server/a.js"],
        justificationsPath,
        measure: fixtureMeasure({}),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.tightened, [{ after: 0, before: 2, file: "server/a.js" }]);
    }
  );
});

test("real diagnostics are still measured and compared correctly", async () => {
  await withFixture(
    {
      baseline: { files: { "server/a.js": 2, "server/b.js": 5 }, total: 7 },
    },
    async ({ baselinePath, justificationsPath }) => {
      const result = await runMassRatchet({
        all: true,
        baselinePath,
        files: [],
        justificationsPath,
        measure: fixtureMeasure({ "server/a.js": 2, "server/b.js": 6 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.failures, [
        { allowed: 5, baseline: 5, current: 6, file: "server/b.js", justified: false },
      ]);
    }
  );
});

test("baseline fingerprint mismatch fails closed instead of comparing or tightening", async () => {
  await withFixture(
    {
      baseline: { files: { "server/a.js": 3 }, total: 3 },
      meta: OTHER_FINGERPRINT,
    },
    async ({ baselinePath, justificationsPath }) => {
      await assert.rejects(
        runMassRatchet({
          all: false,
          baselinePath,
          files: ["server/a.js"],
          justificationsPath,
          measure: fixtureMeasure({ "server/a.js": 0 }),
          resolveFingerprint: fixtureFingerprint(FIXTURE_FINGERPRINT),
        }),
        // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
        /fingerprint mismatch/i
      );
      assert.deepEqual(JSON.parse(await readFile(baselinePath, "utf8")), {
        files: { "server/a.js": 3 },
        meta: OTHER_FINGERPRINT,
        total: 3,
      });
    }
  );
});

test("missing baseline fingerprint fails closed", async () => {
  await withFixture(
    {
      baseline: { files: { "server/a.js": 3 }, total: 3 },
      meta: null,
    },
    async ({ baselinePath, justificationsPath }) => {
      await assert.rejects(
        runMassRatchet({
          all: false,
          baselinePath,
          files: ["server/a.js"],
          justificationsPath,
          measure: fixtureMeasure({ "server/a.js": 3 }),
          resolveFingerprint: fixtureFingerprint(),
        }),
        // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
        /fingerprint mismatch/i
      );
    }
  );
});
