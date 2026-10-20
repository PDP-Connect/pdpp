// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const binder = fileURLToPath(new URL("../scripts/bind-baseline.mjs", import.meta.url));
const spec = readFileSync(new URL("../../../spec-core.md", import.meta.url));
const DIRTY_TARGET = /dirty target/;

test("baseline binding refuses a changed target, wrong revision, or inconsistent report", (t) => {
  const root = mkdtempSync(join(tmpdir(), "baseline-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  writeFileSync(join(root, "source.txt"), "target bytes\n");
  git("add", "source.txt");
  git(
    "-c",
    "user.name=Conformance fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  );
  const sha = git("rev-parse", "HEAD");
  // Outputs are ignored so only target changes invalidate attribution.
  writeFileSync(join(root, ".git/info/exclude"), "*.json\n*.md\n");
  writeFileSync(
    join(root, "report.json"),
    JSON.stringify({
      specVersion: "0.1",
      target: { version: `fixture@${sha}` },
      requirements: [
        {
          outcome: "fail",
          cases: [
            {
              caseId: "RS-1/fixture",
              outcome: "fail",
              detail: "fixture",
              evidence: [
                {
                  response: {
                    body: JSON.stringify({
                      access_token: "disposable-bearer",
                      nested: { refresh_token: "disposable-refresh" },
                      status: "observed",
                    }),
                  },
                },
              ],
            },
          ],
        },
      ],
      summary: { failedRequirements: ["RS-1"], allApplicableMustsTestedAndPassed: false },
    })
  );
  writeFileSync(
    join(root, "requirements.json"),
    JSON.stringify({
      header: { specSha256: createHash("sha256").update(spec).digest("hex") },
    })
  );
  writeFileSync(join(root, "report.md"), "# Fixture report\n");
  writeFileSync(join(root, "target.json"), "{}\n");
  execFileSync(process.execPath, [binder, "--snapshot", join(root, "suite-source.json")]);
  const run = (pin = sha, exit = "1") =>
    spawnSync(
      process.execPath,
      [
        binder,
        "--out",
        root,
        "--target-checkout",
        root,
        "--target-sha",
        pin,
        "--target-repo",
        "example/target",
        "--suite-exit",
        exit,
      ],
      { encoding: "utf8" }
    );
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  const manifest = JSON.parse(readFileSync(join(root, "baseline.json"), "utf8"));
  assert.equal(manifest.target.sha, sha);
  assert.equal(manifest.spec.version, "0.1");
  assert.equal(manifest.suiteExit, 1);
  const published = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
  const body = JSON.parse(published.requirements[0].cases[0].evidence[0].response.body);
  assert.equal(body.access_token, "[REDACTED]");
  assert.equal(body.nested.refresh_token, "[REDACTED]");
  assert.equal(body.status, "observed");
  assert.equal(run("0".repeat(40)).status, 1);
  assert.equal(run(sha, "0").status, 1);
  const snapshotPath = join(root, "suite-source.json");
  const snapshot = readFileSync(snapshotPath, "utf8");
  writeFileSync(snapshotPath, JSON.stringify({ sourceDigest: "different source" }));
  assert.equal(run().status, 1);
  writeFileSync(snapshotPath, snapshot);
  writeFileSync(join(root, "source.txt"), "modified target\n");
  const dirty = run();
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, DIRTY_TARGET);
  assert.equal(existsSync(join(root, "baseline.json")), false);
  assert.equal(existsSync(join(root, "baseline.md")), false);
});
