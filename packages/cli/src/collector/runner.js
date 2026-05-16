import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CollectorUsageError } from './errors.js';

/**
 * Locate the collector-runner TypeScript entrypoint in the monorepo.
 *
 * The runner currently ships with `@pdpp/polyfill-connectors` (a private
 * workspace package), not with `@pdpp/cli` itself. When `pdpp` is invoked
 * from a checkout of the monorepo we walk up to the workspace root and
 * resolve `packages/polyfill-connectors/bin/collector-runner.ts`. From an
 * npm install (no workspace nearby) we throw an actionable error.
 */
export function resolveCollectorRunnerScript(startDir = dirname(fileURLToPath(import.meta.url))) {
  let cursor = resolve(startDir);
  const seen = new Set();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const candidate = join(cursor, 'packages', 'polyfill-connectors', 'bin', 'collector-runner.ts');
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

export function resolveTsxBinary(startDir = dirname(fileURLToPath(import.meta.url))) {
  let cursor = resolve(startDir);
  const seen = new Set();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const candidate = join(cursor, 'node_modules', '.bin', 'tsx');
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

const RUNNER_MISSING_MESSAGE =
  'The local collector runner ships with the PDPP monorepo, not with @pdpp/cli yet.\n' +
  'To run a collector on this machine:\n' +
  '  1. git clone https://github.com/vana-com/pdpp.git\n' +
  '  2. cd pdpp && pnpm install\n' +
  '  3. pnpm exec pdpp collector --help\n' +
  'Track when the runner ships in @pdpp/cli at openspec/changes/introduce-local-collector-runner.';

const TSX_MISSING_MESSAGE =
  'Could not locate tsx alongside the collector runner. Run `pnpm install` at the workspace root and try again.';

/**
 * Spawn the collector-runner subprocess. Inherits stdio so operators see
 * device tokens, run results, and diagnostics directly. Returns the exit
 * code, never throws on non-zero exits.
 */
export async function spawnCollectorRunner(
  subcommand,
  argv,
  {
    env = process.env,
    runnerScript = resolveCollectorRunnerScript(),
    tsxBinary = resolveTsxBinary(),
    spawnFn = spawn,
    stdio = 'inherit',
  } = {},
) {
  if (!runnerScript) {
    throw new CollectorUsageError(RUNNER_MISSING_MESSAGE);
  }
  if (!tsxBinary) {
    throw new CollectorUsageError(TSX_MISSING_MESSAGE);
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn(tsxBinary, [runnerScript, subcommand, ...argv], { env, stdio });
    child.on('error', rejectPromise);
    child.on('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`collector-runner terminated by signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}
