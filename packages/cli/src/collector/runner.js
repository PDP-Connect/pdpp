import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CollectorUsageError } from './errors.js';

/**
 * Resolve the published `@pdpp/local-collector` package, if installed.
 *
 * The shim prefers an installed `@pdpp/local-collector` so an operator who
 * `npm i -g @pdpp/cli@beta && npm i -g @pdpp/local-collector@beta` can run
 * `pdpp collector ...` without a monorepo checkout. Resolution is lazy —
 * the CLI does NOT declare a runtime dependency on `@pdpp/local-collector`
 * (per `publish-pdpp-local-collector` task 4.4); a missing package is
 * surfaced as an actionable install hint rather than a hard import error.
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §1.
 */
export function resolveLocalCollectorPackage(startDir = dirname(fileURLToPath(import.meta.url))) {
  // Primary resolution: Node module resolution from the caller. Works for an
  // npm install where @pdpp/local-collector is alongside @pdpp/cli in the
  // same node_modules tree.
  try {
    const require = createRequire(join(startDir, '_'));
    const manifestPath = require.resolve('@pdpp/local-collector/package.json');
    return { manifestPath, packageDir: dirname(manifestPath) };
  } catch {
    // Continue to workspace fallback.
  }
  // Fallback: walk up the directory tree looking for a sibling
  // packages/local-collector workspace. Preserves the monorepo dev flow
  // where pnpm does not hoist workspace packages into @pdpp/cli's local
  // node_modules (per the slim-CLI invariant in task 4.4).
  let cursor = resolve(startDir);
  const seen = new Set();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const candidate = join(cursor, 'packages', 'local-collector', 'package.json');
    if (existsSync(candidate)) {
      return { manifestPath: candidate, packageDir: dirname(candidate) };
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
 * Locate the in-monorepo collector-runner TypeScript entrypoint.
 *
 * The shim's resolution order is:
 *
 *   1. monorepo workspace walk — preserves the current dev flow when
 *      `pdpp` is invoked from inside a checkout, which uses the
 *      filesystem-only `bin/collector-runner.ts` directly;
 *   2. resolved `@pdpp/local-collector` package (via
 *      `resolveLocalCollectorPackage`);
 *   3. fail-fast with a one-line install hint.
 *
 * This function only handles step 1; the higher-level `spawnCollectorRunner`
 * weaves the order together so behavior is deterministic across
 * monorepo + npm install postures.
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

/**
 * One-line install hint surfaced when neither the monorepo nor an
 * installed `@pdpp/local-collector` can be found.
 */
const RUNNER_MISSING_MESSAGE =
  'pdpp collector requires @pdpp/local-collector. Install once with ' +
  '"npm i -g @pdpp/local-collector@beta" or run "npx -y @pdpp/local-collector@beta ...". ' +
  'See openspec/changes/publish-pdpp-local-collector/design.md.';

const TSX_MISSING_MESSAGE =
  'Could not locate tsx alongside the collector runner. Install ' +
  '@pdpp/local-collector with "npm i -g @pdpp/local-collector@beta" or run ' +
  '"pnpm install" at the monorepo root.';

/**
 * Spawn the collector-runner subprocess. Inherits stdio so operators see
 * device tokens, run results, and diagnostics directly. Returns the exit
 * code, never throws on non-zero exits.
 *
 * Resolution order, locked in by `publish-pdpp-local-collector` design §1:
 *   1. monorepo `bin/collector-runner.ts` if walking up the FS finds one;
 *   2. published `@pdpp/local-collector` bin if installed;
 *   3. fail-fast `RUNNER_MISSING_MESSAGE`.
 */
export async function spawnCollectorRunner(
  subcommand,
  argv,
  {
    env = process.env,
    runnerScript = resolveCollectorRunnerScript(),
    localCollector = resolveLocalCollectorPackage(),
    tsxBinary = resolveTsxBinary(),
    spawnFn = spawn,
    stdio = 'inherit',
  } = {},
) {
  if (runnerScript) {
    if (!tsxBinary) {
      throw new CollectorUsageError(TSX_MISSING_MESSAGE);
    }
    return await runSubprocess(spawnFn, tsxBinary, [runnerScript, subcommand, ...argv], { env, stdio });
  }

  if (localCollector) {
    const binPath = resolveLocalCollectorBin(localCollector.packageDir);
    if (!existsSync(binPath)) {
      throw new CollectorUsageError(
        `@pdpp/local-collector is installed at ${localCollector.packageDir} but is missing its bin entrypoint. ` +
          'Reinstall the package or report this on https://github.com/vana-com/pdpp/issues.',
      );
    }
    if (binPath.endsWith('.ts')) {
      if (!tsxBinary) {
        throw new CollectorUsageError(TSX_MISSING_MESSAGE);
      }
      return await runSubprocess(spawnFn, tsxBinary, [binPath, subcommand, ...argv], { env, stdio });
    }
    return await runSubprocess(spawnFn, process.execPath, [binPath, subcommand, ...argv], { env, stdio });
  }

  throw new CollectorUsageError(RUNNER_MISSING_MESSAGE);
}

function resolveLocalCollectorBin(packageDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    const bin = manifest?.bin?.['pdpp-local-collector'];
    if (typeof bin === 'string' && bin.trim()) {
      return join(packageDir, bin);
    }
  } catch {}
  const publishedBin = join(packageDir, 'dist', 'local-collector', 'bin', 'pdpp-local-collector.js');
  if (existsSync(publishedBin)) return publishedBin;
  return join(packageDir, 'bin', 'pdpp-local-collector.ts');
}

function runSubprocess(spawnFn, binary, args, { env, stdio }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn(binary, args, { env, stdio });
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
