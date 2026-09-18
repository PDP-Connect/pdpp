// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Freshness tests for the generated normative-matrix markdown and for the
// clause fields the report writer now carries.
//
// WHAT THIS PROTECTS. The per-revision docs/reference/conformance-normative-matrix*.md
// files are checked in so a reader can see the clause inventory without running
// anything. A checked-in generated file has one failure mode: someone edits
// matrix.ts, does not rerun the generator, and the published table quietly
// describes an inventory the suite no longer has. Nothing crashes; the document
// is simply wrong, and it is wrong in the direction of the old, smaller gap list.
//
// THE PLAUSIBLE DEFECT is therefore a forgotten `pnpm matrix:md` after any
// matrix edit. The oracle is byte equality against a fresh render, which is the
// only check that cannot itself drift.
//
// The report tests cover the second half of the same risk: the JSON report gained
// fields rather than changing any, and a passing requirement must disclose the
// MUST clauses its cases did not reach.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { matrixMarkdownPath, renderMatrixMarkdown } from "../scripts/render-matrix-md.ts";
import { renderMarkdown } from "../src/report/markdown.ts";
import { buildReport } from "../src/report/result.ts";
import { CLAUSE_MATRIX, SPEC_VERSIONS } from "../src/requirements/matrix.ts";

test("the checked-in matrix markdown matches the matrix data, at every revision", () => {
  // Every revision, not just v0.1: the generator writes one file per revision,
  // so a forgotten regenerate leaves the OTHER file stale just as silently. The
  // v0.2 file is the likelier casualty — a v0.1 edit that changes a clause the
  // proposal does not supersede changes both files, and only one is the one an
  // editor was looking at.
  for (const version of SPEC_VERSIONS) {
    const target = matrixMarkdownPath(version);
    assert.equal(
      readFileSync(target, "utf8"),
      renderMatrixMarkdown(version),
      `${target} is stale. Run \`pnpm --filter @pdpp/conformance-suite matrix:md\` ` +
        "and commit every file it writes."
    );
  }
});

test("a requirement result carries the clauses its item summarizes", () => {
  const report = buildReport({
    suite: { name: "test", version: "0" },
    target: {
      id: "t",
      version: "0",
      baseUrl: "http://127.0.0.1:1",
      roles: ["resource-server"],
    },
    run: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", reproducible: true },
    cases: [],
  });

  const rs10 = report.requirements.find((r) => r.requirement.id === "RS-10");
  assert.ok(rs10, "RS-10 must appear in a resource-server report.");
  assert.deepEqual(
    rs10.clauseIds,
    // The report defaults to v0.1, so the expectation is the v0.1 view — not the
    // whole inventory, which mixes revisions.
    CLAUSE_MATRIX.filter((c) => c.specVersion === "0.1" && c.requirementIds.includes("RS-10")).map((c) => c.clauseId),
    "A requirement's clause list must be exactly the matrix's clauses for it, at the reported revision."
  );
});

test("an uncovered MUST clause reaches the report with its gap note", () => {
  const report = buildReport({
    suite: { name: "test", version: "0" },
    target: {
      id: "t",
      version: "0",
      baseUrl: "http://127.0.0.1:1",
      roles: ["authorization-server"],
    },
    run: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", reproducible: true },
    cases: [],
  });

  // AS-16 is the strongest example in the catalogue: every clause it summarizes
  // is an uncovered MUST, so a report that dropped the field would still look
  // structurally fine while disclosing nothing.
  const as16 = report.requirements.find((r) => r.requirement.id === "AS-16");
  assert.ok(as16, "AS-16 must appear in an authorization-server report.");
  assert.ok(
    as16.uncoveredMustClauses.length > 0,
    "AS-16 summarizes MUST clauses no case exercises; the report must say so."
  );
  for (const clause of as16.uncoveredMustClauses) {
    assert.ok(
      clause.gapNote.length > 0,
      `Uncovered MUST clause ${clause.clauseId} reached the report with an empty gap note.`
    );
  }
});

test("the rendered report names uncovered MUST clauses under their requirement", () => {
  const report = buildReport({
    suite: { name: "test", version: "0" },
    target: {
      id: "t",
      version: "0",
      baseUrl: "http://127.0.0.1:1",
      roles: ["authorization-server"],
    },
    run: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", reproducible: true },
    cases: [],
  });
  const markdown = renderMarkdown(report);

  const inventory = markdown.slice(markdown.indexOf("## Clause coverage"));
  assert.ok(inventory.length > 0, "The report must carry a Clause coverage section.");

  const as16 = report.requirements.find((r) => r.requirement.id === "AS-16");
  assert.ok(as16);
  const [firstGap] = as16.uncoveredMustClauses;
  assert.ok(firstGap, "AS-16 must have at least one uncovered MUST clause.");
  assert.ok(
    inventory.includes(`\`${firstGap.clauseId}\``),
    `The rendered inventory must name clause ${firstGap.clauseId}.`
  );
  assert.ok(
    inventory.includes(firstGap.gapNote),
    "The rendered inventory must carry the gap note, not just the clause id."
  );
});

test("the JSON report keeps its existing requirement fields", () => {
  // Backward compatibility is the constraint the brief set: fields were added,
  // nothing renamed. A consumer reading `requirement`, `outcome` and `cases`
  // must keep working, so this asserts their presence rather than the absence
  // of the new ones.
  const report = buildReport({
    suite: { name: "test", version: "0" },
    target: {
      id: "t",
      version: "0",
      baseUrl: "http://127.0.0.1:1",
      roles: ["resource-server"],
    },
    run: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", reproducible: true },
    cases: [],
  });
  const [first] = report.requirements;
  assert.ok(first);
  for (const key of ["requirement", "outcome", "cases"]) {
    assert.ok(key in first, `RequirementResult lost the pre-existing field "${key}".`);
  }
});
