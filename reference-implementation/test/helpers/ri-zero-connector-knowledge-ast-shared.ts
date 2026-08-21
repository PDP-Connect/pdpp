// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared AST-walking plumbing for the zero-connector-knowledge conformance
 * guard's two `@babel/parser`-based scanners
 * (`ri-zero-connector-knowledge-identity-scan.ts`, rules 1/6/7, and
 * `ri-zero-connector-knowledge-data-load-scan.ts`, rule 5). Both scanners
 * parse each production file's TypeScript source into a real AST and then
 * need the same generic tree-walk primitives (a loosely-typed `Node` shape,
 * field accessors, a stack-based `walk`, identifier/callee-name predicates,
 * and a flat module-level `const`/top-level-function name table) before
 * diverging into their own resolution logic (identity/kind literal
 * resolution vs. path-argument resolution). This module holds exactly that
 * shared, behavior-identical plumbing — nothing from either scanner's
 * divergent resolver logic lives here.
 */

import { parse } from "@babel/parser";

// --- Minimal structural AST typing: @babel/parser's AST is a plain
// discriminated-union object tree; both scanners only need a handful of
// fields per node type, so a minimal structural type is enough here and
// keeps this module decoupled from @babel/types version churn.

export interface Node {
  end?: number | null;
  loc?: { start: { line: number } } | null;
  start?: number | null;
  type: string;
  [key: string]: unknown;
}

/**
 * Read a Babel AST array-valued field (`arguments`, `declarations`,
 * `params`, `quasis`, `attributes`/`assertions`, `body`) as `Node[]`,
 * defaulting to `[]` when absent. Centralizes the `(x.field as Node[]) ??
 * []` cast so the fallback stays genuinely meaningful to the type checker
 * (the field really is `unknown` on the loosely-typed `Node` interface,
 * unlike a per-site `as Node[]` cast, which erases that and makes the `??`
 * look like dead code).
 */
export function nodeArrayField(node: Node, field: string): Node[] {
  const value = node[field];
  return Array.isArray(value) ? (value as Node[]) : [];
}

/** Read a Babel AST node-valued field, or undefined if absent — same
 * cast-centralizing rationale as `nodeArrayField`. */
export function nodeField(node: Node, field: string): Node | undefined {
  const value = node[field];
  return value && typeof value === "object" ? (value as Node) : undefined;
}

export function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") {
      continue;
    }
    const value = (node as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && typeof (item as Node).type === "string") {
          out.push(item as Node);
        }
      }
    } else if (value && typeof value === "object" && typeof (value as Node).type === "string") {
      out.push(value as Node);
    }
  }
  return out;
}

export function walk(node: Node, visit: (n: Node, parent: Node | null, ancestors: Node[]) => void): void {
  const stack: Array<{ node: Node; ancestors: Node[] }> = [{ ancestors: [], node }];
  while (stack.length > 0) {
    const { node: current, ancestors } = stack.pop() as { node: Node; ancestors: Node[] };
    visit(current, ancestors.at(-1) ?? null, ancestors);
    const nextAncestors = [...ancestors, current];
    for (const child of children(current)) {
      stack.push({ ancestors: nextAncestors, node: child });
    }
  }
}

/**
 * Nearest enclosing TOP-LEVEL named `function foo(...) {}` declaration
 * (matching `localFunctions`' collection scope), or null if `node` is not
 * lexically inside one (module-level code, or inside an arrow function/
 * nested function declaration — deliberately not resolved through those,
 * since `localFunctions` only tracks top-level declarations). Walking from
 * the END of `ancestors` finds the nearest (innermost) enclosing function
 * first, so a function nested inside another top-level function correctly
 * resolves to its OWN immediate parent, not the outermost one — though in
 * practice `localFunctions` only recognizes the outer one as call-site-
 * indirectable, so a doubly-nested reference simply won't resolve, which is
 * the fail-closed behavior both scanners want.
 */
export function enclosingFunctionNameOf(ancestors: Node[]): string | null {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i] as Node;
    const id = ancestor.id as Node | undefined;
    if (ancestor.type === "FunctionDeclaration" && id?.type === "Identifier") {
      return id.name as string;
    }
  }
  return null;
}

export function isIdentifier(node: Node, name?: string): boolean {
  return node.type === "Identifier" && (name === undefined || node.name === name);
}

export function lineOf(node: Node): number {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `loc` is declared `?: {...} | null` on the loosely-typed Node interface (real Babel AST nodes can genuinely have a null/absent loc, e.g. synthetic nodes); `tsc --strict` on this file raises no error here, confirming the guard is live, not redundant.
  return node.loc?.start.line ?? 0;
}

export function calleeName(callee: Node): string | null {
  if (callee.type === "Identifier") {
    return callee.name as string;
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- `callee.property` is `unknown` on the loosely-typed Node interface's index signature; the `as Node` cast changes the STATIC type only, not runtime nullability (a real Babel AST node can have this field absent). `tsc --strict` raises no error on this file.
  if (callee.type === "MemberExpression" && (callee.property as Node)?.type === "Identifier") {
    return (callee.property as Node).name as string;
  }
  return null;
}

/**
 * Parse one file's source into a Babel AST `program` node, using the exact
 * options both scanners require: `errorRecovery: true` (never throw on
 * recoverable syntax — a genuine parse failure is still a thrown error;
 * see below), and plugin selection by file extension — the `typescript` and
 * `jsx` Babel parser plugins are mutually exclusive for `.ts` (non-`.tsx`)
 * sources (enabling both misparses a type-cast or generic like `<T>` as a
 * JSX element), so `.tsx`/`.jsx` files select
 * `["typescript", "jsx", "decorators"]` and everything else selects
 * `["typescript", "decorators"]`. The `decorators` plugin (standard/stage-3
 * syntax, not `decorators-legacy`) is always enabled: this repo's
 * `tsconfig.json` sets `erasableSyntaxOnly: true`, which rejects the legacy
 * experimental-decorators form outright, so standard decorators are the
 * only decorator syntax that can validly appear in a real `.ts` source file
 * here — without this plugin, any file using that (valid, erasable) syntax
 * would hit the parse-failure path below for a reason that has nothing to
 * do with the file being malformed. `importAttributes` (Babel 7's opt-in
 * flag for `import x from "y" with { type: "json" }`) was removed in Babel 8
 * — that syntax now parses unconditionally, so the plugin name is no longer
 * needed (or valid) here.
 *
 * Throws on a genuine parse failure (mirroring `@babel/parser`'s own
 * `parse()`); callers keep their own try/catch around this call. A parse
 * failure is itself a conformance violation — the scanner cannot prove a
 * file it cannot parse carries zero connector knowledge — so callers must
 * report it, never silently pass.
 */
export function parseSource(raw: string, absPath: string): Node {
  const isJsxExtension = absPath.endsWith(".tsx") || absPath.endsWith(".jsx");
  const ast = parse(raw, {
    errorRecovery: true,
    plugins: isJsxExtension ? ["typescript", "jsx", "decorators"] : ["typescript", "decorators"],
    sourceType: "module",
  }) as unknown as { program: Node };
  return ast.program;
}

/**
 * The one shared typed contract every `parseSource` consumer in this
 * conformance subsystem must report through when `parseSource` throws.
 * A file neither AST scanner (`ri-zero-connector-knowledge-identity-scan.ts`,
 * rules 1/6/7/4b; `ri-zero-connector-knowledge-data-load-scan.ts`, rule 5)
 * can parse is a file neither can prove carries zero connector knowledge —
 * silently returning `[]` from either scanner's catch block would certify an
 * unparseable production file as clean by omission. Both scanners' catch
 * blocks call this single function so the violation shape (rule name, line
 * extraction from the Babel error's `.loc`, reason text) can never drift
 * into two inconsistent parse-error contracts as the scanners evolve
 * independently. `scanFile` (the composer that runs both scanners over the
 * same file) is responsible for collapsing the resulting duplicate report —
 * one parse failure, reported once per scanner, is still only one actionable
 * violation for a human to act on — not this function, which only knows
 * about its own single call site.
 */
export const PARSE_FAILURE_RULE = "unparseable-production-file";

export interface ParseFailureViolation {
  file: string;
  line: number;
  rule: typeof PARSE_FAILURE_RULE;
  snippet: string;
}

export function parseFailureViolation(relPath: string, error: unknown): ParseFailureViolation {
  const loc = error instanceof Error && "loc" in error ? (error as { loc?: { line?: number } }).loc : undefined;
  const line = loc?.line ?? 0;
  const reason = error instanceof Error ? error.message : String(error);
  return { file: relPath, line, rule: PARSE_FAILURE_RULE, snippet: reason };
}

/**
 * Collect every `const NAME = <init>` declarator anywhere in the file
 * (module-level or nested inside a function body — e.g. a local `const
 * moduleSpecifier = "./x.ts"` right above a dynamic `import()`), plus every
 * top-level function declaration (for parameter indirection).
 *
 * This is deliberately NOT real lexical scoping — it is a flat, whole-file
 * name table. Two DIFFERENT bindings that happen to share a name (e.g. the
 * same local variable name reused in two unrelated functions) are ambiguous
 * under a flat table; rather than guess which one a given reference means,
 * a name bound to more than one syntactically-distinct initializer anywhere
 * in the file is deliberately dropped from the table entirely, so any
 * reference to it resolves to "unresolvable" — fail-closed, matching both
 * scanners' stated residual, rather than silently picking the wrong binding.
 * `let`/`var` declarators are excluded outright: they can be reassigned
 * after declaration, so trusting their initializer would be unsound even
 * with no naming collision at all.
 */
export function collectConstsAndFunctions(program: Node): {
  localFunctions: Map<string, { params: string[]; exported: boolean }>;
  moduleConsts: Map<string, Node>;
} {
  const moduleConsts = new Map<string, Node>();
  const ambiguousNames = new Set<string>();
  const localFunctions = new Map<string, { params: string[]; exported: boolean }>();

  function paramNames(params: Node[]): string[] {
    return params.filter((p) => p.type === "Identifier").map((p) => p.name as string);
  }

  walk(program, (node) => {
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const decl of nodeArrayField(node, "declarations")) {
        const declId = decl.id as Node | undefined;
        if (declId?.type !== "Identifier" || !decl.init) {
          continue;
        }
        const name = declId.name as string;
        if (ambiguousNames.has(name)) {
          continue;
        }
        const existing = moduleConsts.get(name);
        if (existing && existing !== decl.init) {
          moduleConsts.delete(name);
          ambiguousNames.add(name);
          continue;
        }
        moduleConsts.set(name, decl.init as Node);
      }
    }
  });

  for (const stmt of nodeArrayField(program, "body")) {
    let target = stmt;
    let exported = false;
    if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
      target = stmt.declaration as Node;
      exported = true;
    }
    const targetId = target.id as Node | undefined;
    if (target.type === "FunctionDeclaration" && targetId?.type === "Identifier") {
      localFunctions.set(targetId.name as string, {
        exported,
        params: paramNames(nodeArrayField(target, "params")),
      });
    }
  }
  return { localFunctions, moduleConsts };
}
