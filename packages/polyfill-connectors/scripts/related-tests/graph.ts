// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the static import graph for polyfill-connectors via
 * dependency-cruiser, and exposes it as forward/reverse adjacency maps.
 *
 * dependency-cruiser resolves the `typescript` module by walking up from its
 * OWN install location, not from this package's declared devDependency by
 * name — if a resolvable `typescript` is missing or outside its supported
 * range (`>=2.0.0 <7.0.0` as of dependency-cruiser 18.2.0), it silently
 * treats every `.ts` file as an unparseable extension and returns a
 * near-empty module graph, with NO thrown error and NO stderr output. This
 * was verified directly against this exact package: cruising with
 * typescript@7.0.2 resolvable returned 5 modules (all non-`.ts` fixture
 * files); the same command with typescript@5 resolvable returned 751. The
 * only surviving signal is `result.summary.environment.extensionsFound`,
 * which is why `assertGraphIsTrustworthy` below is not optional ceremony —
 * it is the one thing standing between this tool and a silent, undetectable
 * under-selection across the entire suite.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { cruise } from "dependency-cruiser";

export interface ModuleNode {
  /** Direct static dependencies, including dynamic-import edges dependency-cruiser DID resolve. */
  readonly dependencies: readonly { readonly resolved: string; readonly dynamic: boolean }[];
  /** Direct static dependents (package-relative paths) already known to dependency-cruiser. */
  readonly dependents: readonly string[];
  /** Package-relative path, e.g. "src/orchestrator.ts". */
  readonly source: string;
}

export interface DependencyGraph {
  readonly modules: ReadonlyMap<string, ModuleNode>;
}

export class UntrustworthyGraphError extends Error {}

const CRUISE_ROOTS = ["bin", "connectors", "src"];

/**
 * Fails closed (throws) rather than returning a graph that may have been
 * silently truncated by an incompatible or missing `typescript` resolution.
 * Callers must treat this as "the whole selector is unusable right now" —
 * the correct response is the full suite, never an empty or partial one.
 *
 * Exported so its exact decision boundary can be unit-tested against
 * hand-built environment payloads (see select.test.ts), independent of
 * reproducing the underlying upstream typescript-version conflict inside a
 * fast unit test.
 */
export function assertGraphIsTrustworthy(environment: {
  readonly extensionsFound: readonly { readonly extension: string; readonly available: boolean }[];
  readonly issues?: readonly { readonly severity: string; readonly name: string }[];
}): void {
  const tsExtension = environment.extensionsFound.find((entry) => entry.extension === ".ts");
  if (!tsExtension?.available) {
    throw new UntrustworthyGraphError(
      "dependency-cruiser reports .ts sources are not parseable in this environment " +
        "(missing or incompatible `typescript` resolution). Refusing to trust the graph."
    );
  }
  const transpilerIssue = (environment.issues ?? []).find((issue) => issue.name === "missing-typescript-transpiler");
  if (transpilerIssue) {
    throw new UntrustworthyGraphError(
      `dependency-cruiser reported "${transpilerIssue.name}" (${transpilerIssue.severity}). Refusing to trust the graph.`
    );
  }
}

export async function buildDependencyGraph(packageRoot: string): Promise<DependencyGraph> {
  const rootsPresent = CRUISE_ROOTS.filter((root) => existsSync(join(packageRoot, root)));
  const result = await cruise(rootsPresent, {
    outputType: "json",
    exclude: "node_modules",
    tsConfig: { fileName: "tsconfig.json" },
    baseDir: packageRoot,
  });

  const parsed = JSON.parse(result.output as string) as {
    modules: {
      source: string;
      dependents: string[];
      dependencies: { resolved: string; dynamic: boolean; couldNotResolve?: boolean }[];
    }[];
    summary: {
      environment: {
        extensionsFound: { extension: string; available: boolean }[];
        issues?: { severity: string; name: string }[];
      };
    };
  };

  assertGraphIsTrustworthy(parsed.summary.environment);

  const modules = new Map<string, ModuleNode>();
  for (const module of parsed.modules) {
    modules.set(module.source, {
      source: module.source,
      dependents: module.dependents,
      dependencies: module.dependencies.map((dep) => ({
        resolved: dep.resolved,
        dynamic: dep.dynamic,
      })),
    });
  }
  return { modules };
}
