import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runMassRatchet } from "./check-mass-ratchet.mjs";

const FIXTURE_FINGERPRINT = { biomeVersion: "2.4.12", maxAllowedComplexity: 5 };
const OTHER_FINGERPRINT = { biomeVersion: "0.3.3", maxAllowedComplexity: 5 };

async function withFixture(files, fn) {
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

function fixtureMeasure(measuredFiles) {
  return async () => ({
    files: measuredFiles,
    total: Object.values(measuredFiles).reduce((sum, mass) => sum + mass, 0),
  });
}

function fixtureFingerprint(fingerprint = FIXTURE_FINGERPRINT) {
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
        files: ["server/a.js"],
        baselinePath,
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
        files: ["server/a.js"],
        baselinePath,
        justificationsPath,
        measure: fixtureMeasure({ "server/a.js": 4 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.failures, [
        { file: "server/a.js", baseline: 3, current: 4, allowed: 3, justified: false },
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
        files: ["server/a.js"],
        baselinePath,
        justificationsPath,
        measure: fixtureMeasure({ "server/a.js": 1 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.tightened, [{ file: "server/a.js", before: 4, after: 1 }]);
      assert.deepEqual(JSON.parse(await readFile(baselinePath, "utf8")), {
        files: { "server/a.js": 1, "server/b.js": 2 },
        total: 3,
        meta: FIXTURE_FINGERPRINT,
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
        files: ["runtime/new.js"],
        baselinePath,
        justificationsPath,
        measure: fixtureMeasure({ "runtime/new.js": 2 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.failures, [
        { file: "runtime/new.js", baseline: 0, current: 2, allowed: 0, justified: false },
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
          reason: "temporary migration bridge",
          date: "2026-07-06",
        },
      },
    },
    async ({ baselinePath, justificationsPath }) => {
      const result = await runMassRatchet({
        all: false,
        files: ["lib/legacy.js"],
        baselinePath,
        justificationsPath,
        measure: fixtureMeasure({ "lib/legacy.js": 5 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, true);
      assert.match(result.messages.join("\n"), /ACTIVE MASS JUSTIFICATIONS:/);
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
        files: ["server/a.js"],
        baselinePath,
        justificationsPath,
        measure: fixtureMeasure({}),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.tightened, [{ file: "server/a.js", before: 2, after: 0 }]);
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
        files: [],
        baselinePath,
        justificationsPath,
        measure: fixtureMeasure({ "server/a.js": 2, "server/b.js": 6 }),
        resolveFingerprint: fixtureFingerprint(),
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.failures, [
        { file: "server/b.js", baseline: 5, current: 6, allowed: 5, justified: false },
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
          files: ["server/a.js"],
          baselinePath,
          justificationsPath,
          measure: fixtureMeasure({ "server/a.js": 0 }),
          resolveFingerprint: fixtureFingerprint(FIXTURE_FINGERPRINT),
        }),
        /fingerprint mismatch/i
      );
      assert.deepEqual(JSON.parse(await readFile(baselinePath, "utf8")), {
        files: { "server/a.js": 3 },
        total: 3,
        meta: OTHER_FINGERPRINT,
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
          files: ["server/a.js"],
          baselinePath,
          justificationsPath,
          measure: fixtureMeasure({ "server/a.js": 3 }),
          resolveFingerprint: fixtureFingerprint(),
        }),
        /fingerprint mismatch/i
      );
    }
  );
});
