// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore-start lint/correctness/noUnresolvedImports: RI's own .js source is outside this migration's scope; allowJs resolves it structurally like RI's own tsconfig does.
import { storageProfileEnvironment } from "../../reference-implementation/scripts/test-profile-env.js";
import { runAuthority } from "./authority.ts";
import {
  checkInventory,
  classifyTrackedPath,
  contentDigest,
  fileDigest,
  type Manifest,
  parseInventoryArgs,
  RECEIPT_SCHEMA,
  type Receipt,
  RUN_AUTHORITY_SCHEMA,
  RUN_COMPLETION_SCHEMA,
  readManifest,
  receiptBinding,
  selectedRuns,
  trackedFiles,
  treeDigest,
  verifyReceipts,
} from "./inventory.ts";
import {
  POSTGRES_UNNAMED_SKIP_TEST_NAMES,
  repositoryPaths,
  structuredNodeSummary,
  structuredPythonSummary,
} from "./receipt.ts";

const BSKIP_TRUE_PATTERN = /\bskip\s*:\s*true\b/g;
const TEST_CALL_TITLE_PATTERN = /test\(\s*(['"])([\s\S]*?)\1/;
const SKIPPED_SKIPPED_PATTERN = /\(skipped:\s*([^)]+)\)|:\s*skipped\s*\(([^)]+)\)/i;
const UNACCOUNTED_EXECUTABLE_TESTS_ALPHA_TEST_PATTERN = /unaccounted executable tests.*alpha\.test\.ts/;
const UNACCOUNTED_EXECUTABLE_TESTS_PATTERN = /unaccounted executable tests/;
const SELECTS_NO_EXECUTABLE_TESTS_PATTERN = /selects no executable tests/;
const INVALID_SCHEMAS_PROVENANCE_PATTERN = /invalid schemas|provenance/;
const REPLAYED_PATTERN = /replayed/;
const EXPIRED_PATTERN = /expired/;
const ISSUED_AUTHORITY_FILES_DO_NOT_PATTERN = /issued authority|files do not match/;
const COMPLETION_DOES_NOT_BIND_PATTERN = /completion does not bind/;
const COMPLETION_DOES_NOT_BIND_GENERIC_PATTERN = /completion does not bind|generic/;
const UNDECLARED_PATTERN = /undeclared/;
const ISSUED_AUTHORITY_STALE_PATTERN = /issued authority|stale/;
const GENERIC_PATTERN = /generic/;
const COMPLETION_DOES_NOT_BIND_SKIPS_PATTERN = /completion does not bind|skips do not exactly match/;
const EXACTLY_ONE_MODE_PATTERN = /exactly one mode/;
const REQUIRES_EXACTLY_ONE_VALUE_PATTERN = /requires exactly one value/;
const UNKNOWN_ARGUMENT_PATTERN = /unknown argument/;
const CANNOT_COMBINE_ALL_PATTERN = /cannot combine all/;
const UNEXPLAINED_SKIP_PATTERN = /unexplained skip/;
const NO_STRUCTURED_NODE_EVENTS_PATTERN = /no structured node events/;
const OMITTED_A_SKIP_REASON_PATTERN = /omitted a skip reason/;
const TEST_SCRIPT_NAME_PATTERN = /^test(?::|$)/;
const OPTIONAL_ENVIRONMENT_PREDICATE_PATTERN = /optional environment predicate/;
const EXECUTABLE_TEST_FILE_PATTERN = /\.test\.(?:js|mjs|ts)$/;
const AUTHORITY_OR_ADAPTER_PATTERN = /authority|adapter/;

// biome-ignore-end lint/correctness/noUnresolvedImports: RI's own .js source is outside this migration's scope; allowJs resolves it structurally like RI's own tsconfig does.

const digest = async (path: string) => contentDigest(await readFile(path));
const files = [
  "test/helper.js",
  "test/fixture.json",
  "test/alpha.test.js",
  "test/runner.test.mjs",
  "tools/probe.test.py",
  "tools/check.test.sh",
  "src/component.test.tsx",
];

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schema: "pdpp.test-accounting/v3",
    inventory_base_sha: "1111111111111111111111111111111111111111",
    suites: [
      {
        id: "node",
        cwd: ".",
        loader: "node-test",
        authority_argument: "--authority",
        command: ["node", "runner.mjs"],
        profiles: [{ id: "default", required: true, skip_reasons: {} }],
        include: ["test/*.test.js", "test/*.test.mjs"],
      },
    ],
    exclusions: [
      {
        path: "tools/probe.test.py",
        reason: "python boundary",
        owner: "tooling",
        suite: "node",
        profile: "default",
        expires: "2027-12-31",
      },
      {
        path: "tools/check.test.sh",
        reason: "shell boundary",
        owner: "tooling",
        suite: "node",
        profile: "default",
        expires: "2027-12-31",
      },
      {
        path: "src/component.test.tsx",
        reason: "tsx boundary",
        owner: "tooling",
        suite: "node",
        profile: "default",
        expires: "2027-12-31",
      },
    ],
    ...overrides,
  };
}
async function fixture({
  expiresAt = "2030-07-23T00:00:00.000Z",
  counts = { assertions: 2, passed: 2, failed: 0, skipped: 0, skip_reasons: {}, planned_files: 2, completed_files: 2 },
  runId = "11111111-1111-4111-8111-111111111111",
}: {
  expiresAt?: string;
  counts?: Receipt["counts"];
  runId?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "pdpp-receipt-"));
  const directory = join(root, "authorities");
  await mkdir(join(root, "test"), { recursive: true });
  await mkdir(directory);
  await writeFile(join(root, "test", "alpha.test.js"), "export const alpha = true;\n");
  await writeFile(join(root, "test", "runner.test.mjs"), "export const runner = true;\n");
  await writeFile(join(root, "runner.mjs"), "process.exitCode = 0;\n");
  const localManifest = manifest({ exclusions: [] });
  await writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(localManifest)}\n`);
  const planned = ["test/alpha.test.js", "test/runner.test.mjs"];
  const issued = {
    schema: RUN_AUTHORITY_SCHEMA,
    run_id: runId,
    nonce: "nonce",
    issued_at: "2026-07-23T00:00:00.000Z",
    expires_at: expiresAt,
    suite: "node",
    profile: "default",
    files: planned,
    cwd: ".",
    argv: ["node", "runner.mjs"],
    base_sha: localManifest.inventory_base_sha,
    head_sha: "head",
    source_tree_sha256: "full-tree",
    selection_tree_sha256: treeDigest(root, "head", planned),
    manifest_sha256: fileDigest(root, "test-accounting.manifest.json"),
  };
  const transcript = `${runId}.transcript`;
  await writeFile(
    join(directory, transcript),
    `${JSON.stringify({ event: "start", run_id: runId })}\n${JSON.stringify({ event: "end", run_id: runId, exit_code: 0, signal: null })}\n`
  );
  await writeFile(join(directory, `${runId}.authority.json`), `${JSON.stringify(issued)}\n`);
  const completion = {
    schema: RUN_COMPLETION_SCHEMA,
    run_id: runId,
    nonce: "nonce",
    observed: {
      exit_code: 0,
      signal: null,
      transcript,
      transcript_sha256: await digest(join(directory, transcript)),
      counts,
      files: planned,
    },
  };
  await writeFile(join(directory, `${runId}.completion.json`), `${JSON.stringify(completion)}\n`);
  const receipt: Receipt = {
    schema: RECEIPT_SCHEMA,
    run_id: runId,
    nonce: "nonce",
    suite: "node",
    profile: "default",
    issued_at: issued.issued_at,
    started_at: "2026-07-23T00:00:01.000Z",
    ended_at: "2026-07-23T00:00:02.000Z",
    expires_at: issued.expires_at,
    base_sha: issued.base_sha,
    head_sha: issued.head_sha,
    source_tree_sha256: issued.source_tree_sha256,
    selection_tree_sha256: issued.selection_tree_sha256,
    manifest_sha256: issued.manifest_sha256,
    cwd: ".",
    argv: issued.argv,
    files: planned,
    transcript,
    transcript_sha256: completion.observed.transcript_sha256,
    exit_code: 0,
    signal: null,
    counts,
    authority_sha256: await digest(join(directory, `${runId}.authority.json`)),
    completion_sha256: await digest(join(directory, `${runId}.completion.json`)),
    binding_sha256: "",
  };
  receipt.binding_sha256 = receiptBinding(receipt);
  return { root, directory, localManifest, planned, receipt };
}
function namedTrueSkipReasons(root: string): Record<string, number> {
  const paths = execFileSync("git", ["ls-files", "reference-implementation/test"], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((path) => EXECUTABLE_TEST_FILE_PATTERN.test(path));
  const reasons: Record<string, number> = {};
  for (const path of paths) {
    const source = readFileSync(join(root, path), "utf8");
    for (const match of source.matchAll(BSKIP_TRUE_PATTERN)) {
      const index = match.index ?? 0;
      const prefix = source.slice(Math.max(0, index - 1200), index);
      const title = prefix.slice(prefix.lastIndexOf("test(")).match(TEST_CALL_TITLE_PATTERN)?.[2];
      const reason = title?.match(SKIPPED_SKIPPED_PATTERN)?.slice(1).find(Boolean);
      if (reason) {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
    }
  }
  return reasons;
}

test("classifies suffix tests separately from helpers and fixtures under test directories", () => {
  assert.equal(classifyTrackedPath("test/helper.js").kind, "helper-or-fixture");
  assert.equal(classifyTrackedPath("test/fixture.json").kind, "helper-or-fixture");
  assert.equal(classifyTrackedPath("test/alpha.test.js").kind, "executable");
  assert.equal(classifyTrackedPath("src/component.test.tsx").kind, "executable");
  assert.equal(classifyTrackedPath("packages/mcp-server/test/smoke-stdio.mjs").kind, "executable");
});
test("normalizes runner-local receipt paths to Git-root-relative paths", () => {
  assert.deepEqual(repositoryPaths("reference-implementation", ["test/b.test.js", "server/a.test.js"]), [
    "reference-implementation/server/a.test.js",
    "reference-implementation/test/b.test.js",
  ]);
});
test("fails closed when a renamed TypeScript test is not planned or excluded", () => {
  const renamed = files.map((path) => (path === "test/alpha.test.js" ? "test/alpha.test.ts" : path));
  assert.throws(() => checkInventory(manifest(), renamed), UNACCOUNTED_EXECUTABLE_TESTS_ALPHA_TEST_PATTERN);
});
test("fails closed for unrecognized executable tests and empty suites", () => {
  assert.throws(
    () => checkInventory(manifest(), [...files, "outside/new.test.ts"]),
    UNACCOUNTED_EXECUTABLE_TESTS_PATTERN
  );
  assert.throws(
    () =>
      checkInventory(
        manifest({
          suites: [
            {
              id: "empty",
              cwd: ".",
              loader: "node-test",
              authority_argument: null,
              command: [],
              profiles: ["default"],
              include: ["missing/*.test.js"],
            },
          ],
          exclusions: [],
        }),
        files
      ),
    SELECTS_NO_EXECUTABLE_TESTS_PATTERN
  );
});
test("rejects invented receipt and transcript without a verifier-issued authority", async () => {
  const { directory, planned, receipt, root } = await fixture();
  await writeFile(join(directory, `${receipt.run_id}.authority.json`), `${JSON.stringify({ schema: "forged" })}\n`);
  assert.rejects(
    verifyReceipts(
      manifest({ exclusions: [] }),
      ["runner.mjs", "test/alpha.test.js", "test/runner.test.mjs", "test-accounting.manifest.json"],
      [receipt],
      { root, head: "head", authorityDirectory: directory, sourceTree: "full-tree" }
    ),
    INVALID_SCHEMAS_PROVENANCE_PATTERN
  );
  assert.deepEqual(planned, receipt.files);
});
test("accepts only an observed authority run once, then rejects replay and expiry", async () => {
  const value = await fixture();
  const allFiles = ["runner.mjs", "test/alpha.test.js", "test/runner.test.mjs", "test-accounting.manifest.json"];
  assert.deepEqual(
    (
      await verifyReceipts(value.localManifest, allFiles, [value.receipt], {
        root: value.root,
        head: "head",
        authorityDirectory: value.directory,
        sourceTree: "full-tree",
      })
    ).verified,
    ["node/default"]
  );
  await assert.rejects(
    verifyReceipts(value.localManifest, allFiles, [value.receipt], {
      root: value.root,
      head: "head",
      authorityDirectory: value.directory,
      sourceTree: "full-tree",
    }),
    REPLAYED_PATTERN
  );
  const expired = await fixture({
    expiresAt: "2026-07-23T00:00:03.000Z",
    runId: "22222222-2222-4222-8222-222222222222",
  });
  await assert.rejects(
    verifyReceipts(expired.localManifest, allFiles, [expired.receipt], {
      root: expired.root,
      head: "head",
      authorityDirectory: expired.directory,
      sourceTree: "full-tree",
      now: new Date("2026-07-23T00:00:04.000Z"),
    }),
    EXPIRED_PATTERN
  );
});
test("rejects selection, assertion, skip, profile, and full-tree mutations in an authority receipt", async () => {
  const value = await fixture();
  const allFiles = ["runner.mjs", "test/alpha.test.js", "test/runner.test.mjs", "test-accounting.manifest.json"];
  const altered = (changes: Partial<Receipt>): Receipt => {
    const next = { ...value.receipt, ...changes };
    return { ...next, binding_sha256: receiptBinding(next) };
  };
  await assert.rejects(
    verifyReceipts(value.localManifest, allFiles, [altered({ files: ["test/alpha.test.js"] })], {
      root: value.root,
      head: "head",
      authorityDirectory: value.directory,
      sourceTree: "full-tree",
      consume: false,
    }),
    ISSUED_AUTHORITY_FILES_DO_NOT_PATTERN
  );
  await assert.rejects(
    verifyReceipts(value.localManifest, allFiles, [altered({ counts: { ...value.receipt.counts, assertions: 1 } })], {
      root: value.root,
      head: "head",
      authorityDirectory: value.directory,
      sourceTree: "full-tree",
      consume: false,
    }),
    COMPLETION_DOES_NOT_BIND_PATTERN
  );
  await assert.rejects(
    verifyReceipts(
      value.localManifest,
      allFiles,
      [altered({ counts: { ...value.receipt.counts, skipped: 1, skip_reasons: { "node-tap-no-reason": 1 } } })],
      { root: value.root, head: "head", authorityDirectory: value.directory, sourceTree: "full-tree", consume: false }
    ),
    COMPLETION_DOES_NOT_BIND_GENERIC_PATTERN
  );
  await assert.rejects(
    verifyReceipts(value.localManifest, allFiles, [altered({ profile: "other" })], {
      root: value.root,
      head: "head",
      authorityDirectory: value.directory,
      sourceTree: "full-tree",
      consume: false,
    }),
    UNDECLARED_PATTERN
  );
  await assert.rejects(
    verifyReceipts(value.localManifest, allFiles, [altered({ source_tree_sha256: "different-tree" })], {
      root: value.root,
      head: "head",
      authorityDirectory: value.directory,
      sourceTree: "full-tree",
      consume: false,
    }),
    ISSUED_AUTHORITY_STALE_PATTERN
  );
  const generic = await fixture({
    counts: {
      assertions: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
      skip_reasons: { "node-tap-no-reason": 1 },
      planned_files: 2,
      completed_files: 2,
    },
    runId: "33333333-3333-4333-8333-333333333333",
  });
  const [genericSuite] = generic.localManifest.suites;
  const genericProfile = genericSuite?.profiles[0];
  if (genericProfile && typeof genericProfile !== "string") {
    genericProfile.skip_reasons = { "node-tap-no-reason": 1 };
  }
  await assert.rejects(
    verifyReceipts(generic.localManifest, allFiles, [generic.receipt], {
      root: generic.root,
      head: "head",
      authorityDirectory: generic.directory,
      sourceTree: "full-tree",
      consume: false,
    }),
    GENERIC_PATTERN
  );
});
test("accepts a complete named profile skip baseline and rejects an added skip", async () => {
  const counts: Receipt["counts"] = {
    assertions: 45,
    passed: 0,
    failed: 0,
    skipped: 45,
    skip_reasons: {
      "PDPP_TEST_POSTGRES_URL unset": 43,
      "dedicated disposable URL not selected": 1,
      "set PDPP_TEST_LIVE_NEKO_CAP=1 inside the Docker reference service": 1,
    },
    planned_files: 2,
    completed_files: 2,
  };
  const value = await fixture({ counts, runId: "44444444-4444-4444-8444-444444444444" });
  const allFiles = ["runner.mjs", "test/alpha.test.js", "test/runner.test.mjs", "test-accounting.manifest.json"];
  const [suite] = value.localManifest.suites;
  const profile = suite?.profiles[0];
  if (profile && typeof profile !== "string") {
    profile.skip_reasons = { ...counts.skip_reasons };
  }
  assert.deepEqual(
    (
      await verifyReceipts(value.localManifest, allFiles, [value.receipt], {
        root: value.root,
        head: "head",
        authorityDirectory: value.directory,
        sourceTree: "full-tree",
        consume: false,
      })
    ).verified,
    ["node/default"]
  );
  const added: Receipt = {
    ...value.receipt,
    counts: {
      ...counts,
      assertions: 46,
      skipped: 46,
      skip_reasons: { ...counts.skip_reasons, "unexpected backend": 1 },
    },
    binding_sha256: "",
  };
  added.binding_sha256 = receiptBinding(added);
  await assert.rejects(
    verifyReceipts(value.localManifest, allFiles, [added], {
      root: value.root,
      head: "head",
      authorityDirectory: value.directory,
      sourceTree: "full-tree",
      consume: false,
    }),
    COMPLETION_DOES_NOT_BIND_SKIPS_PATTERN
  );
});
test("keeps the RI memory profile baseline aligned with explicitly named source skips", () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue: Manifest = JSON.parse(readFileSync(join(root, "test-accounting.manifest.json"), "utf8"));
  const riSuite = manifestValue.suites.find((suite) => suite.id === "ri-default");
  const memoryProfile = riSuite?.profiles.find(
    (profile) => typeof profile !== "string" && profile.id === "memory-default"
  );
  const baseline = memoryProfile && typeof memoryProfile !== "string" ? (memoryProfile.skip_reasons ?? {}) : {};
  const reasons = namedTrueSkipReasons(root);
  // The baseline also folds in receipt.ts's exact POSTGRES_UNNAMED_SKIP_TEST_NAMES
  // allowlist — bare `skip: !POSTGRES_URL` tests with no name-embedded reason,
  // each individually traced to source (not statically re-countable here since
  // some are inside loops emitting more than one skip per source occurrence).
  assert.equal(
    // biome-ignore lint/suspicious/noUnnecessaryConditions: reasons is a Record<string, number> under noUncheckedIndexedAccess — this key genuinely may be absent (no matching source skip found), unlike biome's inference here.
    (reasons["PDPP_TEST_POSTGRES_URL unset"] ?? 0) + POSTGRES_UNNAMED_SKIP_TEST_NAMES.size,
    baseline["PDPP_TEST_POSTGRES_URL unset"]
  );
  assert.equal(reasons["dedicated disposable URL not selected"], baseline["dedicated disposable URL not selected"]);
});
test("does not leak a caller PostgreSQL URL into the RI memory profile", () => {
  assert.equal(
    storageProfileEnvironment("memory-default", { PDPP_TEST_POSTGRES_URL: "postgres://caller", KEEP: "yes" })
      .PDPP_TEST_POSTGRES_URL,
    undefined
  );
  assert.equal(
    storageProfileEnvironment("postgres", { PDPP_TEST_POSTGRES_URL: "postgres://selected" }).PDPP_TEST_POSTGRES_URL,
    "postgres://selected"
  );
});
test("parses accounting options exactly and does not accept authority-directory aliases", () => {
  assert.deepEqual(parseInventoryArgs(["--plan", "--suite", "node", "--profile", "default"]).suites, ["node"]);
  assert.throws(() => parseInventoryArgs(["--check", "--check"]), EXACTLY_ONE_MODE_PATTERN);
  assert.throws(() => parseInventoryArgs(["--plan", "--suite"]), REQUIRES_EXACTLY_ONE_VALUE_PATTERN);
  assert.throws(() => parseInventoryArgs(["--check", "--fail-on-unknown"]), UNKNOWN_ARGUMENT_PATTERN);
  assert.throws(() => parseInventoryArgs(["--check", "--fail-on-unknownly"]), UNKNOWN_ARGUMENT_PATTERN);
  assert.throws(() => parseInventoryArgs(["--verify", "--authority-directory", "receipts"]), UNKNOWN_ARGUMENT_PATTERN);
  assert.throws(() => parseInventoryArgs(["--plan", "--suite", "all", "--suite", "node"]), CANNOT_COMBINE_ALL_PATTERN);
});
test("uses only structured runner events and rejects generic skips", () => {
  const event = (value: unknown) => `PDPP_TEST_ACCOUNTING_EVENT ${JSON.stringify(value)}`;
  assert.deepEqual(
    structuredNodeSummary(
      `${event({ type: "test:pass", details: { type: "test" } })}\n${event({ type: "test:pass", details: { type: "test", skip: "backend disabled" } })}\n`
    ),
    { assertions: 2, passed: 1, failed: 0, skipped: 1, skip_reasons: { "backend disabled": 1 } }
  );
  assert.deepEqual(
    structuredNodeSummary(
      `${event({ type: "test:pass", details: { type: "test", name: "postgres path (skipped: PDPP_TEST_POSTGRES_URL unset)", skip: true } })}\n`
    ),
    { assertions: 1, passed: 0, failed: 0, skipped: 1, skip_reasons: { "PDPP_TEST_POSTGRES_URL unset": 1 } }
  );
  assert.throws(
    () => structuredNodeSummary(`${event({ type: "test:pass", details: { type: "test", skip: true } })}\n`),
    UNEXPLAINED_SKIP_PATTERN
  );
  assert.throws(() => structuredNodeSummary("# pass 99\n"), NO_STRUCTURED_NODE_EVENTS_PATTERN);
});
test("runs Python files directly and derives explicit unittest skips from verbose output", () => {
  const output =
    "test_unit (__main__.Unit.test_unit) ... ok\ntest_x11 (__main__.X11.test_x11) ... skipped 'requires Xvfb'\n\n----------------------------------------------------------------------\nRan 2 tests in 0.001s\n\nOK (skipped=1)\n";
  assert.deepEqual(structuredPythonSummary(output, 0), {
    assertions: 2,
    passed: 1,
    failed: 0,
    skipped: 1,
    skip_reasons: { "requires Xvfb": 1 },
  });
  assert.throws(
    () => structuredPythonSummary("s\nRan 1 test in 0.001s\n\nOK (skipped=1)\n", 0),
    OMITTED_A_SKIP_REASON_PATTERN
  );
});
test("the checked authority graph contains only direct leaves and no recursive authority command", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  for (const suite of manifestValue.suites) {
    if (suite.zero_tests) {
      continue;
    }
    if (suite.id !== "ri-default") {
      assert.notEqual(suite.execution, "authority-runner", "only the RI custom runner may receive authority");
      assert.equal(suite.authority_argument, null);
    }
    assert.ok(!(suite.command ?? []).some((part) => AUTHORITY_OR_ADAPTER_PATTERN.test(part)));
  }
  const packagePaths = [
    "packages/cli/package.json",
    "packages/local-collector/package.json",
    "packages/mcp-server/package.json",
    "packages/operator-ui/package.json",
    "packages/pdpp-brand-react/package.json",
    "packages/polyfill-connectors/package.json",
    "packages/read-core/package.json",
    "packages/reference-contract/package.json",
    "apps/console/package.json",
    "apps/site/package.json",
    "reference-implementation/package.json",
  ];
  for (const path of packagePaths) {
    // biome-ignore lint/performance/noAwaitInLoops: assertion loop over a fixed, small list of package.json files; sequential reads keep failures attributable to one path at a time.
    const pkg: { scripts?: Record<string, string> } = JSON.parse(await readFile(join(root, path), "utf8"));
    const scripts = pkg.scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (TEST_SCRIPT_NAME_PATTERN.test(name)) {
        assert.ok(
          !(command.includes("authority.ts") || command.includes("authority.mjs")),
          `${path}:${name} re-enters authority`
        );
      }
    }
  }
});
test("the current inventory has exact one-owner coverage and site is a real accounted suite", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const tracked = trackedFiles(root);
  const result = checkInventory(manifestValue, tracked, [], { failOnUnknown: true, failOnEmpty: true });
  const excluded = manifestValue.exclusions?.length ?? 0;
  const planned = Object.values(result.plans).reduce((sum, paths) => sum + paths.length, 0);
  assert.equal(result.executable.length, planned + excluded);
  const site = manifestValue.suites.find((suite) => suite.id === "site");
  assert.equal(site?.zero_tests, undefined);
  assert.ok((result.plans.site?.length ?? 0) > 0);
});
test("the optional PostgreSQL profile is not selected by the required default and rejects implicit execution", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const { runs } = selectedRuns(manifestValue, trackedFiles(root), { suites: ["ri-default"] });
  assert.deepEqual(
    runs.map((run) => (typeof run.profile === "string" ? run.profile : run.profile.id)),
    ["memory-default", "postgres"]
  );
  assert.rejects(
    runAuthority({ root, suites: ["ri-default"], profile: "postgres" }),
    OPTIONAL_ENVIRONMENT_PREDICATE_PATTERN
  );
});
test("the authority spawns an issued child and consumes its only valid Git-private receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-authority-"));
  await mkdir(join(root, "test"));
  await mkdir(join(root, "other"));
  await writeFile(join(root, "test", "a.test.js"), "export const selected = true;\n");
  await writeFile(join(root, "other", "b.test.js"), "export const peer = true;\n");
  await writeFile(
    join(root, "child.mjs"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is a fixture — a single-quoted string containing real JS source text (its own backtick template literal) written out to a file, not a forgotten template literal here.
    'import { readFileSync } from "node:fs"; const path = process.argv[process.argv.indexOf("--authority") + 1]; const issued = JSON.parse(readFileSync(path, "utf8")); console.log(`PDPP_TEST_ACCOUNTING_RESULT ${JSON.stringify({ run_id: issued.run_id, nonce: issued.nonce, suite: issued.suite, profile: issued.profile, files: issued.files, counts: { assertions: 1, passed: 1, failed: 0, skipped: 0, skip_reasons: {}, planned_files: 1, completed_files: 1 } })}`);\n'
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
  const initialManifest: Manifest = {
    schema: "pdpp.test-accounting/v3",
    inventory_base_sha: "0000000000000000000000000000000000000000",
    suites: [
      {
        id: "node",
        cwd: ".",
        loader: "node-test",
        authority_argument: "--authority",
        command: [process.execPath, "child.mjs"],
        profiles: [{ id: "default", required: true, skip_reasons: {} }],
        include: ["test/*.test.js"],
      },
      {
        id: "peer",
        cwd: ".",
        loader: "node-test",
        authority_argument: "--authority",
        command: [process.execPath, "child.mjs"],
        profiles: [{ id: "default", required: true, skip_reasons: {} }],
        include: ["other/*.test.js"],
      },
    ],
    exclusions: [],
  };
  await writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(initialManifest)}\n`);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  initialManifest.inventory_base_sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(initialManifest)}\n`);
  execFileSync("git", ["add", "test-accounting.manifest.json"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  assert.deepEqual((await runAuthority({ root, suites: ["node"] })).result.verified, ["node/default"]);
});
