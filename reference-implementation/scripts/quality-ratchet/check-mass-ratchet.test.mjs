import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runMassRatchet } from "./check-mass-ratchet.mjs";

async function withFixture(files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "pdpp-mass-ratchet-test-"));
  const baselinePath = path.join(dir, "mass-baseline.json");
  const justificationsPath = path.join(dir, "mass-justifications.json");
  await writeFile(baselinePath, `${JSON.stringify(files.baseline ?? { files: {}, total: 0 }, null, 2)}\n`);
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
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.tightened, [{ file: "server/a.js", before: 4, after: 1 }]);
      assert.deepEqual(JSON.parse(await readFile(baselinePath, "utf8")), {
        files: { "server/a.js": 1, "server/b.js": 2 },
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
        files: ["runtime/new.js"],
        baselinePath,
        justificationsPath,
        measure: fixtureMeasure({ "runtime/new.js": 2 }),
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
      });
      assert.equal(result.ok, true);
      assert.match(result.messages.join("\n"), /ACTIVE MASS JUSTIFICATIONS:/);
      assert.match(result.messages.join("\n"), /temporary migration bridge/);
    }
  );
});
