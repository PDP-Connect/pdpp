// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { suiteEnvironment } from "../test-accounting/authority.ts";
import { type Suite, TEST_SCRATCH_CAPABILITY_ENVIRONMENT } from "../test-accounting/inventory.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const childTest = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";

test("canonical child denies foreign origins and revokes its own bind", async () => {
  assert.equal(process.env.PDPP_HERMETIC_GUARD, "1");
  for (const name of ["PDPP_CANARY_API_KEY", "DATABASE_URL", "PGPASSWORD"]) {
    assert.equal(process.env[name], undefined, name + " reached a test child");
  }
  if (process.env.CHECK_MISSING_UNDICI === "1") {
    const require = createRequire(join(process.cwd(), "package.json"));
    assert.throws(() => require.resolve("undici"), { code: "MODULE_NOT_FOUND" });
  }
  await assert.rejects(fetch(process.env.CANARY_URL), /blocked non-allowlisted origin/);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = http.request(process.env.CANARY_URL, resolve);
    request.on("error", reject);
    request.end();
  }), /blocked non-allowlisted origin/);

  const owned = http.createServer((_request, response) => response.end("owned"));
  await new Promise((resolve) => owned.listen(0, "127.0.0.1", resolve));
  const address = owned.address();
  assert.ok(address && typeof address !== "string");
  const ownedUrl = "http://127.0.0.1:" + address.port + "/";
  try {
    assert.equal(await (await fetch(ownedUrl)).text(), "owned");
  } finally {
    await new Promise((resolve) => owned.close(resolve));
  }
  await assert.rejects(fetch(ownedUrl), /blocked non-allowlisted origin/);
  assert.equal(await (await fetch("data:text/plain,local")).text(), "local");
});
`;

async function runChild(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const [file, ...args] = command;
  assert.ok(file);
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child exit ${code}: ${output}`));
        return;
      }
      if (!output.includes("pass 1")) {
        reject(new Error(`child did not execute canary test: ${output}`));
        return;
      }
      resolve(output);
    });
  });
}

test("canonical launchers deny fetch and http to a parent-owned canary", async () => {
  let canaryRequests = 0;
  const canary = http.createServer((_request, response) => {
    canaryRequests += 1;
    response.end("unexpected");
  });
  await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
  const address = canary.address();
  assert.ok(address && typeof address !== "string");
  const fixtureDir = await mkdtemp(join(homedir(), ".tmp", "pdpp-hermetic-canary-"));
  const fixture = join(fixtureDir, "canary.test.mjs");
  await writeFile(fixture, childTest);
  const inherited = {
    ...process.env,
    CANARY_URL: `http://127.0.0.1:${address.port}/`,
    PDPP_CANARY_API_KEY: "fixture-only",
    DATABASE_URL: "fixture-only",
    PGPASSWORD: "fixture-only",
  };
  // Node marks the outer test worker to prevent recursive discovery. These
  // commands model an independent canonical launch, not an inner test runner.
  inherited.NODE_TEST_CONTEXT = undefined;
  inherited.NODE_OPTIONS = undefined;
  inherited.PDPP_HERMETIC_GUARD = undefined;
  try {
    // Package test scripts use this runner. The runner must install the guard
    // before the test child and pass it to any Node descendants.
    await runChild([process.execPath, join(root, "scripts/run-node-tests.mjs"), "--test", fixture], root, inherited);
    assert.equal(canaryRequests, 0, "package runner reached the parent canary");

    // Root *:test aliases enter through the scratch owner, often with a raw
    // `node --test` command rather than run-node-tests.mjs.
    const scratchEnv = { ...inherited };
    // This is a separate root alias, so it must receive a fresh scratch owner.
    for (const name of TEST_SCRATCH_CAPABILITY_ENVIRONMENT) {
      scratchEnv[name] = undefined;
    }
    for (const name of ["TMPDIR", "TMP", "TEMP", "TEST_TMPDIR"]) {
      scratchEnv[name] = undefined;
    }
    await runChild(
      [
        process.execPath,
        "--import",
        "tsx",
        join(root, "scripts/test-scratch/run-command.ts"),
        "--",
        process.execPath,
        "--test",
        fixture,
      ],
      root,
      scratchEnv
    );
    assert.equal(canaryRequests, 0, "root test alias reached the parent canary");

    // Accounting leaves get their environment from suiteEnvironment. npm
    // undici is unavailable from this root working directory.
    const manifest = JSON.parse(await readFile(join(root, "test-accounting.manifest.json"), "utf8")) as {
      suites: Suite[];
    };
    const suite = manifest.suites.find((entry) => entry.id === "root-node");
    assert.ok(suite);
    const leafEnv = suiteEnvironment({ ...inherited, CHECK_MISSING_UNDICI: "1" }, "default", suite);
    await runChild([process.execPath, "--test", fixture], root, leafEnv);
    assert.equal(canaryRequests, 0, "accounting leaf reached the parent canary");
  } finally {
    await new Promise<void>((resolve) => canary.close(() => resolve()));
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
