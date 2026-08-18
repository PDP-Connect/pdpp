// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves `CollectorRunConfig.executionRoot` for `@pdpp/collector-runtime`
 * (finding B3): the runtime no longer captures `process.cwd()` itself, so
 * the composition layer must supply an explicit, validated root — this
 * package's spawn `cwd`, the base for `node_modules/.bin` PATH lookup, and
 * the boundary the connector entrypoint must resolve beneath.
 *
 * Resolution order (first candidate that contains the resolved entrypoint
 * wins), adapted from the `@pdpp/local-collector` composition-layer helper
 * to this package's flat (non-monorepo) layout:
 *
 *   1. This package's own root — realpath'd, walked up from this file's
 *      location to the nearest `package.json`. True for every install
 *      shape, since this package IS the connector bundle root (it contains
 *      `connectors/` directly; there is no separate collector package
 *      nesting a vendored copy of it).
 *   2. The invoking process's `cwd()` — true when the CLI is run from an
 *      arbitrary directory (e.g. a packed/installed consumer) and the
 *      entrypoint argument is a relative dev path that only resolves there.
 *   3. The entrypoint's own containing directory — covers the `--command`/
 *      `--args` escape hatch (see `bin/collector-runner.ts`'s
 *      `entrypointCommand` option), an explicit, opted-in entrypoint choice
 *      rather than ambient state.
 *
 * Throws `CollectorExecutionRootError` only when no candidate can be
 * derived at all (no package root found, or no entrypoint argument given)
 * — never silently falls back to unvalidated ambient state.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class CollectorExecutionRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectorExecutionRootError";
  }
}

function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return realpathSync(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * The connector entrypoint is not reliably "the first non-flag arg" — e.g.
 * `["--import", "tsx", "/abs/path/index.ts"]` has a bare module specifier
 * (`tsx`) positioned before the real path. Instead, take the LAST arg that
 * resolves to an existing file under the candidate root: the entrypoint is
 * always the final positional argument in every call shape this package
 * uses (a trailing path, optionally preceded by loader flags/specifiers).
 */
function resolvedEntrypointUnder(args: readonly string[], candidateRoot: string): string | null {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i];
    if (!arg || arg.startsWith("-")) {
      continue;
    }
    const candidate = isAbsolute(arg) ? arg : resolve(candidateRoot, arg);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function lastPositionalArg(args: readonly string[]): string | null {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = args[i];
    if (arg && !arg.startsWith("-")) {
      return arg;
    }
  }
  return null;
}

function containsPath(root: string, target: string): boolean {
  const relative = target.slice(root.length);
  return target === root || (target.startsWith(root) && (relative.startsWith("/") || relative === ""));
}

export interface ResolveExecutionRootInput {
  readonly args: readonly string[];
}

export function resolveExecutionRoot(
  spec: ResolveExecutionRootInput,
  startUrl: string | URL = import.meta.url
): string {
  const positionalArg = lastPositionalArg(spec.args);
  if (!positionalArg) {
    throw new CollectorExecutionRootError(
      "cannot resolve executionRoot: connector spec has no entrypoint argument in `args`"
    );
  }

  const packageRoot = findPackageRoot(dirname(fileURLToPath(startUrl)));
  if (packageRoot) {
    const entrypoint = resolvedEntrypointUnder(spec.args, packageRoot);
    if (entrypoint && containsPath(packageRoot, realpathSync(entrypoint))) {
      return packageRoot;
    }
  }

  const cwdRoot = realpathSync(process.cwd());
  const entrypointUnderCwd = resolvedEntrypointUnder(spec.args, cwdRoot);
  if (entrypointUnderCwd && containsPath(cwdRoot, realpathSync(entrypointUnderCwd))) {
    return cwdRoot;
  }

  if (isAbsolute(positionalArg) && existsSync(positionalArg)) {
    return dirname(realpathSync(positionalArg));
  }

  if (packageRoot) {
    return packageRoot;
  }

  throw new CollectorExecutionRootError(
    `cannot resolve executionRoot: no candidate root contains entrypoint "${positionalArg}"`
  );
}
