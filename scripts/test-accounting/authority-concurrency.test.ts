// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyLocalNodeTestConcurrency,
  assertIssuedArgvMatchesCommand,
  runAuthority,
  schedulePhases,
  suiteConcurrency,
} from "./authority.ts";
import type { Manifest } from "./inventory.ts";

const ARGV_MISMATCH_PATTERN = /differs from the argv bound/;
const SUITE_CONCURRENCY_PATTERN = /PDPP_ACCOUNTING_SUITE_CONCURRENCY must be a positive integer/;
const SPAWN_FAILURE_PATTERN = /ENOENT/;
const FIXTURE_COMMIT_CONFIG = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "user.email=fixture@example.test",
  "-c",
  "user.name=fixture",
];

// Same disposable-worktree fixture as authority-closure.e2e.test.ts: a real
// checkout of this repo's HEAD whose manifest the test extends, so the
// whole-manifest closure check still passes for the real suites.
async function withRealWorktree(run: (root: string) => Promise<void>): Promise<void> {
  const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const root = mkdtempSync(join(tmpdir(), "pdpp-suite-concurrency-wt-"));
  rmSync(root, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", root, "HEAD"], { cwd: repository });
  try {
    await run(root);
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", root], { cwd: repository });
    rmSync(root, { recursive: true, force: true });
  }
}
function commitAll(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", [...FIXTURE_COMMIT_CONFIG, "commit", "-q", "-s", "-m", message], { cwd: root });
}
function readManifestFile(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, "test-accounting.manifest.json"), "utf8"));
}
function writeManifestFile(root: string, manifestValue: Manifest): void {
  writeFileSync(join(root, "test-accounting.manifest.json"), `${JSON.stringify(manifestValue, null, 2)}\n`);
}

test("local direct Node test leaves run at most two files concurrently", () => {
  assert.deepEqual(applyLocalNodeTestConcurrency(["node", "--test", "--import", "tsx"], false), [
    "node",
    "--test",
    "--test-concurrency=2",
    "--import",
    "tsx",
  ]);
});

test("CI and explicitly bounded commands preserve their declared concurrency", () => {
  const command = ["node", "--test", "--import", "tsx"];
  assert.deepEqual(applyLocalNodeTestConcurrency(command, true), command);
  assert.deepEqual(applyLocalNodeTestConcurrency(["node", "--test", "--test-concurrency=1"], false), [
    "node",
    "--test",
    "--test-concurrency=1",
  ]);
});

test("non-test Node commands are unchanged", () => {
  const command = ["node", "--import", "tsx", "scripts/run-tests.ts"];
  assert.deepEqual(applyLocalNodeTestConcurrency(command, false), command);
});

test("executed commands must retain the argv bound into authority transcripts and receipts", () => {
  const issued = ["node", "--test", "--test-concurrency=2", "--import", "tsx"];
  assert.doesNotThrow(() => assertIssuedArgvMatchesCommand(issued, [...issued, "example.test.ts"]));
  assert.throws(
    () => assertIssuedArgvMatchesCommand(issued, ["node", "--test", "--import", "tsx", "example.test.ts"]),
    ARGV_MISMATCH_PATTERN
  );
});

const runStub = (id: string, prepare?: string[]) =>
  ({
    suite: { id, ...(prepare ? { prepare } : {}) },
    profile: { id: "default" },
    files: [],
    index: 0,
  }) as unknown as Parameters<typeof schedulePhases>[0][number];

test("suite concurrency defaults to the local width, stays serial in CI, and rejects garbage", () => {
  assert.equal(suiteConcurrency({}), 3);
  assert.equal(suiteConcurrency({ CI: "true" }), 1);
  assert.equal(suiteConcurrency({ PDPP_ACCOUNTING_SUITE_CONCURRENCY: "2", CI: "true" }), 2);
  assert.equal(suiteConcurrency({ PDPP_ACCOUNTING_SUITE_CONCURRENCY: "1" }), 1);
  for (const bad of ["0", "-1", "2.5", "two", " 2"]) {
    assert.throws(() => suiteConcurrency({ PDPP_ACCOUNTING_SUITE_CONCURRENCY: bad }), SUITE_CONCURRENCY_PATTERN);
  }
});

test("concurrency 1 keeps manifest order; wider runs put prepare suites last and alone", () => {
  const runs = [runStub("a"), runStub("site", ["node", "prepare.mjs"]), runStub("b"), runStub("c")];
  const ids = (phase: Parameters<typeof schedulePhases>[0]) => phase.map((run) => run.suite.id);

  const serial = schedulePhases(runs, 1);
  assert.deepEqual(
    serial.map(([phase, limit]) => [ids(phase), limit]),
    [[["a", "site", "b", "c"], 1]]
  );
  const wide = schedulePhases(runs, 3);
  assert.deepEqual(
    wide.map(([phase, limit]) => [ids(phase), limit]),
    [
      [["a", "b", "c"], 3],
      [["site"], 1],
    ]
  );
  assert.deepEqual(
    schedulePhases([runStub("site", ["node", "prepare.mjs"])], 3).map(([phase, limit]) => [ids(phase), limit]),
    [[["site"], 1]]
  );
});

interface FixtureReceipt {
  counts: { passed: number; failed: number };
  ended_at: string;
  exit_code: number;
  started_at: string;
  suite: string;
}

// Each fixture leaf writes its own marker file, then (if waitMs > 0) waits for
// its peer's marker before holding for holdMs. Two leaves with waitMs > 0 can
// only both exit 0 if they are alive at the same time.
const LEAF_SCRIPT = `
const fs = require("node:fs");
const [own, peer, waitMs, holdMs] = process.argv.slice(1);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.writeFileSync(own, "");
const deadline = Date.now() + Number(waitMs);
while (Number(waitMs) > 0 && !fs.existsSync(peer) && Date.now() < deadline) pause(20);
if (Number(waitMs) > 0 && !fs.existsSync(peer)) process.exit(1);
pause(Number(holdMs));
`;

async function runFixtureSuites(
  concurrency: string,
  waitMs: number,
  holdMs: number,
  firstCommand?: string[]
): Promise<FixtureReceipt[]> {
  const markers = mkdtempSync(join(tmpdir(), "pdpp-suite-concurrency-"));
  let receipts: FixtureReceipt[] = [];
  try {
    await withRealWorktree(async (root) => {
      const manifestValue = readManifestFile(root);
      const fixtureDir = "scripts/test-accounting/fixtures/suite-concurrency-fixture";
      mkdirSync(join(root, fixtureDir), { recursive: true });
      for (const [id, peer] of [
        ["fixture-a", "fixture-b"],
        ["fixture-b", "fixture-a"],
      ] as const) {
        writeFileSync(
          join(root, fixtureDir, `${id}.test.ts`),
          "// fixture: the manifest command never loads this file.\n"
        );
        manifestValue.suites.push({
          id,
          cwd: ".",
          loader: "shell",
          authority_argument: null,
          execution: "direct",
          profiles: [{ id: "default", required: true, skip_reasons: {} }],
          command:
            id === "fixture-a" && firstCommand
              ? firstCommand
              : ["node", "-e", LEAF_SCRIPT, join(markers, id), join(markers, peer), String(waitMs), String(holdMs)],
          include: [`${fixtureDir}/${id}.test.ts`],
        });
      }
      writeManifestFile(root, manifestValue);
      commitAll(root, "fixture: add two leaves that can only pass if they overlap");

      const { directory } = await runAuthority({
        root,
        suites: ["fixture-a", "fixture-b"],
        env: { ...process.env, PDPP_ACCOUNTING_SUITE_CONCURRENCY: concurrency },
      });
      receipts = readdirSync(directory)
        .filter((name) => name.endsWith(".receipt.json"))
        .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as FixtureReceipt)
        .sort((a, b) => a.suite.localeCompare(b.suite));
    });
  } finally {
    rmSync(markers, { recursive: true, force: true });
  }
  return receipts;
}

test("two suites run at the same time, each with its own complete verified receipt", async () => {
  // Serial execution would deadlock here: fixture-a waits up to 20s for
  // fixture-b's marker, which fixture-b writes only after fixture-a has exited.
  const receipts = await runFixtureSuites("2", 20_000, 200);
  assert.deepEqual(
    receipts.map((receipt) => [receipt.suite, receipt.exit_code, receipt.counts.passed, receipt.counts.failed]),
    [
      ["fixture-a", 0, 1, 0],
      ["fixture-b", 0, 1, 0],
    ]
  );
  const [a, b] = receipts as [FixtureReceipt, FixtureReceipt];
  assert.ok(a.started_at < b.ended_at && b.started_at < a.ended_at, "the two receipts must show overlapping runs");
});

test("concurrency 1 runs suites one after another in manifest order", async () => {
  const receipts = await runFixtureSuites("1", 0, 300);
  const [a, b] = receipts as [FixtureReceipt, FixtureReceipt];
  assert.equal(a.suite, "fixture-a");
  assert.ok(a.ended_at <= b.started_at, "fixture-b must not start before fixture-a has finished");
});

test("a failing run lets its in-flight sibling finish and then reports the failure", async () => {
  await assert.rejects(runFixtureSuites("2", 0, 300, ["definitely-not-a-real-binary"]), SPAWN_FAILURE_PATTERN);
});
