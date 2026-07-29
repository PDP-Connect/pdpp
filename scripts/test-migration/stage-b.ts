// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage B — "author-once, propagate-many" cluster DETECTION (packet: "the
 * script must detect and report these clusters, not guess the type
 * itself"). This module never invents a type. It finds, for a single file,
 * every group of call sites that pass an untyped callback (arrow or
 * function expression) with the SAME shape — either a single positional
 * parameter name (`(dir) => {...}`) or the same destructured property set
 * (`({ asUrl, rsUrl, connectorId }) => {...}`) — to the SAME locally
 * declared helper function name, and reports them as one cluster ranked by
 * call-site count (a proxy for TS7006/TS7031 error-mass reduction: each
 * call site with an untyped callback parameter is one implicit-any error
 * under this repo's strict-plus tsconfig).
 *
 * Measured precedent (T1-SAMPLE measurement report
 * §2): `test/query-registry.test.ts`'s `withTempQueryDir((dir) => {...})`
 * shape hit 17 call sites sharing the identical untyped `dir` parameter,
 * and `test/b4-blob-fetch-conformance.test.ts`'s
 * `withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => {...})` hit 9.
 * Both are the exact two shapes this detector targets.
 *
 * Once a human/Terra authors ONE type for a cluster, `propagateClusterType`
 * mechanically inserts that annotation at the callback parameter of every
 * call site in the cluster AND at the corresponding parameter of the
 * helper function's own declaration (so the callback's inferred contextual
 * type and the helper's declared type agree) — never re-deriving the type,
 * only copying the human's text to every site the cluster identified.
 */

import { parse } from "@babel/parser";
import { walkBabelAst } from "./babel-ast-walk.ts";
import type { MagicString } from "./magic-string.ts";

interface CallbackParamShape {
  /** Sorted list of destructured property names, or a single positional name. */
  kind: "destructured" | "positional";
  names: string[];
}
interface CallSite {
  callbackParamEnd: number;
  callbackParamShape: CallbackParamShape;
  callbackParamStart: number;
  calleeName: string;
  line: number;
}
interface LocalHelperDeclaration {
  callbackParamEnd: number;
  callbackParamStart: number;
  line: number;
  name: string;
}

function paramShapeOf(param: unknown): CallbackParamShape | null {
  if (param === null || typeof param !== "object") {
    return null;
  }
  const typed = param as { name?: string; properties?: unknown[]; type: string };
  if (typed.type === "Identifier") {
    return { kind: "positional", names: [typed.name as string] };
  }
  if (typed.type === "ObjectPattern") {
    const names: string[] = [];
    for (const prop of typed.properties ?? []) {
      const p = prop as { key?: { name?: string }; type: string };
      if (p.type === "ObjectProperty" && p.key?.name) {
        names.push(p.key.name);
      } else {
        return null; // rest element or computed key — not a simple destructure, refuse to cluster it.
      }
    }
    return { kind: "destructured", names: [...names].sort() };
  }
  return null;
}
function shapeKey(shape: CallbackParamShape): string {
  return `${shape.kind}:${shape.names.join(",")}`;
}
/** True if the parameter has NO type annotation (the thing that triggers TS7006/TS7031). */
function isUnannotated(param: unknown): boolean {
  return !(param as { typeAnnotation?: unknown } | null)?.typeAnnotation;
}

interface BabelNodeWithLoc extends Record<string, unknown> {
  loc: { start: { line: number } };
  type: string;
}

function findLocalHelperDeclarations(programBody: unknown[]): Map<string, LocalHelperDeclaration> {
  const helpers = new Map<string, LocalHelperDeclaration>();
  for (const statement of programBody) {
    const stmt = statement as BabelNodeWithLoc & { id?: { name?: string }; params?: unknown[] };
    const fn = stmt.type === "FunctionDeclaration" ? stmt : null;
    if (!fn?.id?.name) {
      continue;
    }
    const params = fn.params ?? [];
    // Only single-parameter helpers are in scope for this cluster shape
    // (`function helper(fn) { ... }`, called as `helper((x) => {...})`) — a
    // helper with more than one parameter is a different, non-propagable
    // shape and is left alone. Whether the parameter is USED as a callback
    // is determined at each call site (findCallSites), not here: a
    // function-declaration parameter is always a plain Identifier in the
    // AST regardless of how its caller intends to use it.
    if (params.length !== 1) {
      continue;
    }
    helpers.set(fn.id.name, {
      name: fn.id.name,
      line: fn.loc.start.line,
      callbackParamStart: -1, // filled in below once we resolve the param's own callback param
      callbackParamEnd: -1,
    });
  }
  return helpers;
}

/** Builds a CallSite from a `helper((param) => {...})` call node, or undefined if this node isn't a call to a known local helper with an eligible untyped callback. */
function callSiteFor(typed: BabelNodeWithLoc, localHelperNames: Set<string>): CallSite | undefined {
  if (typed.type !== "CallExpression") {
    return;
  }
  const { callee } = typed as { callee?: { name?: string; type: string } };
  const args = (typed as { arguments?: unknown[] }).arguments ?? [];
  if (!(callee?.type === "Identifier" && callee.name && localHelperNames.has(callee.name) && args.length === 1)) {
    return;
  }
  const arg = args[0] as { params?: unknown[]; type: string };
  if (
    !((arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression") && (arg.params?.length ?? 0) === 1)
  ) {
    return;
  }
  const param = arg.params?.[0];
  const shape = paramShapeOf(param);
  if (!(shape && isUnannotated(param))) {
    return;
  }
  const { start, end } = param as { end: number; start: number };
  return {
    calleeName: callee.name,
    callbackParamShape: shape,
    callbackParamStart: start,
    callbackParamEnd: end,
    line: typed.loc.start.line,
  };
}

function findCallSites(node: unknown, localHelperNames: Set<string>, results: CallSite[]): void {
  walkBabelAst(node, (visited) => {
    const callSite = callSiteFor(visited as BabelNodeWithLoc, localHelperNames);
    if (callSite) {
      results.push(callSite);
    }
  });
}

export interface Stage_B_Cluster {
  calleeName: string;
  /** Every call site's callback-parameter byte range, for propagateClusterType to rewrite. */
  callSites: { end: number; line: number; start: number }[];
  paramShape: CallbackParamShape;
  /** Ranking signal: this many TS7006/TS7031-class errors this cluster's authored type can resolve at once. */
  potentialErrorMassReduction: number;
}

/**
 * Detects every author-once/propagate-many cluster in a single file's
 * source text. Returns clusters sorted by `potentialErrorMassReduction`
 * descending — the ranking the packet asks for ("ranking clusters by
 * error-mass reduction is the value").
 */
export function detectStageBClusters(sourceText: string, fileName: string): Stage_B_Cluster[] {
  const ast = parse(sourceText, { sourceType: "module", plugins: ["typescript"], sourceFilename: fileName });
  const programBody = (ast.program as { body: unknown[] }).body;
  const helpers = findLocalHelperDeclarations(programBody);
  if (helpers.size === 0) {
    return [];
  }
  const callSites: CallSite[] = [];
  findCallSites(ast.program, new Set(helpers.keys()), callSites);

  // Group by (calleeName, shapeKey) — a helper called with two DIFFERENT
  // untyped shapes (rare, but possible) is two separate clusters, because
  // they need two different authored types.
  const groups = new Map<string, CallSite[]>();
  for (const site of callSites) {
    const key = `${site.calleeName}::${shapeKey(site.callbackParamShape)}`;
    const existing = groups.get(key) ?? [];
    existing.push(site);
    groups.set(key, existing);
  }
  const clusters: Stage_B_Cluster[] = [];
  for (const sites of groups.values()) {
    if (sites.length < 2) {
      continue; // a single call site is not a propagation win — Terra just authors it inline.
    }
    const [first] = sites;
    if (!first) {
      continue;
    }
    clusters.push({
      calleeName: first.calleeName,
      paramShape: first.callbackParamShape,
      callSites: sites.map((s) => ({ start: s.callbackParamStart, end: s.callbackParamEnd, line: s.line })),
      potentialErrorMassReduction: sites.length * first.callbackParamShape.names.length,
    });
  }
  return clusters.sort((a, b) => b.potentialErrorMassReduction - a.potentialErrorMassReduction);
}

/**
 * Applies a human/Terra-authored type annotation to EVERY call site in one
 * cluster, mechanically. `annotation` must be the exact text to insert
 * after the parameter (e.g. ": string" for a positional param, or
 * ": { asUrl: string; rsUrl: string; connectorId: string }" for a
 * destructured one) — this function does not validate or infer it, it only
 * copies it verbatim to every site the cluster already identified.
 */
export function propagateClusterType(
  sourceText: string,
  cluster: Stage_B_Cluster,
  annotation: string,
  magicStringFactory: (text: string) => MagicString
): string {
  const ms = magicStringFactory(sourceText);
  for (const site of cluster.callSites) {
    const original = sourceText.slice(site.start, site.end);
    ms.overwrite(site.start, site.end, `${original}${annotation}`);
  }
  return ms.toString();
}
