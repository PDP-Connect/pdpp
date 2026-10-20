// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/vana-target.sh", import.meta.url));
test("PS failed preflight invalidates owned reports and bindings before missing dependencies", (t) => {
  const scratch = join(homedir(), ".tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "vana-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Conformance fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const output = join(root, ".git", "reports");
  mkdirSync(output);
  const owned = [
    "report.json",
    "report.md",
    "requirements.json",
    "target.json",
    "baseline.json",
    "baseline.md",
    "fixture-truth.json",
    "fixture-probes.json",
    "experimental-v0.2.json",
    "experimental-v0.2.md",
    "server.log",
  ];
  for (const name of [...owned, "suite-source.json", "unrelated-sentinel.txt"]) {
    writeFileSync(join(output, name), "previous invocation\n");
  }
  const result = spawnSync("bash", [runner, "run"], {
    encoding: "utf8",
    env: { ...process.env, PDPP_VANA_PS: root, PDPP_VANA_REF: sha, PDPP_VANA_REPORT_DIR: output },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes("Install PS dependencies"), result.stderr);
  for (const name of owned) {
    assert.equal(existsSync(join(output, name)), false, `${name} remains after failed preflight`);
  }
  assert.equal(readFileSync(join(output, "suite-source.json"), "utf8"), "previous invocation\n");
  assert.equal(readFileSync(join(output, "unrelated-sentinel.txt"), "utf8"), "previous invocation\n");
});
