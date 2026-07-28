// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Literal-path scan: the defect class import-specifier checking cannot see
 * (fixture 2 in test-migration-rename-regression-fixtures.test.js). A
 * source-inspection test that names a file by a plain string literal (not
 * an import/require specifier) has no AST-visible link to that file, so an
 * AST-based rename codemod that only rewrites import statements will not
 * find it. This scans every STRING LITERAL in a file's source for an exact
 * match against any pre-rename path in the rename map, and fails closed if
 * one survives — the same invariant the harvested fixture proves.
 *
 * Deliberately scans string literals (via @babel/parser), not raw grep-the-
 * whole-file text, to avoid two failure directions: (a) false positives from
 * matching inside comments/unrelated text that happen to contain the
 * substring, and (b) false negatives from a literal path being built via
 * string concatenation that grep's substring match would still (correctly)
 * catch, so concatenation pieces are ALSO checked (see below) rather than
 * only whole-literal matches.
 */

import { parse } from "@babel/parser";
import { walkBabelAst } from "./babel-ast-walk.ts";
import type { RenameMap } from "./rename-map.ts";

export interface StaleLiteralPathHit {
  line: number;
  literal: string;
  matchedOldPath: string;
}

interface BabelNodeWithLoc extends Record<string, unknown> {
  loc: { start: { line: number } };
  type: string;
}

function collectStringLiterals(sourceText: string, fileName: string): { line: number; value: string }[] {
  const ast = parse(sourceText, { sourceType: "module", plugins: ["typescript"], sourceFilename: fileName });
  const literals: { line: number; value: string }[] = [];
  walkBabelAst(ast.program, (node) => {
    const typed = node as BabelNodeWithLoc;
    const stringLiteralValue = (typed as unknown as { value?: unknown }).value;
    if (typed.type === "StringLiteral" && typeof stringLiteralValue === "string") {
      literals.push({ line: typed.loc.start.line, value: stringLiteralValue });
    }
    if (typed.type === "TemplateElement") {
      const raw = (typed as { value?: { cooked?: string } }).value?.cooked;
      if (typeof raw === "string") {
        literals.push({ line: typed.loc.start.line, value: raw });
      }
    }
  });
  return literals;
}

/**
 * Scans a file's source text for any string literal (or template literal
 * segment) that exactly equals, or contains as a path-boundary-delimited
 * substring, a pre-rename path from the rename map. Path-boundary-delimited
 * means the match is preceded/followed by a non-path character (start,
 * end, quote, slash boundary already implied by literal extraction, or a
 * template-interpolation boundary) — this catches both the exact-literal
 * fixture-2 shape and a literal built as one segment of a template string.
 */
export function scanFileForStaleLiteralPaths(
  sourceText: string,
  fileName: string,
  renameMap: RenameMap
): StaleLiteralPathHit[] {
  const literals = collectStringLiterals(sourceText, fileName);
  const hits: StaleLiteralPathHit[] = [];
  for (const { line, value } of literals) {
    for (const entry of renameMap.entries) {
      if (value === entry.fromPath || value.endsWith(`/${entry.fromPath}`) || value.includes(entry.fromPath)) {
        hits.push({ line, literal: value, matchedOldPath: entry.fromPath });
      }
    }
  }
  return hits;
}
