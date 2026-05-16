import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CollectorUsageError } from './errors.js';

/**
 * Locate the collector-runner TypeScript entrypoint in the monorepo.
 *
 * The runner currently ships with `@pdpp/polyfill-connectors` (a private
 * workspace package), not with `@pdpp/cli` itself, because publishing the
 * connector runtime would drag Playwright/Patchright, Chromium, and the
 * full connector source tree into the public CLI tarball. Distributing
 * a slim collector runner is an open contract — see the
 * "Distribution follow-up" section in
 * openspec/changes/introduce-local-collector-runner/design.md.
 *
 * When `pdpp` is invoked from a checkout of the monorepo we walk up to
 * the workspace root and resolve
 * `packages/polyfill-connectors/bin/collector-runner.ts`. From an npm
 * install (no workspace nearby) we throw an actionable error pointing
 * the operator at the monorepo flow.
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
  'The local collector runner is not distributed with @pdpp/cli yet — it lives\n' +
  'in the PDPP monorepo so the public CLI tarball stays small and free of\n' +
  'Playwright/Chromium. Distributing the runner is an explicit follow-up:\n' +
  'see "Distribution follow-up" in\n' +
  'openspec/changes/introduce-local-collector-runner/design.md.\n' +
  '\n' +
  'To run the collector against a remote PDPP reference deployment today\n' +
  '(e.g. https://peregrine-dev.vivid.fish) from a host that has ~/.claude or\n' +
  '~/.codex on disk:\n' +
  '  1. git clone https://github.com/vana-com/pdpp.git\n' +
  '  2. cd pdpp && pnpm install\n' +
  '  3. pnpm exec pdpp collector advertise\n' +
  '       # sanity-check: should list network, browser, filesystem, local_device\n' +
  '  4. pnpm exec pdpp collector enroll \\\n' +
  '       --base-url https://<your-reference-deployment> \\\n' +
  '       --code <one-time-code-from-dashboard>\n' +
  '       # capture device_id + device_token from the JSON output\n' +
  '  5. PDPP_REFERENCE_BASE_URL=https://<your-reference-deployment> \\\n' +
  '     PDPP_LOCAL_DEVICE_ID=<device_id> \\\n' +
  '     PDPP_LOCAL_DEVICE_TOKEN=<device_token> \\\n' +
  '     PDPP_SOURCE_INSTANCE_ID=<source_instance_id> \\\n' +
  '     pnpm exec pdpp collector run --connector claude_code\n' +
  '       # repeat with --connector codex for Codex data\n' +
  '\n' +
  'Run "pdpp collector --help" in the monorepo for the full operator flow.';

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
