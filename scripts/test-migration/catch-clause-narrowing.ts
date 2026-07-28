// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Catch-clause narrowing: the one bucket-(a) TS18046 ("'x' is of type
 * 'unknown'") pattern the T1-SAMPLE measurement found to be genuinely
 * mechanical (see the T1-SAMPLE measurement report §2, "Bucket
 * (a)"). This tsconfig already sets `useUnknownInCatchVariables: true`, so
 * every `catch (name) { ... }` parameter is implicitly `unknown`; TS18046
 * fires only where the block then accesses a PROPERTY of that unknown
 * value.
 *
 * PROVEN PRECONDITION, scoped deliberately narrow (measured against the
 * real 700-file test corpus — see the worker report for the full
 * breakdown): this transform touches ONLY the single, unambiguous,
 * behavior-preserving shape:
 *
 *   catch (name) { ... name.message ... }
 *
 * rewritten to:
 *
 *   catch (name) { ... (name instanceof Error ? name.message : String(name)) ... }
 *
 * which is semantically identical for every real JS value (Error instances
 * keep their real .message; any other thrown value — string, number,
 * plain object — gets a readable String() fallback instead of
 * `undefined`/a crash), and is the exact idiom TypeScript's own
 * documentation recommends for `useUnknownInCatchVariables`.
 *
 * It REFUSES to run (fails closed, returns null, never guesses) on any
 * catch clause whose body:
 *   - has no `.message` access at all (nothing to narrow — left alone).
 *   - accesses any OTHER property of the caught value (`.code`, `.stderr`,
 *     `.stdout`, computed access, etc.) — this requires knowing the real
 *     shape of what can be thrown at that site, which is a judgment call,
 *     not a mechanical rewrite (measured: 3 of 67 real catch clauses in
 *     this corpus hit this refusal path).
 *   - has a destructuring catch parameter, or no parameter at all.
 *   - already has an explicit type annotation on the parameter.
 */

import { parse } from "@babel/parser";
import { walkBabelAst } from "./babel-ast-walk.ts";
import type { MagicString } from "./magic-string.ts";

interface CatchClauseNode {
  body: { body: unknown[] };
  param: { end: number; name?: string; start: number; type: string } | null;
}
interface MemberAccess {
  end: number;
  property: string;
  start: number;
}

/** True for the exact `<paramName> instanceof Error` test shape. */
function isInstanceofErrorGuard(node: unknown, paramName: string): boolean {
  if (node === null || typeof node !== "object") {
    return false;
  }
  const typed = node as {
    left?: { name?: string; type: string };
    right?: { name?: string; type: string };
    type: string;
  };
  return (
    typed.type === "BinaryExpression" &&
    (typed as unknown as { operator?: string }).operator === "instanceof" &&
    typed.left?.type === "Identifier" &&
    typed.left.name === paramName &&
    typed.right?.type === "Identifier" &&
    typed.right.name === "Error"
  );
}

/** Records `node` as a MemberAccess if it is `<paramName>.<property>`. */
function recordIfMemberAccessOn(
  node: Record<string, unknown> & { end: number; start: number; type: string },
  paramName: string,
  results: MemberAccess[]
): void {
  if (node.type !== "MemberExpression") {
    return;
  }
  const object = node.object as { name?: string; type: string };
  const property = node.property as { name?: string; type: string };
  const computed = node.computed as boolean;
  if (object.type === "Identifier" && object.name === paramName) {
    results.push({
      property: computed ? "[computed]" : (property.name ?? "[unknown]"),
      start: node.start,
      end: node.end,
    });
  }
}

/**
 * Finds every `<paramName>.message` (or other property) access, EXCEPT
 * ones already inside the "then" branch of an `instanceof Error` guard on
 * the same identifier (`err instanceof Error ? err.message : ...` or
 * `if (err instanceof Error) { ...err.message... }`) — those are already
 * behavior-identical to what this transform would produce, so re-wrapping
 * them would only add redundant nesting, not change behavior. Skipping
 * them is itself provably safe: the guard condition is re-checked
 * structurally (exact `instanceof Error` on the same name), not assumed.
 */
function findMemberAccessesOn(node: unknown, paramName: string, results: MemberAccess[], guarded = false): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  const typed = node as Record<string, unknown> & { type: string; start: number; end: number };
  if (!guarded) {
    recordIfMemberAccessOn(typed, paramName, results);
  }
  if (typed.type === "ConditionalExpression") {
    const cond = typed as unknown as { alternate: unknown; consequent: unknown; test: unknown };
    findMemberAccessesOn(cond.test, paramName, results, guarded);
    findMemberAccessesOn(cond.consequent, paramName, results, guarded || isInstanceofErrorGuard(cond.test, paramName));
    findMemberAccessesOn(cond.alternate, paramName, results, guarded);
    return;
  }
  if (typed.type === "IfStatement") {
    const ifStmt = typed as unknown as { alternate: unknown | null; consequent: unknown; test: unknown };
    findMemberAccessesOn(ifStmt.test, paramName, results, guarded);
    findMemberAccessesOn(
      ifStmt.consequent,
      paramName,
      results,
      guarded || isInstanceofErrorGuard(ifStmt.test, paramName)
    );
    findMemberAccessesOn(ifStmt.alternate, paramName, results, guarded);
    return;
  }
  // Every other node shape has no special guard-propagation rule: recurse
  // generically, carrying the current `guarded` state forward unchanged.
  for (const key of Object.keys(typed)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") {
      continue;
    }
    const value = typed[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        findMemberAccessesOn(item, paramName, results, guarded);
      }
    } else if (value && typeof value === "object") {
      findMemberAccessesOn(value, paramName, results, guarded);
    }
  }
}

export interface CatchNarrowingPlanEntry {
  end: number;
  line: number;
  paramName: string;
  reason: "eligible" | "no-member-access" | "non-message-property" | "unsupported-param-shape";
  replacement?: string;
  start: number;
}

/** Classifies one `catch (name) { ... }` clause into its plan entries (one for a destructured/no-param clause, one per eligible `.message` site otherwise). */
function classifyCatchClause(
  clause: CatchClauseNode & { loc: { start: { line: number } } }
): CatchNarrowingPlanEntry[] {
  if (!clause.param) {
    return []; // no-parameter catch — nothing can throw TS18046 here.
  }
  if (clause.param.type !== "Identifier") {
    return [
      {
        reason: "unsupported-param-shape",
        paramName: "<destructured>",
        line: clause.loc.start.line,
        start: clause.param.start,
        end: clause.param.end,
      },
    ];
  }
  const paramName = clause.param.name as string;
  const accesses: MemberAccess[] = [];
  findMemberAccessesOn(clause.body, paramName, accesses);
  const nonMessage = accesses.filter((a) => a.property !== "message");
  const messageAccesses = accesses.filter((a) => a.property === "message");
  if (accesses.length === 0) {
    return [
      {
        reason: "no-member-access",
        paramName,
        line: clause.loc.start.line,
        start: clause.param.start,
        end: clause.param.end,
      },
    ];
  }
  if (nonMessage.length > 0) {
    return [
      {
        reason: "non-message-property",
        paramName,
        line: clause.loc.start.line,
        start: clause.param.start,
        end: clause.param.end,
      },
    ];
  }
  // Eligible: every access is `.message`. One entry per access site's exact
  // byte range so the transform can replace `name.message` with the
  // narrowed expression at each occurrence.
  return messageAccesses.map((access) => ({
    reason: "eligible" as const,
    paramName,
    line: clause.loc.start.line,
    start: access.start,
    end: access.end,
    replacement: `(${paramName} instanceof Error ? ${paramName}.message : String(${paramName}))`,
  }));
}

/**
 * Analyzes a file's source and returns a plan: one entry per `catch (name)
 * { ... }` clause found, classified by eligibility. Entries with
 * `reason: "eligible"` are candidates for rewriting; every other reason is
 * an explicit, named refusal — never a silent skip.
 */
export function planCatchClauseNarrowing(sourceText: string, fileName: string): CatchNarrowingPlanEntry[] {
  const ast = parse(sourceText, { sourceType: "module", plugins: ["typescript"], sourceFilename: fileName });
  const plan: CatchNarrowingPlanEntry[] = [];
  walkBabelAst(ast.program, (node) => {
    if (node.type === "CatchClause") {
      plan.push(...classifyCatchClause(node as unknown as CatchClauseNode & { loc: { start: { line: number } } }));
    }
  });
  return plan;
}

/**
 * Applies only the "eligible" entries of a plan to source text, using
 * MagicString-style splice-by-offset so multiple replacements in one file
 * don't invalidate each other's byte offsets (see magic-string.ts).
 */
export function applyCatchClauseNarrowing(
  sourceText: string,
  plan: CatchNarrowingPlanEntry[],
  magicStringFactory: (text: string) => MagicString
): string {
  const eligible = plan.filter(
    (entry): entry is CatchNarrowingPlanEntry & { replacement: string } =>
      entry.reason === "eligible" && entry.replacement !== undefined
  );
  if (eligible.length === 0) {
    return sourceText;
  }
  const ms = magicStringFactory(sourceText);
  for (const entry of eligible) {
    ms.overwrite(entry.start, entry.end, entry.replacement);
  }
  return ms.toString();
}
