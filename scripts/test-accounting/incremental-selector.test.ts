// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertAdvertisedFilesHonored,
  boundedReverseClosure,
  buildIncrementalGraph,
  classifyChangedPath,
  INCREMENTAL_GRAPH_SCHEMA,
  INCREMENTAL_SELECTOR_SCHEMA,
  type IncrementalGraph,
  MAX_REVERSE_TEST_FILES,
  makeShadowReceipt,
  parseNulDiff,
  readShadowReceiptOrUnknown,
  renderShadowReport,
  SELECTOR_VERSION,
  SHADOW_RECEIPT_SCHEMA,
  type ShadowReceipt,
  type ShadowSelection,
  verifyIncrementalGraph,
  verifyShadowReceipt,
} from "./incremental-selector.ts";
import { contentDigest, gitHead, stable } from "./inventory.ts";

const TERMINAL_NUL_ERROR = /terminal NUL/;
const PATH_ERROR = /path/;
const STALE_ERROR = /stale/;
const STALE_OR_INCOMPLETE_ERROR = /stale|incomplete/;
const NON_AUTHORITATIVE_ERROR = /non-authoritative/;
const STALE_HEAD_ERROR = /head is stale/;
const LIST_ERROR = /lists differ/;
const SORT_ERROR = /canonically sorted/;
const DUPLICATE_ERROR = /duplicates/;
const BASE_HEAD_ERROR = /base-head-mismatch/;
const UNKNOWN_STATUS = /status: unknown/;

function graph(
  edges: IncrementalGraph["edges"],
  limits: IncrementalGraph["limits"] = {
    max_nodes: 100,
    max_edges: 100,
    max_depth: 10,
    max_millis: 1000,
  },
  head = "a".repeat(40)
): IncrementalGraph {
  const value: Omit<IncrementalGraph, "digest"> = {
    schema: INCREMENTAL_GRAPH_SCHEMA,
    selector_version: SELECTOR_VERSION,
    head_sha: head,
    source_tree_sha256: "b".repeat(64),
    nodes: [],
    edges,
    issues: [],
    limits,
    complete: true,
  };
  return { ...value, digest: contentDigest(stable(value)) };
}

function selection(head = gitHead()): ShadowSelection {
  return {
    selector_schema: INCREMENTAL_SELECTOR_SCHEMA,
    selector_version: SELECTOR_VERSION,
    base_sha: "1".repeat(40),
    head_sha: head,
    observed_head_sha: head,
    raw_diff_sha256: "2".repeat(64),
    changed_paths: ["packages/example/src/change.ts"],
    diff: [{ status: "M", path: "packages/example/src/change.ts" }],
    protected_paths: [],
    mode: "incremental",
    fallback_reason: null,
    fallback_detail: null,
    advertised_files: ["packages/example/test/change.test.ts"],
    selected_runs: [{ suite: "example", profile: "default", files: ["packages/example/test/change.test.ts"] }],
    graph: null,
    overhead_ms: 1,
  };
}

test("parses exact NUL records, including newlines, shell characters, and Unicode", () => {
  const raw = Buffer.from("M\0packages/example/test/line\nname.test.ts\0A\0-leading-[x].ts\0", "utf8");
  assert.deepEqual(parseNulDiff(raw), [
    { status: "M", path: "packages/example/test/line\nname.test.ts" },
    { status: "A", path: "-leading-[x].ts" },
  ]);
  assert.throws(() => parseNulDiff(Buffer.from("M\0missing-terminal-delimiter", "utf8")), TERMINAL_NUL_ERROR);
  assert.throws(() => parseNulDiff(Buffer.from("M\0one\0A\0", "utf8")), PATH_ERROR);
});

test("records both sides of a rename/copy and classifies it before graph traversal", () => {
  const diff = parseNulDiff(Buffer.from("R100\0old.ts\0new.ts\0", "utf8"));
  assert.deepEqual(diff, [{ status: "R100", old_path: "old.ts", path: "new.ts" }]);
  assert.equal(classifyChangedPath("scripts/test-accounting/authority.ts")?.reason, "protected-selector-or-authority");
  assert.equal(classifyChangedPath(".github/workflows/gate.yml")?.reason, "protected-ci");
  assert.equal(classifyChangedPath("packages/reference-contract/src/schema.ts")?.reason, "protected-contract");
  assert.equal(classifyChangedPath("packages/example/src/schema.sql")?.reason, "protected-schema-or-sql");
  assert.equal(classifyChangedPath("package.json")?.reason, "protected-build-input");
  assert.equal(classifyChangedPath("packages/list-envelope/src/index.ts")?.reason, "protected-contract");
  assert.equal(classifyChangedPath("packages/cli/src/ref/list-envelope.ts")?.reason, "protected-contract");
  assert.equal(classifyChangedPath("apps/site/postcss.config.mjs")?.reason, "protected-build-input");
  assert.equal(classifyChangedPath("apps/console/tailwind.config.ts")?.reason, "protected-build-input");
  assert.equal(classifyChangedPath("unknown-root/file.ts")?.reason, "unmapped-path");
  assert.equal(classifyChangedPath("docs/ordinary-note.md")?.reason, "unmapped-path");
});

test("protected and unsupported inputs have deterministic typed fallback reasons before graph work", () => {
  assert.equal(classifyChangedPath("scripts/test-accounting/inventory.ts")?.reason, "protected-selector-or-authority");
  assert.equal(classifyChangedPath(".github/workflows/gate.yml")?.reason, "protected-ci");
  assert.equal(classifyChangedPath("unknown-root/file.ts")?.reason, "unmapped-path");
  assert.equal(parseNulDiff(Buffer.from("U\0packages/example/src/change.ts\0", "utf8"))[0]?.status, "U");
});

test("bounded reverse closure terminates on cycles and fails closed on depth/node bounds", () => {
  const cycle = graph([
    { from: "test/a.test.ts", target: "src/a.ts", kind: "literal", declaration: null },
    { from: "src/a.ts", target: "src/b.ts", kind: "literal", declaration: null },
    { from: "src/b.ts", target: "src/a.ts", kind: "literal", declaration: null },
  ]);
  assert.deepEqual(boundedReverseClosure(cycle, ["src/a.ts"]).files, ["src/a.ts", "src/b.ts", "test/a.test.ts"]);
  const limited = boundedReverseClosure(cycle, ["src/a.ts"], { ...cycle.limits, max_nodes: 2 });
  assert.equal(limited.complete, false);
  assert.equal(limited.reason, "closure-budget");
  assert.ok(limited.files.length <= 2);
  assert.equal(MAX_REVERSE_TEST_FILES, 20);
});

test("complete graph scans sibling importers and fails closed on a missing JSONC alias target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-shadow-graph-"));
  try {
    await mkdir(join(directory, "src"));
    await mkdir(join(directory, "test"));
    await writeFile(join(directory, "package.json"), "{}\n");
    await writeFile(
      join(directory, "tsconfig.json"),
      '{\n  // JSONC is accepted by TypeScript configurations.\n  "compilerOptions": { "paths": { "@alias/*": ["missing/*"] } },\n}\n'
    );
    await writeFile(join(directory, "src/entry.ts"), 'import "@alias/missing";\n');
    await writeFile(join(directory, "src/changed.ts"), "export const changed = true;\n");
    await writeFile(
      join(directory, "test/external.test.ts"),
      'import "../src/changed.ts";\nspawn("node", ["../src/changed.ts"]);\n'
    );
    execFileSync("git", ["init", "-q"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "fixture"], { cwd: directory });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });
    const graphResult = buildIncrementalGraph(directory, gitHead(directory), {
      max_nodes: 100,
      max_edges: 100,
      max_depth: 10,
      max_millis: 1000,
    });
    assert.equal(graphResult.complete, false);
    assert.equal(
      graphResult.issues.some((issue) => issue.kind === "unresolved-literal"),
      true
    );
    assert.equal(
      graphResult.edges.some((edge) => edge.from === "test/external.test.ts"),
      true
    );
    assert.equal(
      graphResult.edges.some(
        (edge) => edge.from === "test/external.test.ts" && edge.kind === "spawn" && edge.target === "src/changed.ts"
      ),
      true
    );
    assert.deepEqual(boundedReverseClosure(graphResult, ["src/changed.ts"]).files, [
      "src/changed.ts",
      "test/external.test.ts",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("graph mutants cannot rewrite an edge or completeness bit behind the old digest", () => {
  const original = graph([{ from: "test/a.test.ts", target: "src/a.ts", kind: "literal", declaration: null }]);
  assert.doesNotThrow(() => verifyIncrementalGraph(original));
  assert.throws(() => verifyIncrementalGraph({ ...original, edges: [] }), STALE_ERROR);
  assert.throws(() => verifyIncrementalGraph({ ...original, complete: false }), STALE_OR_INCOMPLETE_ERROR);
});

test("advertise-vs-honor is an exact canonical file-list check", () => {
  assert.doesNotThrow(() => assertAdvertisedFilesHonored(["a", "b"], ["a", "b"]));
  assert.throws(() => assertAdvertisedFilesHonored(["b", "a"], ["a", "b"]), SORT_ERROR);
  assert.throws(() => assertAdvertisedFilesHonored(["b", "a", "a"], ["a", "b"]), DUPLICATE_ERROR);
  assert.throws(() => assertAdvertisedFilesHonored(["a"], ["b"]), LIST_ERROR);
});

test("shadow receipt binds exact head and remains permanently non-authoritative", () => {
  const root = process.cwd();
  const reportIdentity = "full-gate-report:sha256:deadbeef";
  const receipt = makeShadowReceipt(selection(), reportIdentity);
  assert.equal(receipt.schema, SHADOW_RECEIPT_SCHEMA);
  assert.equal(receipt.shadow_only, true);
  assert.equal(receipt.ci_green, false);
  verifyShadowReceipt(receipt, { root, expectedHead: gitHead(root), authorityReportIdentity: reportIdentity });
  assert.match(renderShadowReport(receipt), new RegExp(`head_sha: ${gitHead(root)}`));
  assert.match(renderShadowReport(receipt), new RegExp(`authority_report_identity: ${reportIdentity}`));
  assert.throws(
    () =>
      verifyShadowReceipt({ ...receipt, ci_green: true } as unknown as ShadowReceipt, {
        root,
        expectedHead: gitHead(root),
        authorityReportIdentity: reportIdentity,
      }),
    NON_AUTHORITATIVE_ERROR
  );
  assert.throws(
    () =>
      verifyShadowReceipt(
        { ...receipt, head_sha: "3".repeat(40) },
        { root, expectedHead: gitHead(root), authorityReportIdentity: reportIdentity }
      ),
    STALE_HEAD_ERROR
  );
  assert.throws(
    () =>
      verifyShadowReceipt(
        { ...receipt, honored_files: ["other.ts"] },
        { root, expectedHead: gitHead(root), authorityReportIdentity: reportIdentity }
      ),
    LIST_ERROR
  );
  const graphReceipt = makeShadowReceipt({ ...selection(), graph: graph([], undefined, gitHead()) }, reportIdentity);
  const receiptGraph = graphReceipt.graph;
  assert.ok(receiptGraph);
  assert.throws(
    () =>
      verifyShadowReceipt(
        {
          ...graphReceipt,
          graph: {
            ...receiptGraph,
            edges: [{ from: "test/a.test.ts", target: "src/a.ts", kind: "literal", declaration: null }],
          },
        },
        { root, expectedHead: gitHead(root), authorityReportIdentity: reportIdentity }
      ),
    STALE_ERROR
  );
  assert.throws(
    () =>
      verifyShadowReceipt(
        { ...receipt, selected_runs: [{ suite: "example", profile: "default", files: ["other.ts"] }] },
        { root, expectedHead: gitHead(root), authorityReportIdentity: reportIdentity }
      ),
    LIST_ERROR
  );
});

test("missing or malformed receipt is unknown, never a green shadow result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-shadow-receipt-"));
  try {
    const missing = await readShadowReceiptOrUnknown(join(directory, "missing.json"));
    assert.equal(missing.terminal_status, "unknown");
    assert.equal(missing.ci_green, false);
    const malformedPath = join(directory, "malformed.json");
    await writeFile(malformedPath, JSON.stringify({ schema: SHADOW_RECEIPT_SCHEMA, ci_green: true }));
    const malformed = await readShadowReceiptOrUnknown(malformedPath);
    assert.equal(malformed.terminal_status, "unknown");
    assert.equal(renderShadowReport(missing).includes("ci_green: false"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI crash-before-receipt writes only unknown report evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-shadow-crash-"));
  const receiptPath = join(directory, "receipt.json");
  const reportPath = join(directory, "report.md");
  const authorityReportPath = join(directory, "full-gate-report.md");
  try {
    await writeFile(authorityReportPath, "full gate report\n");
    await writeFile(receiptPath, JSON.stringify(makeShadowReceipt(selection(), "old-report")));
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/test-accounting/incremental-shadow.ts",
            "--base",
            "0".repeat(40),
            "--head",
            gitHead(),
            "--receipt",
            receiptPath,
            "--report",
            reportPath,
            "--authority-report",
            authorityReportPath,
          ],
          { encoding: "utf8" }
        ),
      BASE_HEAD_ERROR
    );
    assert.equal(await readShadowReceiptOrUnknown(receiptPath).then((value) => value.terminal_status), "unknown");
    assert.match(await readFile(reportPath, "utf8"), UNKNOWN_STATUS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical report corpus keeps leaf candidates separate from unconditional full fallbacks", () => {
  const commits = [
    { sha: "12985762804d8aaf180a0f9c1b40ee9a8bd03b35", candidate: true },
    { sha: "551bb5cb818cfabcb7ac02c153481d55e84e336c", candidate: true },
    { sha: "232ed49799b53c518246e8832795d564972a9373", candidate: true },
    { sha: "c82dc1bbc96d71d8b5c43823066cd22d5670e893", candidate: true },
    { sha: "a8e3da68be46e6b0b016b4dcdc00a484de45c0e0", candidate: true },
    { sha: "4c689fe57bf057f583f1513d270073c206c44e52", candidate: false },
    { sha: "4aa5cb55bc90e0f184acfab6c7eb2eb125d1cf78", candidate: false },
    { sha: "6b0e7b56871ecebdb7c9c0706b825b34f173639e", candidate: false },
    { sha: "8770fc918c74ee6fb86b6feb1d0b1e90fb14179b", candidate: false },
    { sha: "625e2cf8466629532d849abb1dce6884010931f9", candidate: false },
    { sha: "9ccd74e2d2422f5925524a842085a6a43c77037c", candidate: false },
    { sha: "672b7380cf7bdda2aebad395ad7a33a8d41fa49e", candidate: false },
  ];
  for (const entry of commits) {
    const raw = execFileSync(
      "git",
      ["diff", "--no-renames", "--name-status", "-z", `${entry.sha}^..${entry.sha}`, "--"],
      { encoding: "buffer" }
    );
    const diff = parseNulDiff(raw);
    assert.ok(diff.length > 0, entry.sha);
    const protectedPaths = diff
      .flatMap((item) => [item.path, ...(item.old_path ? [item.old_path] : [])])
      .map(classifyChangedPath)
      .filter(Boolean);
    assert.equal(protectedPaths.length > 0, !entry.candidate, entry.sha);
  }
});
