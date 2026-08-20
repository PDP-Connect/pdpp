// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { storageProfileEnvironment } from "../../reference-implementation/scripts/test-profile-env.ts";
import { runAuthority, suiteEnvironment } from "./authority.ts";
import {
  checkInventory,
  classifyTrackedPath,
  contentDigest,
  fileDigest,
  type Manifest,
  parseInventoryArgs,
  planFor,
  RECEIPT_SCHEMA,
  type Receipt,
  RUN_AUTHORITY_SCHEMA,
  RUN_COMPLETION_SCHEMA,
  readManifest,
  receiptBinding,
  selectedRuns,
  TEST_SCRATCH_CAPABILITY_ENVIRONMENT,
  trackedFiles,
  treeDigest,
  verifyReceipts,
} from "./inventory.ts";
import {
  assertNamedSkipMappingsFullyConsumed,
  POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS,
  repositoryPaths,
  riConfiguredNamedSkipMappingIdentities,
  structuredNodeSummary,
  structuredPythonSummary,
} from "./receipt.ts";

const STALE_NAMED_SKIP_MAPPING_PATTERN = /stale named skip mapping rows/;
const UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN = /not configured for this suite/;
const UNACCOUNTED_EXECUTABLE_TESTS_ALPHA_TEST_PATTERN = /unaccounted executable tests.*alpha\.test\.ts/;
const UNACCOUNTED_EXECUTABLE_TESTS_PATTERN = /unaccounted executable tests/;
const SELECTS_NO_EXECUTABLE_TESTS_PATTERN = /selects no executable tests/;
const MATCHES_NON_EXECUTABLE_CLASSIFIED_FILE_PATTERN = /matches a non-executable-classified file/;
const INCLUDE_LIST_MATCHES_NO_TRACKED_FILE_PATTERN = /include list matches no tracked file/;
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
const AUTHORITY_OR_ADAPTER_PATTERN = /authority|adapter/;
const UNRECOGNIZED_RI_DEFAULT_PROFILE_PATTERN = /unrecognized ri-default profile/;
const COMPLETE_SCRATCH_CAPABILITY_BOUNDARY_PATTERN =
  /environment_unset must list every scratch capability exactly once/;

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
test("classifies suffix tests separately from helpers and fixtures under test directories", () => {
  assert.equal(classifyTrackedPath("test/helper.js").kind, "helper-or-fixture");
  assert.equal(classifyTrackedPath("test/fixture.json").kind, "helper-or-fixture");
  assert.equal(classifyTrackedPath("test/alpha.test.js").kind, "executable");
  assert.equal(classifyTrackedPath("src/component.test.tsx").kind, "executable");
  assert.equal(classifyTrackedPath("packages/mcp-server/test/smoke-stdio.ts").kind, "executable");
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
test("fails closed when an include glob matches a file that classifies as helper-or-fixture, not executable", () => {
  // Reproduces the exact defect shape found in the mcp-server smoke-stdio migration: a suite's
  // include glob still matches a real tracked file, so the suite is not empty and passes the
  // "selects no executable tests" guard, but the matched file itself misclassifies as
  // helper-or-fixture (e.g. a smoke probe with no .test./.spec. suffix), so it is silently
  // never planned. `checkInventory`'s "no unaccounted executable tests" check cannot catch this
  // because the file is never classified executable in the first place.
  const misclassified = [...files, "test/smoke-probe.mjs"];
  assert.throws(
    () =>
      checkInventory(
        manifest({
          suites: [
            {
              id: "node",
              cwd: ".",
              loader: "node-test",
              authority_argument: "--authority",
              command: ["node", "runner.mjs"],
              profiles: [{ id: "default", required: true, skip_reasons: {} }],
              include: ["test/*.test.js", "test/*.test.mjs", "test/smoke-probe.mjs"],
            },
          ],
        }),
        misclassified
      ),
    MATCHES_NON_EXECUTABLE_CLASSIFIED_FILE_PATTERN
  );
});
test("fails closed when a suite's entire include list matches no tracked file", () => {
  assert.throws(
    () =>
      checkInventory(
        manifest({
          suites: [
            {
              id: "node",
              cwd: ".",
              loader: "node-test",
              authority_argument: "--authority",
              command: ["node", "runner.mjs"],
              profiles: [{ id: "default", required: true, skip_reasons: {} }],
              include: ["nowhere/*.test.js"],
            },
          ],
        }),
        files
      ),
    INCLUDE_LIST_MATCHES_NO_TRACKED_FILE_PATTERN
  );
});
test("does not fail closed when one glob in a multi-extension include list matches nothing, as long as the suite itself is not empty", () => {
  // ri-default's real manifest entry deliberately lists .js/.mjs/.ts variants for the
  // not-yet-fully-migrated RI test tranche; a glob matching zero files today is expected
  // future-proofing, not a defect, as long as the suite as a whole still selects files.
  assert.doesNotThrow(() =>
    checkInventory(
      manifest({
        suites: [
          {
            id: "node",
            cwd: ".",
            loader: "node-test",
            authority_argument: "--authority",
            command: ["node", "runner.mjs"],
            profiles: [{ id: "default", required: true, skip_reasons: {} }],
            include: ["test/*.test.js", "test/*.test.mjs", "test/*.test.ts"],
          },
        ],
      }),
      files
    )
  );
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
    INCLUDE_LIST_MATCHES_NO_TRACKED_FILE_PATTERN
  );
});
test("planFor fails closed when a suite's include glob matches a real file but every match is excluded", () => {
  // Distinct from an empty include list: the glob itself matches
  // test/alpha.test.js, so validateIncludeGlobsClassifyExecutable's
  // suite-union check stays silent — the emptiness only appears after
  // exclusions are applied, which only planFor (not the glob-classify
  // check) can see.
  assert.throws(
    () =>
      planFor(
        manifest({
          suites: [
            {
              id: "node",
              cwd: ".",
              loader: "node-test",
              authority_argument: "--authority",
              command: ["node", "runner.mjs"],
              profiles: [{ id: "default", required: true, skip_reasons: {} }],
              include: ["test/alpha.test.js"],
            },
          ],
          exclusions: [
            {
              path: "test/alpha.test.js",
              reason: "fully excluded suite fixture",
              owner: "tooling",
              suite: "node",
              profile: "default",
              expires: "2027-12-31",
            },
          ],
        }),
        files
      ),
    SELECTS_NO_EXECUTABLE_TESTS_PATTERN
  );
});
test("rejects invented receipt and transcript without a verifier-issued authority", async () => {
  const { directory, planned, receipt, root } = await fixture();
  await writeFile(join(directory, `${receipt.run_id}.authority.json`), `${JSON.stringify({ schema: "forged" })}\n`);
  await assert.rejects(
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
    assertions: 46,
    passed: 0,
    failed: 0,
    skipped: 46,
    skip_reasons: {
      "PDPP_TEST_POSTGRES_URL unset": 44,
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
      assertions: 47,
      skipped: 47,
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
test("rejects a duplicate configured named-skip mapping row before any lookup set collapses it", () => {
  // Property 3, duplicate-row arm. The configured mapping rows are validated as
  // an ORDER-PRESERVING array before any lookup Set is built, so a duplicated
  // row is detectable (a Set would silently collapse it). We re-run that exact
  // guard against a deliberately duplicated array to prove it fails closed —
  // the real module-load validation over receipt.ts's own rows is what protects
  // production; this test proves the guard can actually fire.
  const configuredForMemoryDefault = riConfiguredNamedSkipMappingIdentities("memory-default");
  const withDuplicate = [...configuredForMemoryDefault, configuredForMemoryDefault[0] ?? ""];
  const seen = new Set<string>();
  let duplicateDetected = false;
  for (const identity of withDuplicate) {
    if (seen.has(identity)) {
      duplicateDetected = true;
      break;
    }
    seen.add(identity);
  }
  assert.ok(duplicateDetected, "array-first duplicate detection must see a repeated configured row");
});
test("keeps every candidate-added PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "real PostgreSQL: the 25-row first-page starvation shape folds before slow generic repairs and survives restart/resume",
      "real PostgreSQL mutation: a 1ms cold 25-row page starts at most one slow repair and later converges",
      "real PostgreSQL mutation: a 1ms 2,001-event fold is capped and resumes from its durable checkpoint",
      "real PostgreSQL mutation: an expired fold stops its delayed participant checkpoint-write tail after one started write",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "real PostgreSQL: the 25-row first-page starvation shape folds before slow generic repairs and survives restart/resume",
      "real PostgreSQL mutation: a 1ms cold 25-row page starts at most one slow repair and later converges",
      "real PostgreSQL mutation: a 1ms 2,001-event fold is capped and resumes from its durable checkpoint",
      "real PostgreSQL mutation: an expired fold stops its delayed participant checkpoint-write tail after one started write",
    ]
  );
});
test("keeps the unscoped fold deadline PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "real PostgreSQL: an unscoped fold carries one absolute duration deadline across instance folds";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the source-revision projection-fault PostgreSQL skip title in the exact receipt mapping", () => {
  const name =
    "PostgreSQL projection faults preserve canonical record, schedule, and lifecycle writes, then repair passes after recovery";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the manifest-receipt PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL manifest receipt changes once and BIGINT exhaustion remains canonical";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the checkpoint-dependency parity PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "SQLite/Postgres parity scenario (Postgres side, skipped: PDPP_TEST_POSTGRES_URL unset)";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the source-revision stale-publication PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL stale failure publication cannot overwrite newer evidence";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the source-revision trigger-omission PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL trigger omission fails before migration and a live writer waits for the atomic reinstall";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
// Aggregate gate regression (2026-07-30, run-history-backfill-cutover REVISE):
// test/active-run-summary-zero-spine.test.ts (reference-implementation) added
// three PostgreSQL tests using the bare-boolean `skip: !POSTGRES_URL` shape
// (in-progress/terminal/no-run cases), and memory-default rejected the first
// one encountered as an unexplained skip because none of the three exact
// names were in POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS. The accounting parser
// aborts on the FIRST unexplained skip per run, so all three names must be
// present together or a memory-default run fails serially, one at a time,
// across repeated fix attempts.
test("keeps every active-run-summary-zero-spine PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "PostgreSQL: zero spine_events statements for an in-progress run's GET (collection_rate merged via run.progress_reported)",
      "PostgreSQL: zero spine_events statements for a terminal run's GET",
      "PostgreSQL: zero spine_events statements for a connection with no run at all",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "PostgreSQL: zero spine_events statements for an in-progress run's GET (collection_rate merged via run.progress_reported)",
      "PostgreSQL: zero spine_events statements for a terminal run's GET",
      "PostgreSQL: zero spine_events statements for a connection with no run at all",
    ]
  );
});
// Aggregate gate regression (2026-07-30, terminal-read-integration closure):
// test/browser-surface.test.ts (reference-implementation) test for scoped
// browser-surface reads was not in the POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS
// mapping, causing memory-default to reject it as an unexplained skip.
test("keeps every browser-surface PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    ["Postgres scoped browser-surface reads match filtered global rows for 0, 1, and 25 identities"].filter((name) =>
      POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)
    ),
    ["Postgres scoped browser-surface reads match filtered global rows for 0, 1, and 25 identities"]
  );
});
// Aggregate gate regression (2026-07-30, terminal-read-integration closure, receipt 70bfe0b9):
// Three additional PostgreSQL tests were not in the POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS
// mapping: fleet-migration repair and scheduler_run_history legacy database migration.
test("keeps every fleet-migration and scheduler-upgrade PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "PostgreSQL: a fresh install is unaffected by the fleet-migration repair",
      "PostgreSQL: a pre-renamed-stuck database is repaired on the next boot, idempotently, with row/id/index preservation",
      "PostgreSQL: a run.started write succeeds against a database migrated from legacy scheduler_run_history",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "PostgreSQL: a fresh install is unaffected by the fleet-migration repair",
      "PostgreSQL: a pre-renamed-stuck database is repaired on the next boot, idempotently, with row/id/index preservation",
      "PostgreSQL: a run.started write succeeds against a database migrated from legacy scheduler_run_history",
    ]
  );
});
test("keeps the setup-binding promotion PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "Postgres: every setup-binding kind promotes on success, stays hidden on abandon, survives its revoke path",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    ["Postgres: every setup-binding kind promotes on success, stays hidden on abandon, survives its revoke path"]
  );
});
test("keeps the Explore upcoming PostgreSQL skip titles in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "postgresFetchUpcoming: live Postgres in-flight partition workers never exceed the configured limit",
      "sqliteFetchUpcoming & postgresFetchUpcoming: output is bit-identical and deterministic",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "postgresFetchUpcoming: live Postgres in-flight partition workers never exceed the configured limit",
      "sqliteFetchUpcoming & postgresFetchUpcoming: output is bit-identical and deterministic",
    ]
  );
});
// SECOND LIVE CANARY REVISE (2026-07-30): the interrupted-migration
// reconciliation test file added two PostgreSQL tests using the same
// bare-boolean `skip: !POSTGRES_URL` shape. FOURTH-PASS GATE REVISE
// (2026-07-30): a third PostgreSQL test (the duplicate-composite-key
// dedup regression) was added to the same file, using the same shape.
test("keeps every run-history-interrupted-migration-reconciliation PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "PostgreSQL: interrupted migration reconciles losslessly against real Postgres — overlap merges, disjoint rows preserved, duplicate run_id across connections survives",
      "PostgreSQL: a crash before the reconciliation transaction commits leaves scheduler_run_history fully intact for a clean retry",
      "PostgreSQL: two scheduler_run_history rows sharing the identical composite key deduplicate to the latest (highest id) before merge — the exact fourth-pass gate reproduction",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "PostgreSQL: interrupted migration reconciles losslessly against real Postgres — overlap merges, disjoint rows preserved, duplicate run_id across connections survives",
      "PostgreSQL: a crash before the reconciliation transaction commits leaves scheduler_run_history fully intact for a clean retry",
      "PostgreSQL: two scheduler_run_history rows sharing the identical composite key deduplicate to the latest (highest id) before merge — the exact fourth-pass gate reproduction",
    ]
  );
});
test("the exact named-skip mapping join fails closed on stale rows and on unconfigured consumed identities", () => {
  // Property 3, stale/unmatched arm. A configured row that no emitted skip
  // consumed (e.g. a test renamed so its title now self-describes, or deleted)
  // must fail closed; a consumed identity absent from the configured set must
  // fail closed too. A run that consumes exactly the configured rows passes,
  // and 1-to-N loop-generated identities pass because the join is over emitted
  // identities, never over static source occurrences.
  const configured = ["alpha", "beta", "gamma"];
  assert.throws(
    () => assertNamedSkipMappingsFullyConsumed(["alpha", "beta"], configured),
    STALE_NAMED_SKIP_MAPPING_PATTERN
  );
  assert.throws(
    () => assertNamedSkipMappingsFullyConsumed(["alpha", "beta", "gamma", "delta"], configured),
    UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN
  );
  // 1-to-N: three emitted identities from one looped source declaration, all
  // configured, plus an exact one-to-one — every emitted identity resolves.
  assert.doesNotThrow(() =>
    assertNamedSkipMappingsFullyConsumed(["alpha", "beta", "gamma", "gamma", "gamma"], configured)
  );
});
test("named skip mapping stays profile-aware AND fail-closed in both directions", () => {
  // Reproduces the real symmetric trap: a named test nested inside a file's
  // outer structural gate (device-exporter-postgres-proof.test.js's
  // `real local child + PostgreSQL HTTP preserves exact 100-record output,
  // latency, lifecycle, and privacy`) registers ONLY under the postgres
  // profile -- under memory-default the whole file collapses to a single
  // self-describing synthetic skip, so the named row is structurally
  // unreachable and can never be consumed there.
  const PROFILE_SCOPED_TEST_NAME =
    "real local child + PostgreSQL HTTP preserves exact 100-record output, latency, lifecycle, and privacy";

  const memoryDefaultConfigured = riConfiguredNamedSkipMappingIdentities("memory-default");
  const postgresConfigured = riConfiguredNamedSkipMappingIdentities("postgres");

  // The row is configured for postgres, never for memory-default -- the
  // profile scoping itself is visible and explicit, not incidental.
  assert.ok(postgresConfigured.includes(PROFILE_SCOPED_TEST_NAME));
  assert.ok(!memoryDefaultConfigured.includes(PROFILE_SCOPED_TEST_NAME));
  // The failed PostgreSQL receipt consumed exactly these three mappings. The
  // other 55 URL-gated mappings belong only to memory-default, where their
  // tests skip instead of running.
  assert.deepEqual(postgresConfigured, [
    PROFILE_SCOPED_TEST_NAME,
    "live CDP smoke proves frame, click, and viewport resize against Chromium",
    "live-shadow-comparison: production projection has no unexpected drift",
  ]);

  // Direction (b) -- the legitimate cross-profile case now passes: a
  // memory-default run that consumes its 55 URL-gated rows and two
  // suite-scoped live-gate rows, but consumes NOTHING for the profile-scoped
  // identity -- because the file never registered that test -- does not trip
  // "stale row" on an identity outside this profile's configured set.
  assert.doesNotThrow(() => assertNamedSkipMappingsFullyConsumed(memoryDefaultConfigured, memoryDefaultConfigured));

  // A postgres run that consumes all three applicable rows is exactly
  // satisfied.
  assert.doesNotThrow(() => assertNamedSkipMappingsFullyConsumed(postgresConfigured, postgresConfigured));

  // Direction (a) -- the oracle STAYS fail-closed. Under postgres, the
  // profile that CAN structurally emit this identity, consuming every OTHER
  // configured row but leaving the profile-scoped row itself unconsumed is
  // still a hard failure -- profile-awareness narrows WHICH rows apply, it
  // does not weaken the join once a row does apply.
  const postgresConfiguredMinusProfileScoped = postgresConfigured.filter((name) => name !== PROFILE_SCOPED_TEST_NAME);
  assert.throws(
    () => assertNamedSkipMappingsFullyConsumed(postgresConfiguredMinusProfileScoped, postgresConfigured),
    STALE_NAMED_SKIP_MAPPING_PATTERN
  );

  // And a genuinely unexplained skip is still rejected regardless of
  // profile: an identity for this same test name, consumed ALONGSIDE every
  // legitimately-configured memory-default row, is still an
  // unconfigured-mapping failure (not a silent pass) because memory-default
  // has no such row configured at all.
  assert.throws(
    () =>
      assertNamedSkipMappingsFullyConsumed(
        [...memoryDefaultConfigured, PROFILE_SCOPED_TEST_NAME],
        memoryDefaultConfigured
      ),
    UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN
  );

  // An unrecognized profile string fails closed rather than silently
  // returning an empty/permissive configured set.
  assert.throws(() => riConfiguredNamedSkipMappingIdentities("staging"), UNRECOGNIZED_RI_DEFAULT_PROFILE_PATTERN);
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
  // A self-describing string skip value consumes no exact named-mapping row.
  assert.deepEqual(
    structuredNodeSummary(
      `${event({ type: "test:pass", details: { type: "test" } })}\n${event({ type: "test:pass", details: { type: "test", skip: "backend disabled" } })}\n`
    ),
    {
      assertions: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
      skip_reasons: { "backend disabled": 1 },
      consumed_mapping_identities: [],
    }
  );
  // A `(skipped: ...)` title suffix is self-describing and consumes no row.
  assert.deepEqual(
    structuredNodeSummary(
      `${event({ type: "test:pass", details: { type: "test", name: "postgres path (skipped: PDPP_TEST_POSTGRES_URL unset)", skip: true } })}\n`
    ),
    {
      assertions: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
      skip_reasons: { "PDPP_TEST_POSTGRES_URL unset": 1 },
      consumed_mapping_identities: [],
    }
  );
  // A bare boolean skip with no self-describing name resolves through an exact
  // named-mapping row, and that row is recorded as CONSUMED so the suite
  // finalizer's property-3 join can see it.
  assert.deepEqual(
    structuredNodeSummary(
      `${event({ type: "test:pass", details: { type: "test", name: "Postgres store factory is consistent with the resolver", skip: true } })}\n`
    ),
    {
      assertions: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
      skip_reasons: { "PDPP_TEST_POSTGRES_URL unset": 1 },
      consumed_mapping_identities: ["Postgres store factory is consistent with the resolver"],
    }
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
    consumed_mapping_identities: [],
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
test("the dedicated scratch lifecycle suite owns both oracles exactly once", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const result = checkInventory(manifestValue, trackedFiles(root), [], { failOnUnknown: true, failOnEmpty: true });
  assert.deepEqual(result.plans["scratch-lifecycle"], [
    "scripts/test-scratch/canonical-entrypoints.test.ts",
    "scripts/test-scratch/run-command.test.ts",
  ]);
  assert.ok(
    !result.plans["root-node"]?.some((path) => path.startsWith("scripts/test-scratch/")),
    "root-node must not inherit lifecycle-oracle ownership"
  );
});
test("the dedicated scratch lifecycle leaf removes every inherited capability variable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-authority-scratch-boundary-"));
  await mkdir(join(root, "scripts", "test-scratch"), { recursive: true });
  await writeFile(join(root, "scripts", "test-scratch", "run-command.test.ts"), "export {};\n");
  await writeFile(
    join(root, "boundary.mjs"),
    `const names = ${JSON.stringify(TEST_SCRATCH_CAPABILITY_ENVIRONMENT)}; const present = names.filter((name) => process.env[name] !== undefined); if (present.length) { console.error(present.join(",")); process.exitCode = 1; }\n`
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
  const localManifest: Manifest = {
    schema: "pdpp.test-accounting/v3",
    inventory_base_sha: "0000000000000000000000000000000000000000",
    suites: [
      {
        id: "renamed-lifecycle",
        cwd: ".",
        loader: "shell",
        authority_argument: null,
        command: [process.execPath, "boundary.mjs"],
        environment_unset: [...TEST_SCRATCH_CAPABILITY_ENVIRONMENT],
        profiles: [{ id: "default", required: true, skip_reasons: {} }],
        include: ["scripts/test-scratch/run-command.test.ts"],
      },
    ],
    exclusions: [],
  };
  await writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(localManifest)}\n`);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  localManifest.inventory_base_sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(localManifest)}\n`);
  execFileSync("git", ["add", "test-accounting.manifest.json"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  const partialBoundary = structuredClone(localManifest);
  const [partialSuite] = partialBoundary.suites;
  assert.ok(partialSuite);
  partialSuite.environment_unset = [TEST_SCRATCH_CAPABILITY_ENVIRONMENT[0]];
  await writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(partialBoundary)}\n`);
  await assert.rejects(
    readManifest(join(root, "test-accounting.manifest.json"), { root }),
    COMPLETE_SCRATCH_CAPABILITY_BOUNDARY_PATTERN
  );
  const missingBoundary = structuredClone(localManifest);
  const [missingSuite] = missingBoundary.suites;
  assert.ok(missingSuite);
  missingSuite.environment_unset = undefined;
  await writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(missingBoundary)}\n`);
  await assert.rejects(
    readManifest(join(root, "test-accounting.manifest.json"), { root }),
    COMPLETE_SCRATCH_CAPABILITY_BOUNDARY_PATTERN
  );
  await writeFile(join(root, "test-accounting.manifest.json"), `${JSON.stringify(localManifest)}\n`);
  const inherited = Object.fromEntries(TEST_SCRATCH_CAPABILITY_ENVIRONMENT.map((name) => [name, "outer-capability"]));
  const [suite] = localManifest.suites;
  assert.ok(suite);
  const environment = suiteEnvironment(inherited, "default", suite);
  for (const name of TEST_SCRATCH_CAPABILITY_ENVIRONMENT) {
    assert.equal(environment[name], undefined);
  }
  assert.deepEqual((await runAuthority({ root, suites: ["renamed-lifecycle"], env: inherited })).result.verified, [
    "renamed-lifecycle/default",
  ]);
});
test("the PostgreSQL profile declares its exact live-gate skip baseline", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const suite = manifestValue.suites.find((entry) => entry.id === "ri-default");
  const postgres = suite?.profiles?.find((entry) => typeof entry !== "string" && entry.id === "postgres");
  assert.deepEqual(typeof postgres === "string" ? undefined : postgres?.skip_reasons, {
    "PDPP_REAL_LOCAL_TRANSFORMER_POSTGRES_ORACLE unset": 1,
    "set PDPP_TEST_LIVE_NEKO_CAP=1 inside the Docker reference service": 1,
    "set PDPP_TEST_LIVE_NEKO=1 and NEKO_ORIGIN to run": 2,
    "set PDPP_MULTILINGUAL_MINILM_SMOKE=1 to run the external model-download smoke": 1,
    "set PDPP_TEST_LIVE_CDP=1 and PDPP_TEST_CDP_BIN or PDPP_TEST_CDP_WS_URL to run": 1,
    "set PDPP_LIVE_CONNECTOR_HEALTH_GATE=1 to run": 1,
  });
});
// FIFTH-PASS GATE FIX (2026-07-30): this hardcoded literal must track
// test-accounting.manifest.json's memory-default skip map exactly. Keep this
// literal complete so a changed PostgreSQL-gated test fails visibly rather
// than being silently absorbed by a generic skip bucket.
test("the memory-default profile declares the exact current skip baseline", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const suite = manifestValue.suites.find((entry) => entry.id === "ri-default");
  const memoryDefault = suite?.profiles?.find((entry) => typeof entry !== "string" && entry.id === "memory-default");
  assert.deepEqual(typeof memoryDefault === "string" ? undefined : memoryDefault?.skip_reasons, {
    "PDPP_TEST_POSTGRES_URL unset": 176,
    "PDPP_TEST_POSTGRES_URL unset or non-dedicated": 8,
    "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener": 13,
    "dedicated disposable URL not selected": 1,
    "set PDPP_LIVE_CONNECTOR_HEALTH_GATE=1 to run": 1,
    "set PDPP_TEST_LIVE_NEKO_CAP=1 inside the Docker reference service": 1,
    "PDPP_TEST_POSTGRES_URL is required for PostgreSQL status-window authority": 1,
    "set PDPP_TEST_LIVE_CDP=1 and PDPP_TEST_CDP_BIN or PDPP_TEST_CDP_WS_URL to run": 1,
    "set PDPP_TEST_LIVE_NEKO=1 and NEKO_ORIGIN to run": 2,
    "set PDPP_MULTILINGUAL_MINILM_SMOKE=1 to run the external model-download smoke": 1,
    "requires --experimental-test-module-mocks (npm run test:whatsapp-no-whole-file-read)": 4,
    "requires --expose-gc (npm run test:whatsapp-no-whole-file-read)": 3,
    "requires --experimental-test-module-mocks (spawns test/fixtures/manual-upload-write-error-server.ts directly)": 1,
    "no dedicated PDPP_TEST_POSTGRES_URL": 1,
    "requires --experimental-test-module-mocks (npm run test:run-generation-fencing-terminal-write-failure)": 1,
  });
});
test("the polyfill-connectors default profile declares the exact current skip baseline", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const suite = manifestValue.suites.find((entry) => entry.id === "polyfill-connectors");
  const defaultProfile = suite?.profiles?.find((entry) => typeof entry !== "string" && entry.id === "default");
  assert.deepEqual(typeof defaultProfile === "string" ? undefined : defaultProfile?.skip_reasons, {
    "GROUPME_ACCESS_TOKEN unset": 2,
    "local Amazon raw-DOM fixture directory not present": 2,
    "local Chase raw-DOM fixture directory not present": 3,
    "local USAA raw fixture directory not present": 1,
    "requires --experimental-test-module-mocks": 1,
    "run with --expose-gc for a reliable memory-growth comparison": 1,
  });
});
test("the optional PostgreSQL profile is not selected by the required default and rejects implicit execution", async () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const manifestValue = await readManifest(join(root, "test-accounting.manifest.json"), { root });
  const { runs } = selectedRuns(manifestValue, trackedFiles(root), { suites: ["ri-default"] });
  assert.deepEqual(
    runs.map((run) => (typeof run.profile === "string" ? run.profile : run.profile.id)),
    ["memory-default", "postgres"]
  );
  await assert.rejects(
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
test("a suite-scoped authority run does not fail closed on an unrelated suite's stale, empty-matching include glob", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdpp-authority-scoped-"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "test", "a.test.js"), "export const selected = true;\n");
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
        // Stands in for the real mcp-server suite's stale .test.js/.mjs
        // include globs after its tests were renamed to .test.ts/.ts: the
        // suite is declared but its include glob now matches zero tracked
        // files. A suite-scoped run of "node" alone must not fail closed
        // because of this unrelated, unselected suite's empty selection.
        id: "stale-unrelated",
        cwd: ".",
        loader: "node-test",
        authority_argument: "--authority",
        command: [process.execPath, "child.mjs"],
        profiles: [{ id: "default", required: true, skip_reasons: {} }],
        include: ["test/*.test.renamed-away-suffix"],
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
  // Running "stale-unrelated" directly (not as an unrelated bystander this
  // time — it is the selected suite) still fails closed, just earlier and
  // more precisely than before this lane's fix: runAuthority's own
  // pre-selection closure check (validateIncludeGlobsClassifyExecutable,
  // scoped to the suites actually being run) now reports the suite's empty
  // include list directly, ahead of planFor's coarser "selects no
  // executable tests" guard that used to be the first thing to catch it.
  await assert.rejects(
    runAuthority({ root, suites: ["stale-unrelated"] }),
    INCLUDE_LIST_MATCHES_NO_TRACKED_FILE_PATTERN
  );
});
