// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { gitRoot, MANIFEST_SCHEMA, planFor, readManifest, RUN_AUTHORITY_SCHEMA, trackedFiles } from './inventory.mjs';
import { accountingResultLine, structuredNodeSummary, structuredPythonSummary } from './receipt.mjs';
import { commandsFor } from './runner.mjs';

function fail(message) { throw new Error(`test accounting executor: ${message}`); }
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!['--suite', '--authority'].includes(flag) || !value || value.startsWith('--') || result[flag]) fail('use exactly --suite ID --authority ISSUED-RUN');
    result[flag] = value; index += 1;
  }
  if (!result['--suite'] || !result['--authority']) fail('use exactly --suite ID --authority ISSUED-RUN');
  return result;
}
function issuedAuthority(path) {
  let target;
  try { target = realpathSync(path); } catch { fail('issued authority is missing'); }
  const value = JSON.parse(readFileSync(target, 'utf8'));
  if (value.schema !== RUN_AUTHORITY_SCHEMA) fail('issued authority has the wrong schema');
  if (new Date(value.expires_at) < new Date()) fail('issued authority has expired');
  return value;
}
function run(command, root) {
  const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env } });
  if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const input = parseArgs(process.argv.slice(2));
const root = gitRoot(); const manifest = await readManifest(`${root}/test-accounting.manifest.json`, { root });
if (manifest.schema !== MANIFEST_SCHEMA) fail('manifest schema changed while executing');
const suite = manifest.suites.find((entry) => entry.id === input['--suite']); if (!suite) fail(`unknown suite ${input['--suite']}`);
const issued = issuedAuthority(input['--authority']);
if (issued.suite !== suite.id || issued.cwd !== suite.cwd || JSON.stringify(issued.argv) !== JSON.stringify(suite.command)) fail('issued authority does not bind this child runner');
if (issued.profile !== process.env.PDPP_TEST_PROFILE) fail('selected profile does not match issued authority');
const files = planFor(manifest, trackedFiles(root)).plans.get(suite.id);
if (JSON.stringify(files) !== JSON.stringify(issued.files)) fail('runner discovery differs from authority-issued selection');
const reporter = resolve(root, 'scripts/test-accounting/node-reporter.mjs');
const commands = commandsFor(suite.loader, files, reporter);
let output = ''; let status = 0;
for (const command of commands) {
  const observed = run(command, root); output += observed.output;
  if (observed.status !== 0) { status = observed.status; break; }
}
let counts;
if (suite.loader === 'node-test') counts = structuredNodeSummary(output);
else if (suite.loader === 'python-unittest') counts = structuredPythonSummary(output, status);
else {
  const assertions = files.length;
  counts = { assertions, passed: status === 0 ? assertions : 0, failed: status === 0 ? 0 : 1, skipped: 0, skip_reasons: {} };
}
counts.planned_files = files.length; counts.completed_files = status === 0 ? files.length : 0;
process.stdout.write(`${accountingResultLine({ run_id: issued.run_id, nonce: issued.nonce, suite: suite.id, profile: issued.profile, files, counts })}\n`);
process.exitCode = status;
