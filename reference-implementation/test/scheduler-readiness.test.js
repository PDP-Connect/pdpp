// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultReadinessChecker } from '../runtime/scheduler-readiness.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

function scheduleWithTool(tool) {
  return {
    connectorId: 'readiness-test',
    manifest: {
      runtime_requirements: {
        external_tools: [tool],
      },
    },
  };
}

test('structured external-tool detector executes executable with explicit args', async () => {
  const readiness = await defaultReadinessChecker(
    scheduleWithTool({
      name: 'node',
      license: 'test-only',
      purpose: 'Prove structured external-tool detection',
      detect: { executable: process.execPath, args: ['-e', 'process.exit(0)'], exit_code: 0 },
    }),
  );

  assert.equal(readiness.ready, true);
});

test('external-tool detector does not interpret shell command strings', async () => {
  const readiness = await defaultReadinessChecker(
    scheduleWithTool({
      name: 'node-shell-string',
      license: 'test-only',
      purpose: 'Prove shell syntax is not interpreted',
      detect: { executable: `${process.execPath} -e "process.exit(0)"`, exit_code: 0 },
    }),
  );

  assert.equal(readiness.ready, false);
  assert.match(readiness.reason, /required external tool node-shell-string is not available/u);
});

test('scheduler readiness implementation does not request shell execution', () => {
  const source = readFileSync(join(__dirname, '..', 'runtime', 'scheduler-readiness.ts'), 'utf8');
  assert.doesNotMatch(source, /shell\s*:\s*true/u);
  assert.doesNotMatch(source, /spawn\s*\(\s*command/u);
});
