// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `startDir` looking for `node_modules/.bin/tsx`.
 *
 * Connector children are TypeScript entrypoints, so the collector spawns them
 * through `tsx`. Spawning the bare string `"tsx"` delegates the lookup to the
 * child's PATH, which is only correct when the collector itself was launched
 * from a shell whose PATH already contained `node_modules/.bin` — true under
 * `pnpm run`, false under a systemd unit, a launchd agent, or any supervisor
 * that starts the collector with a minimal environment. In that posture the
 * spawn fails with a bare `spawn tsx ENOENT` that names neither the cause nor
 * the fix. Resolving the absolute path here removes the PATH dependency from
 * the success path entirely.
 *
 * Returns `null` when no `tsx` is reachable; callers surface
 * `TSX_MISSING_MESSAGE` rather than attempting a spawn that can only fail.
 */
export function resolveTsxBinary(startDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let cursor = resolve(startDir);
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const candidate = join(cursor, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

/**
 * Actionable hint replacing the opaque `spawn tsx ENOENT`. Kept textually in
 * sync with `packages/cli/src/collector/runner.ts`, which cannot import this
 * module (see that file's note on the slim-CLI invariant).
 */
export const TSX_MISSING_MESSAGE =
  "Could not locate tsx alongside the collector runner. Install " +
  '@pdpp/local-collector with "npm i -g @pdpp/local-collector" or run ' +
  '"pnpm install" at the monorepo root.';

/**
 * Resolve the command used to spawn a connector child.
 *
 * An explicitly configured command (operator override, or a non-`tsx` runtime
 * such as `node`) is passed through untouched — only the implicit `tsx`
 * default is resolved to an absolute path. Throws `TSX_MISSING_MESSAGE` when
 * `tsx` is the command but no binary is reachable, so the failure names the
 * missing dependency instead of surfacing an ENOENT from deep inside spawn.
 */
export function resolveConnectorCommand(
  command: string,
  resolveBinary: (startDir?: string) => string | null = resolveTsxBinary
): string {
  if (command !== "tsx") {
    return command;
  }
  const binary = resolveBinary();
  if (!binary) {
    throw new Error(TSX_MISSING_MESSAGE);
  }
  return binary;
}
