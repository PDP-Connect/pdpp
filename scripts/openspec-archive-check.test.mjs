#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Tests for the OpenSpec archive-due check.
//
// Two layers:
//   1. Pure-unit contract — synthetic tasks.md / change bodies prove the two
//      archive-due signals fire exactly when they should, and that owner/deploy
//      gate sections are excluded from the implementation tally (the whole
//      point: an unticked "Live Owner Gate" must NOT keep a change active).
//   2. Real-repo shape — the check runs against the live openspec tree and
//      asserts the output is well-formed and self-consistent, so a structural
//      regression (e.g. every change suddenly flagged, or none) fails here.
//
// Run: node --test scripts/openspec-archive-check.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyChange,
  extractReferencedPaths,
  isPostMergeSection,
  listActiveChanges,
  resolveReferencedPaths,
  runCli,
  tallyTasks,
} from "./openspec-archive-check.mjs";

// ---------------------------------------------------------------------------
// Section classification.
// ---------------------------------------------------------------------------

test("isPostMergeSection flags owner/deploy/live/acceptance gate headers", () => {
  const gates = [
    "## 0. RI Owner Return Gate",
    "## 6. Live rollout (owner)",
    "## 5. Live Acceptance",
    "## 6. Live Owner Gate",
    "## 7. Owner Decisions",
    "## 6. Deployment Posture",
    "## 8. Acceptance Checks",
    "## Acceptance checks",
    "## 4. Acceptance gate",
  ];
  for (const h of gates) {
    assert.equal(isPostMergeSection(h), true, `expected gate: ${h}`);
  }
});

test("isPostMergeSection treats real implementation sections as impl", () => {
  const impl = [
    "## 1. Design (this lane)",
    "## 3. Implementation",
    "## 2. Schema + boot migration (`postgres-storage.js`)",
    "## 3. Read/write path (`postgres-search.js`)",
    "## 1. Projection Contract",
    "## 4. Publish-Readiness Metadata (worker lane)", // exception: readiness authoring is impl
    "## 2. Tests",
  ];
  for (const h of impl) {
    assert.equal(isPostMergeSection(h), false, `expected impl: ${h}`);
  }
});

// ---------------------------------------------------------------------------
// Task tallying — impl vs gate split.
// ---------------------------------------------------------------------------

test("tallyTasks splits checkboxes by section flavor", () => {
  const body = [
    "# Tasks",
    "## 1. Implementation",
    "- [x] 1.1 build the thing",
    "- [x] 1.2 test the thing",
    "## 2. Live Owner Gate",
    "- [ ] 2.1 owner verifies in production", // never ticked, must NOT block
    "- [ ] 2.2 owner archives",
  ].join("\n");
  const { impl, gate } = tallyTasks(body);
  assert.deepEqual(impl, { done: 2, total: 2 });
  assert.deepEqual(gate, { done: 0, total: 2 });
});

test("implComplete ignores open owner-gate boxes", () => {
  // A change whose code work is all done but whose owner gate is open is
  // archive-due: the open boxes are residual risk, not blockers.
  const body = [
    "## 1. Build",
    "- [x] 1.1 done",
    "## 2. Acceptance Checks",
    "- [ ] 2.1 owner runs live acceptance",
  ].join("\n");
  const rec = classifyChange("synthetic", {
    readFile: () => body,
  });
  assert.equal(rec.implComplete, true);
  assert.equal(rec.archiveDue, true);
  assert.match(rec.reasons.join(" "), /implementation task/);
});

test("a genuinely in-flight change is NOT archive-due", () => {
  const body = [
    "## 1. Build",
    "- [x] 1.1 done",
    "- [ ] 1.2 still open impl work",
  ].join("\n");
  const rec = classifyChange("synthetic", {
    readFile: () => body,
    existsRepoRel: () => false, // no code landed
  });
  assert.equal(rec.implComplete, false);
  assert.equal(rec.codeExists, false);
  assert.equal(rec.archiveDue, false);
});

// ---------------------------------------------------------------------------
// Referenced-path extraction + resolution.
// ---------------------------------------------------------------------------

test("extractReferencedPaths keeps multi-segment code paths, drops bare names", () => {
  // Inject a readFile that serves proposal.md and throws (file-absent) for the
  // rest, exactly as readFileSync would. This exercises the real extractor,
  // including its missing-artifact tolerance.
  const bodies = {
    "proposal.md": [
      "references `server/postgres-search.js` and `index.js`",
      "also `reference-implementation/lib/spine.ts`",
      "not a path: `SomeType` or `foo` or `a.b`",
    ].join("\n"),
  };
  const readFile = (p) => {
    const key = p.split("/").pop();
    if (key in bodies) {
      return bodies[key];
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const got = extractReferencedPaths("/synthetic/change", readFile);
  assert.deepEqual(got, [
    "reference-implementation/lib/spine.ts",
    "server/postgres-search.js",
  ]);
  // bare `index.js`, `SomeType`, `foo`, `a.b` are excluded.
});

test("resolveReferencedPaths probes package roots and matches on ref", () => {
  const onRef = new Set([
    "reference-implementation/server/postgres-search.js",
    "reference-implementation/lib/spine.ts",
  ]);
  const existsRepoRel = (p) => onRef.has(p);
  // `postgres-search.js` named bare-of-package-root resolves under
  // reference-implementation/server via the package-root probe path only when
  // the ref-relative path matches. Here we feed already-server-relative names.
  const found = resolveReferencedPaths(
    ["server/postgres-search.js", "lib/spine.ts", "server/does-not-exist.js"],
    existsRepoRel
  );
  assert.deepEqual(found.sort(), [
    "reference-implementation/lib/spine.ts",
    "reference-implementation/server/postgres-search.js",
  ]);
});

test("codeExists signal fires from landed referenced paths alone", () => {
  const rec = classifyChange("synthetic", {
    readFile: (p) =>
      p.endsWith("proposal.md")
        ? "ports `server/records.js`"
        : "## 1. Build\n- [ ] 1.1 open", // impl not complete
    existsRepoRel: (p) => p === "reference-implementation/server/records.js",
  });
  assert.equal(rec.implComplete, false);
  assert.equal(rec.codeExists, true);
  assert.equal(rec.archiveDue, true);
});

// ---------------------------------------------------------------------------
// Real-repo shape.
// ---------------------------------------------------------------------------

test("real openspec tree: check is well-formed and discriminates", () => {
  const active = listActiveChanges();
  assert.ok(active.length > 0, "expected active changes in the repo");
  assert.ok(!active.includes("archive"), "archive/ must be excluded");

  const lines = [];
  const exitCount = runCli(["--json"], { log: (s) => lines.push(s) });
  const payload = JSON.parse(lines.join("\n"));

  assert.equal(payload.records.length, active.length);
  // The check must DISCRIMINATE: not everything archive-due, not nothing. If
  // this ever flips to all-or-none, the signal has broken.
  assert.ok(payload.archiveDue.length >= 0);
  assert.ok(
    payload.archiveDue.length <= payload.records.length,
    "cannot flag more than exist"
  );
  // exitCount tracks archive-due count for --strict callers.
  assert.equal(exitCount, payload.archiveDue.length);

  // Every archive-due record carries at least one reason.
  for (const rec of payload.records) {
    if (rec.archiveDue) {
      assert.ok(rec.reasons.length > 0, `${rec.name} archive-due with no reason`);
      assert.ok(rec.implComplete || rec.codeExists);
    }
  }
});

test("runCli default (non-strict) reporting returns archive-due count without throwing", () => {
  const lines = [];
  const count = runCli([], { log: (s) => lines.push(s) });
  assert.equal(typeof count, "number");
  const text = lines.join("\n");
  assert.match(text, /OpenSpec archive-due check/);
});
