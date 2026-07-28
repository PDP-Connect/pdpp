// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-resolution verification: for a given file, checks that every
 * relative `import`/`require` specifier it contains still resolves to a
 * file on disk. This is the mechanism that would have caught the historical
 * off-by-one `"../"` defect (fixture 1 in
 * test-migration-rename-regression-fixtures.test.js): a rename does not
 * itself change any relative specifier text (the renamed file's directory
 * never moves — see rename-map.ts's header comment), but a HAND-EDIT made
 * alongside a rename (as happened on d6520367b) can silently break one, and
 * this check is what must run as a blocking step over the full renamed set,
 * not as an afterthought.
 *
 * Resolution mirrors Node's own ESM relative-specifier algorithm via
 * `new URL(specifier, base)`, matching fixture 1's proof technique exactly.
 * Bare/package specifiers (no leading "./" or "../") are not checked here —
 * they resolve through node_modules/workspace mechanisms this tool does not
 * reproduce; only relative specifiers are in scope, which is also the only
 * class the historical defect touched.
 */

import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { walkBabelAst } from "./babel-ast-walk.ts";

export interface ImportSpecifierOccurrence {
  line: number;
  specifier: string;
}
export interface UnresolvedImport extends ImportSpecifierOccurrence {
  reason: string;
}

const RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//;
// Extensions Node/tsx can resolve directly without a resolver assist.
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"];

interface BabelNodeWithLoc extends Record<string, unknown> {
  loc: { start: { line: number } };
  type: string;
}

/** Import-like declarations (`import`, `export ... from`, `export * from`) whose `source` is a resolvable string literal. */
function importLikeSpecifier(typed: BabelNodeWithLoc): ImportSpecifierOccurrence | undefined {
  const isImportLike =
    typed.type === "ImportDeclaration" ||
    typed.type === "ExportNamedDeclaration" ||
    typed.type === "ExportAllDeclaration";
  const source =
    isImportLike && typeof typed.source === "object" ? (typed.source as { type: string; value?: string }) : undefined;
  const isRelativeSpecifier =
    source?.type === "StringLiteral" &&
    typeof source.value === "string" &&
    RELATIVE_SPECIFIER_PATTERN.test(source.value);
  return isRelativeSpecifier && source?.value !== undefined
    ? { specifier: source.value, line: typed.loc.start.line }
    : undefined;
}

/** `require('./relative/specifier')` call expressions. */
function requireCallSpecifier(typed: BabelNodeWithLoc): ImportSpecifierOccurrence | undefined {
  const { callee } = typed as { callee?: { name?: string; type?: string } };
  const isRequireCall = typed.type === "CallExpression" && callee?.type === "Identifier" && callee.name === "require";
  const args = (typed as { arguments?: unknown[] }).arguments ?? [];
  const arg = isRequireCall ? (args[0] as { type?: string; value?: string } | undefined) : undefined;
  const isRelativeSpecifier =
    arg?.type === "StringLiteral" && typeof arg.value === "string" && RELATIVE_SPECIFIER_PATTERN.test(arg.value);
  return isRelativeSpecifier && arg?.value !== undefined
    ? { specifier: arg.value, line: typed.loc.start.line }
    : undefined;
}

/** Extracts every static relative import/re-export/require specifier from source text. */
export function relativeImportSpecifiers(sourceText: string, fileName: string): ImportSpecifierOccurrence[] {
  const ast = parse(sourceText, { sourceType: "module", plugins: ["typescript"], sourceFilename: fileName });
  const found: ImportSpecifierOccurrence[] = [];
  walkBabelAst(ast.program, (node) => {
    const typed = node as BabelNodeWithLoc;
    const occurrence = importLikeSpecifier(typed) ?? requireCallSpecifier(typed);
    if (occurrence) {
      found.push(occurrence);
    }
  });
  return found;
}

/**
 * Resolves a single relative specifier against a base file path using
 * Node's own URL-resolution algorithm (same technique as fixture 1),
 * trying the specifier as-written, then with each resolvable extension
 * appended (covers extension-less specifiers), then as a directory index.
 */
export function resolvesOnDisk(specifier: string, baseAbsoluteFilePath: string): boolean {
  const baseUrl = pathToFileURL(baseAbsoluteFilePath);
  const candidates: string[] = [];
  if (extname(specifier)) {
    candidates.push(specifier);
  } else {
    for (const ext of RESOLVABLE_EXTENSIONS) {
      candidates.push(`${specifier}${ext}`);
    }
    for (const ext of RESOLVABLE_EXTENSIONS) {
      candidates.push(`${specifier}/index${ext}`);
    }
  }
  return candidates.some((candidate) => {
    try {
      return existsSync(fileURLToPath(new URL(candidate, baseUrl)));
    } catch {
      return false;
    }
  });
}

/**
 * Verifies every relative import specifier in a file resolves. Returns the
 * list of specifiers that do NOT resolve — an empty list means the file's
 * relative import graph is intact. Fails closed by construction: callers
 * must treat any non-empty result as a hard stop, never a warning.
 */
export function verifyFileImportsResolve(sourceText: string, absoluteFilePath: string): UnresolvedImport[] {
  const specifiers = relativeImportSpecifiers(sourceText, absoluteFilePath);
  const unresolved: UnresolvedImport[] = [];
  for (const occurrence of specifiers) {
    if (!resolvesOnDisk(occurrence.specifier, absoluteFilePath)) {
      unresolved.push({ ...occurrence, reason: "does not resolve to a file on disk" });
    }
  }
  return unresolved;
}
