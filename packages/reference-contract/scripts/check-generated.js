#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const artifactFiles = [
  'reference-implementation/openapi/reference-public.openapi.json',
  'reference-implementation/openapi/reference-full.openapi.json',
  'reference-implementation/docs/generated/reference-routes.md',
  'reference-implementation/docs/generated/reference-ref-routes.md',
  'reference-implementation/docs/generated/query-cookbook.md',
];

for (const artifact of artifactFiles) {
  try {
    execFileSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', artifact], {
      stdio: 'ignore',
    });
  } catch {
    process.stderr.write(`Generated reference artifact is not tracked: ${artifact}\n`);
    process.stderr.write(
      'Run `pnpm reference-contract:generate` and `git add` the published artifacts before merging.\n',
    );
    process.exit(1);
  }
}

const diff = execFileSync(
  'git',
  ['-C', repoRoot, 'diff', '--name-status', '--', ...artifactFiles],
  { encoding: 'utf8' },
).trim();

if (diff) {
  process.stderr.write('Generated reference artifacts are out of sync with git state:\n');
  process.stderr.write(`${diff}\n`);
  process.stderr.write(
    'Run `pnpm reference-contract:generate` and refresh the published artifacts before merging.\n',
  );
  process.exit(1);
}

process.stdout.write('Generated reference artifacts are current.\n');
