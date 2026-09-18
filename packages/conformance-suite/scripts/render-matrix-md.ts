// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Renders docs/reference/conformance-normative-matrix*.md from matrix.ts, one
// file per spec revision.
//
// The markdown is a GENERATED VIEW, never an independent source. It is checked
// in so a reader can see the inventory without running anything, and a self-test
// (test/matrix-markdown.test.ts) fails when the checked-in file drifts from the
// data — otherwise the published table would slowly stop describing the matrix
// the suite actually uses.
//
// Run: pnpm --filter @pdpp/conformance-suite matrix:md

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIREMENTS } from "../src/requirements/catalog.ts";
import {
  type ClauseEntry,
  clausesForRequirement,
  clausesForVersion,
  clausesWithoutRequirement,
  SPEC_VERSIONS,
  type SpecVersion,
} from "../src/requirements/matrix.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

/**
 * One rendered file per revision.
 *
 * Separate files rather than one file with two halves: the reader of a matrix
 * is asking "what does a conformant implementation owe", and that question has
 * a different answer per revision. Interleaving them in one document would make
 * every row require a version column to read correctly, and the v0.1 file — the
 * adopted one — would grow proposal text a v0.1 implementer does not owe.
 */
export function matrixMarkdownPath(version: SpecVersion): string {
  const suffix = version === "0.1" ? "" : `-v${version}`;
  return join(REPO_ROOT, "docs", "reference", `conformance-normative-matrix${suffix}.md`);
}

/** The v0.1 path, kept under its original name so existing links still resolve. */
export const MATRIX_MARKDOWN_PATH = matrixMarkdownPath("0.1");

/** Escapes the one character that would break out of a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function clauseRow(clause: ClauseEntry): string {
  const cases = clause.caseIds.length > 0 ? clause.caseIds.map((id) => `\`${id}\``).join("<br>") : "—";
  const gap = clause.gapNote ? cell(clause.gapNote) : "—";
  return `| \`${clause.clauseId}\` | ${clause.level.toUpperCase()} | ${clause.observable} | ${cases} | ${gap} |`;
}

function clauseTable(clauses: readonly ClauseEntry[]): readonly string[] {
  return [
    "| Clause | Level | Observable | Cases | Gap |",
    "| --- | --- | --- | --- | --- |",
    ...clauses.map(clauseRow),
  ];
}

function countsByKey<T extends string>(
  clauses: readonly ClauseEntry[],
  keyOf: (clause: ClauseEntry) => readonly T[] | T
): ReadonlyMap<T, number> {
  const counts = new Map<T, number>();
  for (const clause of clauses) {
    const value = keyOf(clause);
    for (const key of Array.isArray(value) ? value : [value as T]) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function renderTotals(clauses: readonly ClauseEntry[]): readonly string[] {
  const musts = clauses.filter((c) => c.level === "must");
  const coveredMusts = musts.filter((c) => c.caseIds.length > 0);
  const byLevel = countsByKey(clauses, (c) => c.level);
  const byRole = countsByKey(clauses, (c) => c.role);
  const byObservable = countsByKey(clauses, (c) => c.observable);

  return [
    "## Totals",
    "",
    `Clauses enumerated: **${clauses.length}**. ` +
      `MUST-level: **${musts.length}**, of which **${coveredMusts.length}** have at least one case ` +
      `and **${musts.length - coveredMusts.length}** do not.`,
    "",
    "A clause counts as covered when a registered case exercises it. Coverage is",
    "not a conformance claim about any target: a case exists or it does not, and",
    "whether it passes is a separate question a run answers.",
    "",
    "| Level | Clauses |",
    "| --- | --- |",
    ...[...byLevel].map(([level, count]) => `| ${level.toUpperCase()} | ${count} |`),
    "",
    "| Role | Clauses |",
    "| --- | --- |",
    ...[...byRole].map(([role, count]) => `| ${role} | ${count} |`),
    "",
    "A clause binding two roles is counted under each, so the role column sums",
    "above the clause total.",
    "",
    "| Observable | Clauses |",
    "| --- | --- |",
    ...[...byObservable].map(([observable, count]) => `| ${observable} | ${count} |`),
  ];
}

function renderRequirementSections(version: SpecVersion): readonly string[] {
  const lines = [
    "## Clauses by Section 9 item",
    "",
    "One table per numbered item, in catalogue order. An item's clauses are the",
    "normative text it summarizes — read them, not the item's one-line statement,",
    "to know what a result about that item does and does not establish.",
    "",
  ];
  for (const requirement of REQUIREMENTS) {
    const clauses = clausesForRequirement(requirement.id, version);
    lines.push(
      `### ${requirement.id} (${requirement.role}, ${requirement.level.toUpperCase()})`,
      "",
      requirement.statement,
      ""
    );
    if (clauses.length === 0) {
      lines.push("No clause in sections 4-8 or 10 maps to this item.", "");
      continue;
    }
    lines.push(...clauseTable(clauses), "");
  }
  return lines;
}

function renderUnmapped(version: SpecVersion): readonly string[] {
  const orphans = clausesWithoutRequirement(version);
  const lines = [
    "## Clauses no Section 9 item covers",
    "",
    "These are normative clauses with nowhere to roll up. Most bind the author of",
    "a SourceDeclaration, and Section 9 numbers conformance items for three roles",
    "— authorization server, resource server, client — with no list for that",
    "author. They are recorded here rather than dropped, because a clause that no",
    "conformance item names is invisible to every coverage number the suite",
    "reports.",
    "",
  ];
  if (orphans.length === 0) {
    lines.push("None.", "");
    return lines;
  }
  lines.push(...clauseTable(orphans), "");
  return lines;
}

/** The per-revision preamble, stating what the file is and is not. */
function renderRevisionNote(version: SpecVersion): readonly string[] {
  if (version === "0.1") {
    return [
      "This file is the **v0.1** inventory: the adopted normative draft at",
      "`spec-core.md`. The proposal's inventory is a separate file,",
      "`conformance-normative-matrix-v0.2.md`.",
      "",
      "Every normative clause in Core sections 4, 5, 6, 7, 8 and 10, mapped to the",
    ];
  }
  return [
    "This file is the **v0.2** inventory. v0.2 is the private normative proposal in",
    "vana-com/pdpp PR #1, *not an adopted revision*: a conformance claim made today",
    "is a claim against v0.1, and this file exists so the suite's mechanics are ready",
    "when the proposal lands.",
    "",
    "It lists the clauses in force at v0.2: the v0.2 entries transcribed so far, plus",
    "every v0.1 clause the proposal does not supersede. A clause carrying",
    "`supersedes` replaces the v0.1 clause it names, and that v0.1 clause is absent",
    "here — which is why this file is not a superset of the v0.1 one.",
    "",
    "Transcription from v0.2 is **partial**. This batch covers the black-box-observable",
    "authorization-server clauses of Section 6 on required/optional streams and",
    "explicit authorization minima. Clauses of other sections still appear at their",
    "v0.1 text, and a reader must not read their presence as evidence the proposal",
    "left them unchanged.",
    "",
    "Every v0.2 clause below has an EMPTY case list. No case exercises v0.2 text yet;",
    "each carries the gap note naming what is missing.",
    "",
    "Clauses mapped to the",
  ];
}

export function renderMatrixMarkdown(version: SpecVersion = "0.1"): string {
  const clauses = clausesForVersion(version);
  const sections = [
    [
      `# PDPP Core normative matrix (v${version})`,
      "",
      "GENERATED FILE — do not edit by hand. Source:",
      "`packages/conformance-suite/src/requirements/matrix.ts`. Regenerate with",
      "`pnpm --filter @pdpp/conformance-suite matrix:md`;",
      "`test/matrix-markdown.test.ts` fails when this file and the data disagree.",
      "",
      ...renderRevisionNote(version),
      "Section 9 conformance items that summarize it and to the suite cases that",
      "exercise it. Section 9 is the index here, not the authority: its 45 numbered",
      "items are one-line precis of the clauses below.",
      "",
      "`Observable` records how a clause could be checked at all, independent of",
      "whether this suite checks it today. `review-only` marks a clause that",
      "black-box observation cannot reach — a rendered consent surface, an internal",
      "ordering, a legal commitment — so that it is never silently counted as",
      "covered.",
      "",
      "## Obligations from referenced standards",
      "",
      "This matrix enumerates clauses of **spec-core.md only**. Every row carries a",
      "`clauseId` of the form `<section>.<subsection>-<n>`, prefixed `v0.2/` for a",
      "clause transcribed from the proposal, and a `specAnchor` that a self-test",
      "verifies against the revision's own file. A row that is not in Core cannot be",
      "added without inventing an identifier Core does not define — which would make",
      "the matrix a worse record of what Core says, not a better one.",
      "",
      'But Core adopts other standards by normative reference (Section 2, "Related',
      'standards"): it profiles OAuth 2.0 and uses the RFC 9396 `authorization_details`',
      "envelope. Those standards carry obligations Core does not restate, and a",
      "conforming PDPP deployment owes them anyway. RFC 9396 Section 7 is the worked",
      "example: a token response for a request that carried `authorization_details`",
      "must itself carry the `authorization_details` as granted. Core describes the",
      "envelope and the introspection response; it never restates the token-response",
      "obligation.",
      "",
      "Such obligations are tracked **on the case, not in this matrix**. A case",
      "exercising one cites the referenced standard by name and section in its",
      "`assertion` and in its source comment, and maps to the Section 9 requirement",
      "whose subject matter it belongs to. The coverage counts above therefore",
      "measure Core clauses only, and a suite run may legitimately contain cases this",
      "matrix does not list. Searching the case list for a standard's name is how to",
      "find them; `AS-9/token-response-carries-granted-authorization-details` is the",
      "one that exists today.",
    ].join("\n"),
    renderTotals(clauses).join("\n"),
    renderRequirementSections(version).join("\n"),
    renderUnmapped(version).join("\n"),
  ];
  return `${sections.join("\n\n")}\n`;
}

function main(): void {
  for (const version of SPEC_VERSIONS) {
    const target = matrixMarkdownPath(version);
    writeFileSync(target, renderMatrixMarkdown(version), "utf8");
    process.stdout.write(`Wrote ${target}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
