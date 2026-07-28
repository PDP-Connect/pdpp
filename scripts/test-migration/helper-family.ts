// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * T2-BATCH-PREP: mechanically derives "shared-helper-family" groupings over
 * the 741-file `reference-implementation/test/**\/*.js` tranche.
 *
 * Ground truth this builds on (do not re-derive, see
 * the T1-BUILD and T1-SAMPLE measurement reports):
 * Stage B's author-once/propagate-many cluster detector
 * (./stage-b.ts#detectStageBClusters) already finds, PER FILE, every
 * locally-declared single-parameter helper function called with a
 * repeated untyped callback shape (e.g. `withServer((x) => {...})` at N
 * call sites) — this is bucket (b1) of T1-SAMPLE's error taxonomy, the one
 * sub-mass that is mechanically propagable once a human authors ONE type.
 * On a flat/random 20-file slice, that mechanism only resolved 9.6% of
 * attributable error mass, and T1-BUILD's own conclusion was that this is
 * because a flat slice scatters helper families — most files simply don't
 * have the repeated-callback shape captured by any ONE file's clusters.
 *
 * The hypothesis this module exists to test: grouping files by the NAME of
 * the shared helper they call (not the file they declare it in — the same
 * `withServer`/`withHarness`-shaped helper is independently re-declared,
 * near-identically, in dozens of files; this is NOT a shared-module import
 * graph) should let a human author ONE type per helper family and apply it
 * across every file in that family in one authored pass, raising the
 * clusterable share far above 9.6%.
 *
 * Grouping key (why): a file's "helper surface" is the union of
 *   (1) every LOCALLY-DECLARED single-parameter helper name it calls in a
 *       Stage-B-eligible shape (`withServer`, `withHarness`, `withTempDb`,
 *       ...) — measured directly via `detectStageBClusters`, not guessed;
 *   (2) every shared test-helper MODULE it imports from
 *       `./helpers/<name>.js` (a real, if much smaller, shared-code axis:
 *       41 distinct helper modules, 87 importing files measured on this
 *       corpus — see helper-family.test.ts fixtures modeled on the real
 *       `operation-boundary.ts`/`dedicated-postgres-test-url.ts` shapes).
 * Two files are put in the same family if they share ANY element of
 * either set — this is a same-shape/same-name PREDICTOR of type reuse,
 * because a Terra/human who authors the type for `withServer`'s callback
 * shape in file A can copy that same annotation verbatim into every other
 * file that declares its own `withServer(fn)` with the same call-site
 * param shape, without re-deriving anything.
 *
 * This module is PURELY mechanical extraction + grouping (no batching
 * decisions, no validation runs) — see batch-plan.ts for ranking/sizing
 * and the disposable-worktree measurement step.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "@babel/parser";
import { walkBabelAst } from "./babel-ast-walk.ts";
import { detectStageBClusters } from "./stage-b.ts";
import { UnionFind } from "./union-find.ts";

const HELPER_IMPORT_SPECIFIER_PATTERN = /^\.\/helpers\/([a-zA-Z0-9._-]+)$/;
const HELPER_MODULE_EXTENSION_PATTERN = /\.(?:js|mjs|cjs|ts)$/;

export interface FileHelperSurface {
  /** repository-relative path, e.g. "reference-implementation/test/query-registry.test.ts". */
  file: string;
  /** Names of shared `./helpers/*.ts` modules imported (extension-stripped), e.g. ["operation-boundary"]. */
  importedHelperModules: string[];
  /** LOC of this file (newline count + 1 on non-empty content), for sizing. */
  loc: number;
  /** Sum of every Stage-B cluster's potentialErrorMassReduction found in this file. */
  localHelperClusterErrorMass: number;
  /** calleeName::shapeKey for every Stage-B-eligible cluster declared+called in this file (>=2 call sites). */
  localHelperClusterKeys: string[];
  /** True if the file could not be parsed as JS (binary/non-JS) — excluded from clustering, counted separately. */
  unparseable: boolean;
}

function importedHelperModuleNames(sourceText: string, fileName: string): string[] {
  const names = new Set<string>();
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(sourceText, { sourceType: "module", plugins: ["typescript"], sourceFilename: fileName });
  } catch {
    return [];
  }
  walkBabelAst(ast.program, (node) => {
    if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration") {
      return;
    }
    const { source } = node as { source?: { value?: string } };
    const specifier = source?.value;
    if (typeof specifier !== "string") {
      return;
    }
    const match = HELPER_IMPORT_SPECIFIER_PATTERN.exec(specifier);
    if (match?.[1]) {
      names.add(match[1].replace(HELPER_MODULE_EXTENSION_PATTERN, ""));
    }
  });
  // require(...) form, used by a handful of .js test files.
  walkBabelAst(ast.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const { callee } = node as { callee?: { name?: string; type: string } };
    const { arguments: args = [] } = node as { arguments?: unknown[] };
    if (callee?.type !== "Identifier" || callee.name !== "require" || args.length !== 1) {
      return;
    }
    const arg = args[0] as { type: string; value?: unknown };
    if (arg.type === "StringLiteral" && typeof arg.value === "string") {
      const match = HELPER_IMPORT_SPECIFIER_PATTERN.exec(arg.value);
      if (match?.[1]) {
        names.add(match[1].replace(HELPER_MODULE_EXTENSION_PATTERN, ""));
      }
    }
  });
  return [...names].sort();
}

function locOf(sourceText: string): number {
  if (sourceText.length === 0) {
    return 0;
  }
  return sourceText.split("\n").length;
}

/**
 * Extracts one file's helper surface. Never mutates anything on disk —
 * this is read-only analysis over already-tracked `reference-implementation/test/**`
 * content.
 */
export function extractFileHelperSurface(absolutePath: string, repoRelativePath: string): FileHelperSurface {
  let sourceText: string;
  try {
    sourceText = readFileSync(absolutePath, "utf8");
  } catch {
    return {
      file: repoRelativePath,
      loc: 0,
      unparseable: true,
      importedHelperModules: [],
      localHelperClusterKeys: [],
      localHelperClusterErrorMass: 0,
    };
  }
  const importedHelperModules = importedHelperModuleNames(sourceText, absolutePath);
  let clusterKeys: string[] = [];
  let clusterMass = 0;
  try {
    const clusters = detectStageBClusters(sourceText, absolutePath);
    clusterKeys = clusters.map((c) => `${c.calleeName}::${c.paramShape.kind}:${c.paramShape.names.join(",")}`);
    clusterMass = clusters.reduce((sum, c) => sum + c.potentialErrorMassReduction, 0);
  } catch {
    // Not parseable as JS/TS (rare in this corpus — e.g. a .sh test
    // executable that lives alongside .js files). Reported via
    // `unparseable`, never silently dropped.
    return {
      file: repoRelativePath,
      loc: locOf(sourceText),
      unparseable: true,
      importedHelperModules,
      localHelperClusterKeys: [],
      localHelperClusterErrorMass: 0,
    };
  }
  return {
    file: repoRelativePath,
    loc: locOf(sourceText),
    unparseable: false,
    importedHelperModules,
    localHelperClusterKeys: clusterKeys,
    localHelperClusterErrorMass: clusterMass,
  };
}

export interface HelperFamily {
  files: FileHelperSurface[];
  /** Every distinct grouping-key member this family shares (helper-cluster keys and/or imported-helper-module names). */
  keys: string[];
  /** "local-helper" if grouped by a Stage-B cluster key, "imported-module" if by a ./helpers/* import, "ungrouped" for singleton files with neither signal. */
  kind: "imported-module" | "local-helper" | "ungrouped";
  name: string;
}

const FILE_NODE_PREFIX = "file:";
const KEY_NODE_PREFIX = "key:";
const MODULE_KEY_PREFIX = "key:module:";

function surfaceKeys(surface: FileHelperSurface): string[] {
  return [
    ...surface.localHelperClusterKeys.map((k) => `key:local:${k}`),
    ...surface.importedHelperModules.map((m) => `${MODULE_KEY_PREFIX}${m}`),
  ];
}

function buildUnionFind(surfaces: FileHelperSurface[]): UnionFind {
  const uf = new UnionFind();
  for (const surface of surfaces) {
    const fileNode = `${FILE_NODE_PREFIX}${surface.file}`;
    uf.add(fileNode);
    for (const key of surfaceKeys(surface)) {
      uf.add(key);
      uf.union(fileNode, key);
    }
  }
  return uf;
}

function classifyFamilyKind(keys: string[]): HelperFamily["kind"] {
  if (keys.length === 0) {
    return "ungrouped";
  }
  if (keys.every((k) => k.startsWith("module:"))) {
    return "imported-module";
  }
  return "local-helper";
}

function familyNameFor(keys: string[], files: FileHelperSurface[]): string {
  if (keys[0]) {
    return keys[0];
  }
  const [first] = files;
  return first ? `singleton:${basename(first.file)}` : "empty";
}

/**
 * Groups files by shared helper surface using union-find over the two
 * signal sets (local-helper-cluster keys, imported-helper-module names):
 * any two files sharing at least one key land in the same family. This
 * is deliberately NOT filename-prefix grouping — measured on this corpus,
 * the dominant local-helper shapes (e.g. `withServer`) cut across dozens
 * of unrelated filename-prefix families (see
 * the T2 batch-preparation report §1 for the measurement),
 * so filename convention is a materially weaker predictor of type reuse
 * than the actual shared callable shape.
 */
export function groupIntoFamilies(surfaces: FileHelperSurface[]): HelperFamily[] {
  const uf = buildUnionFind(surfaces);
  const surfaceByFile = new Map(surfaces.map((s) => [s.file, s]));
  const groups = new Map<string, { fileNodes: Set<string>; keyNodes: Set<string> }>();
  for (const id of uf.ids()) {
    const root = uf.find(id);
    const group = groups.get(root) ?? { fileNodes: new Set(), keyNodes: new Set() };
    if (id.startsWith(FILE_NODE_PREFIX)) {
      group.fileNodes.add(id);
    } else {
      group.keyNodes.add(id);
    }
    groups.set(root, group);
  }
  const families: HelperFamily[] = [];
  for (const group of groups.values()) {
    if (group.fileNodes.size === 0) {
      continue; // a key with no surviving file member (shouldn't happen, defensive).
    }
    const files = [...group.fileNodes]
      .map((n) => surfaceByFile.get(n.slice(FILE_NODE_PREFIX.length)))
      .filter((s): s is FileHelperSurface => s !== undefined)
      .sort((a, b) => a.file.localeCompare(b.file));
    const keys = [...group.keyNodes].map((k) => k.slice(KEY_NODE_PREFIX.length)).sort((a, b) => a.localeCompare(b));
    families.push({ name: familyNameFor(keys, files), kind: classifyFamilyKind(keys), keys, files });
  }
  return families.sort((a, b) => b.files.length - a.files.length);
}

/** Convenience for CLI/plan callers: extracts surfaces for a list of repo-relative test files. */
export function extractAllSurfaces(repoRelativeFiles: string[], repoRoot: string): FileHelperSurface[] {
  return repoRelativeFiles.map((file) => extractFileHelperSurface(join(repoRoot, file), file));
}
