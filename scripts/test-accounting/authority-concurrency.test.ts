// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const LEAF_DEADLINE_PATTERN = /fixture-b\/default exceeded total leaf deadline/;
const DID_NOT_PASS_PATTERN = /fixture-a\/default did not pass/;
const DIRTY_TREE_PATTERN = /worktree has untracked or changed paths: \?\? fixture-leftover\.txt/;
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
  assert.equal(suiteConcurrency({}), 2);
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

interface FixtureSpec {
  // Structured-output suites: the authority parses the child's stdout.
  authorityRunner?: boolean;
  command: string[];
  id: string;
  prepare?: string[];
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

// Leaves that leave a start marker, record how many leaves are alive when they
// start, hold, leave an end marker, and exit with the given code.
const MARKED_LEAF_SCRIPT = `
const fs = require("node:fs");
const [dir, id, holdMs, exitCode] = process.argv.slice(1);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.writeFileSync(dir + "/" + id + ".running", "");
fs.appendFileSync(dir + "/peak.log", fs.readdirSync(dir).filter((name) => name.endsWith(".running")).length + "\\n");
fs.writeFileSync(dir + "/" + id + ".start", "");
pause(Number(holdMs));
fs.writeFileSync(dir + "/" + id + ".end", "");
fs.rmSync(dir + "/" + id + ".running");
process.exit(Number(exitCode));
`;

const markedLeaf = (dir: string, id: string, holdMs: number, exitCode = 0): FixtureSpec => ({
  id,
  command: ["node", "-e", MARKED_LEAF_SCRIPT, dir, id, String(holdMs), String(exitCode)],
});
const markerPath = (dir: string, id: string, kind: "start" | "end") => join(dir, `${id}.${kind}`);
const peakConcurrency = (dir: string) =>
  Math.max(...readFileSync(join(dir, "peak.log"), "utf8").trim().split("\n").map(Number));

// How many authorities, completion records and receipts the run directory holds
// per suite, found without runAuthority's help so a failed run is inspectable too.
type RunLedger = Record<string, { authorities: number; completions: number; receipts: number }>;

function runDirectory(root: string): string {
  return resolve(
    root,
    execFileSync("git", ["rev-parse", "--git-path", "test-accounting/runs"], { cwd: root, encoding: "utf8" }).trim()
  );
}

function readRunReceipts(root: string): FixtureReceipt[] {
  const directory = runDirectory(root);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".receipt.json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as FixtureReceipt);
}

function readRunLedger(root: string): RunLedger {
  const directory = runDirectory(root);
  const names = existsSync(directory) ? readdirSync(directory) : [];
  const ledger: RunLedger = {};
  for (const name of names.filter((entry) => entry.endsWith(".authority.json"))) {
    const runId = name.slice(0, -".authority.json".length);
    const { suite } = JSON.parse(readFileSync(join(directory, name), "utf8")) as { suite: string };
    const entry = ledger[suite] ?? { authorities: 0, completions: 0, receipts: 0 };
    ledger[suite] = entry;
    entry.authorities += 1;
    entry.completions += names.filter((other) => other === `${runId}.completion.json`).length;
    entry.receipts += names.filter((other) => other === `${runId}.receipt.json`).length;
  }
  return ledger;
}

async function withFixtureSuites<T>(
  concurrency: string,
  makeSpecs: (markers: string) => FixtureSpec[],
  inspect: (outcome: { markers: string; receipts: FixtureReceipt[]; ledger: RunLedger; error?: unknown }) => T,
  run: typeof runAuthority = runAuthority
): Promise<T> {
  const markers = mkdtempSync(join(tmpdir(), "pdpp-suite-concurrency-"));
  try {
    let result: T | undefined;
    await withRealWorktree(async (root) => {
      const manifestValue = readManifestFile(root);
      const fixtureDir = "scripts/test-accounting/fixtures/suite-concurrency-fixture";
      mkdirSync(join(root, fixtureDir), { recursive: true });
      const specs = makeSpecs(markers);
      for (const spec of specs) {
        writeFileSync(
          join(root, fixtureDir, `${spec.id}.test.ts`),
          "// fixture: the manifest command never loads this file.\n"
        );
        manifestValue.suites.push({
          id: spec.id,
          cwd: ".",
          loader: "shell",
          authority_argument: spec.authorityRunner ? "--authority" : null,
          execution: spec.authorityRunner ? "authority-runner" : "direct",
          profiles: [{ id: "default", required: true, skip_reasons: {} }],
          command: spec.command,
          include: [`${fixtureDir}/${spec.id}.test.ts`],
          ...(spec.prepare ? { prepare: spec.prepare } : {}),
        });
      }
      writeManifestFile(root, manifestValue);
      commitAll(root, "fixture: add suites whose leaves exercise the suite pool");

      let error: unknown;
      try {
        await run({
          root,
          suites: specs.map((spec) => spec.id),
          env: { ...process.env, PDPP_ACCOUNTING_SUITE_CONCURRENCY: concurrency },
        });
      } catch (caught) {
        error = caught;
      }
      const ledger = readRunLedger(root);
      const receipts = (Object.keys(ledger).length ? readRunReceipts(root) : []).sort((x, y) =>
        x.suite.localeCompare(y.suite)
      );
      result = inspect({ markers, receipts, ledger, error });
    });
    return result as T;
  } finally {
    rmSync(markers, { recursive: true, force: true });
  }
}

const peerSpecs =
  (waitMs: number, holdMs: number, firstCommand?: string[]) =>
  (markers: string): FixtureSpec[] =>
    [
      ["fixture-a", "fixture-b"],
      ["fixture-b", "fixture-a"],
    ].map(([id, peer]) => ({
      id: id as string,
      command:
        id === "fixture-a" && firstCommand
          ? firstCommand
          : [
              "node",
              "-e",
              LEAF_SCRIPT,
              join(markers, id as string),
              join(markers, peer as string),
              String(waitMs),
              String(holdMs),
            ],
    }));

test("two suites run at the same time, each with its own complete verified receipt", async () => {
  // Serial execution would deadlock here: fixture-a waits up to 20s for
  // fixture-b's marker, which fixture-b writes only after fixture-a has exited.
  const receipts = await withFixtureSuites("2", peerSpecs(20_000, 200), (outcome) => {
    assert.equal(outcome.error, undefined);
    return outcome.receipts;
  });
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
  const receipts = await withFixtureSuites("1", peerSpecs(0, 300), (outcome) => {
    assert.equal(outcome.error, undefined);
    return outcome.receipts;
  });
  const [a, b] = receipts as [FixtureReceipt, FixtureReceipt];
  assert.equal(a.suite, "fixture-a");
  assert.ok(a.ended_at <= b.started_at, "fixture-b must not start before fixture-a has finished");
});

test("width N never has more than N runs alive, and uses all N lanes", async () => {
  await withFixtureSuites(
    "2",
    (markers) => ["fixture-a", "fixture-b", "fixture-c", "fixture-d"].map((id) => markedLeaf(markers, id, 800)),
    ({ markers, receipts, error }) => {
      // Four runs that each outlive the others' startup would all be alive at
      // once without the bound; exactly 2 shows both the bound and full use.
      assert.equal(error, undefined);
      assert.equal(receipts.length, 4);
      assert.equal(peakConcurrency(markers), 2);
    }
  );
});

const SEALED = { authorities: 1, completions: 1, receipts: 1 };
const PREPARE_MARKER_COMMAND = (marker: string) => [
  "node",
  "-e",
  `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
];

test("a failing spawn lets the in-flight sibling finish and be sealed, starts nothing queued, then reports the failure", async () => {
  await withFixtureSuites(
    "2",
    (markers) => [
      { id: "fixture-a", command: ["definitely-not-a-real-binary"] },
      markedLeaf(markers, "fixture-b", 600),
      markedLeaf(markers, "fixture-c", 0),
      {
        ...markedLeaf(markers, "fixture-d", 0),
        prepare: PREPARE_MARKER_COMMAND(markerPath(markers, "fixture-d", "start")),
      },
    ],
    ({ markers, ledger, error }) => {
      assert.match((error as Error | undefined)?.message ?? "", SPAWN_FAILURE_PATTERN);
      assert.ok(existsSync(markerPath(markers, "fixture-b", "end")), "the running sibling must finish, not be killed");
      assert.ok(!existsSync(markerPath(markers, "fixture-c", "start")), "a queued run must never start");
      assert.ok(!existsSync(markerPath(markers, "fixture-d", "start")), "the prepare phase must never start");
      assert.deepEqual(ledger, {
        "fixture-a": { authorities: 1, completions: 0, receipts: 0 },
        "fixture-b": SEALED,
      });
    }
  );
});

test("a leaf that exits non-zero stops new starts, lets its sibling finish, and fails the gate", async () => {
  await withFixtureSuites(
    "2",
    (markers) => [
      markedLeaf(markers, "fixture-a", 0, 1),
      markedLeaf(markers, "fixture-b", 600),
      markedLeaf(markers, "fixture-c", 0),
      {
        ...markedLeaf(markers, "fixture-d", 0),
        prepare: PREPARE_MARKER_COMMAND(markerPath(markers, "fixture-d", "start")),
      },
    ],
    ({ markers, ledger, error }) => {
      assert.match((error as Error | undefined)?.message ?? "", DID_NOT_PASS_PATTERN);
      assert.ok(existsSync(markerPath(markers, "fixture-b", "end")), "the running sibling must finish, not be killed");
      assert.ok(!existsSync(markerPath(markers, "fixture-c", "start")), "a queued run must never start");
      assert.ok(!existsSync(markerPath(markers, "fixture-d", "start")), "the prepare phase must never start");
      assert.deepEqual(ledger, { "fixture-a": SEALED, "fixture-b": SEALED });
    }
  );
});

test("a leaf with malformed structured output is a failure that stops new starts", async () => {
  await withFixtureSuites(
    "2",
    (markers) => [
      { id: "fixture-a", authorityRunner: true, command: ["node", "-e", "process.stdout.write('not json')"] },
      markedLeaf(markers, "fixture-b", 600),
      markedLeaf(markers, "fixture-c", 0),
    ],
    ({ markers, ledger, error }) => {
      assert.match((error as Error | undefined)?.message ?? "", DID_NOT_PASS_PATTERN);
      assert.ok(existsSync(markerPath(markers, "fixture-b", "end")), "the running sibling must finish, not be killed");
      assert.ok(!existsSync(markerPath(markers, "fixture-c", "start")), "a queued run must never start");
      assert.deepEqual(ledger, { "fixture-a": SEALED, "fixture-b": SEALED });
    }
  );
});

// The leaf deadline is read once, at module load, so the throwing run needs its
// own copy of the authority module loaded under a short deadline.
async function loadAuthorityWithLeafDeadline(ms: number): Promise<typeof runAuthority> {
  const previous = process.env.PDPP_ACCOUNTING_LEAF_DEADLINE_MS;
  process.env.PDPP_ACCOUNTING_LEAF_DEADLINE_MS = String(ms);
  try {
    const url = new URL("./authority.ts", import.meta.url);
    url.search = `?leaf-deadline-${ms}`;
    return ((await import(url.href)) as typeof import("./authority.ts")).runAuthority;
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "PDPP_ACCOUNTING_LEAF_DEADLINE_MS");
    } else {
      process.env.PDPP_ACCOUNTING_LEAF_DEADLINE_MS = previous;
    }
  }
}

test("the last run to leave may throw: the completed sibling is still sealed, verified, and the original error surfaces", async () => {
  // fixture-a completes while fixture-b runs; fixture-b then outlives the leaf
  // deadline and is killed, so the run that leaves last is the one that throws.
  const runWithDeadline = await loadAuthorityWithLeafDeadline(4000);
  await withFixtureSuites(
    "2",
    (markers) => [markedLeaf(markers, "fixture-a", 0), markedLeaf(markers, "fixture-b", 60_000)],
    ({ markers, ledger, error }) => {
      assert.match((error as Error | undefined)?.message ?? "", LEAF_DEADLINE_PATTERN);
      assert.ok(existsSync(markerPath(markers, "fixture-a", "end")), "the completed sibling ran to the end");
      assert.deepEqual(ledger, {
        "fixture-a": SEALED,
        "fixture-b": { authorities: 1, completions: 0, receipts: 0 },
      });
    },
    runWithDeadline
  );
});

test("a leftover file from a finished suite is not hidden by a later suite that removes it", async () => {
  // Serial order would reject fixture-a before fixture-c's setup ran. With
  // width 2, fixture-a ends while fixture-b still runs; fixture-c must not get
  // fixture-a's lane and delete the file before the checkout is judged at rest.
  await withFixtureSuites(
    "2",
    (markers) => [
      { id: "fixture-a", command: ["node", "-e", "require('node:fs').writeFileSync('fixture-leftover.txt', '')"] },
      markedLeaf(markers, "fixture-b", 1500),
      {
        id: "fixture-c",
        command: [
          "node",
          "-e",
          `require("node:fs").rmSync("fixture-leftover.txt", { force: true }); require("node:fs").writeFileSync(${JSON.stringify(markerPath(markers, "fixture-c", "start"))}, "")`,
        ],
      },
    ],
    ({ markers, error }) => {
      assert.match((error as Error | undefined)?.message ?? "", DIRTY_TREE_PATTERN);
      assert.ok(existsSync(markerPath(markers, "fixture-b", "end")), "the running sibling must finish, not be killed");
      assert.ok(!existsSync(markerPath(markers, "fixture-c", "start")), "the masking run must never start");
    }
  );
});
