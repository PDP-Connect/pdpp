#!/usr/bin/env node
// Guards for the PDPP package-release-policy checks.
//
// Covers the two pieces of logic that protect operators from the placeholder
// `latest` release posture while the packages are beta-only:
//
//   - findUntaggedInstallDocReferences (hermetic doc-tag guard, part of
//     `release:policy-check`): active install docs must pin `@beta`.
//   - classifyDistTagPosture (network-aware, part of `release:dist-tag-check`):
//     a published `latest` of 0.0.0 is a hazard.
//
// It also asserts the live repository currently passes the hermetic policy
// check, so the checked-in manifests/docs cannot silently regress.

import assert from 'node:assert/strict';
import test from 'node:test';

import { findUntaggedInstallDocReferences, policyErrors } from './check-package-release-policy.mjs';
import { classifyDistTagPosture, placeholderVersion } from './check-dist-tag-posture.mjs';

const PUBLISHABLE = ['@pdpp/cli', '@pdpp/local-collector'];

function scanLine(line) {
  return findUntaggedInstallDocReferences({
    packageNames: PUBLISHABLE,
    docFiles: ['doc.md'],
    readFile: () => line,
  });
}

test('doc-tag guard flags a bare global install of a publishable package', () => {
  assert.equal(scanLine('npm i -g @pdpp/cli').length, 1);
  assert.equal(scanLine('npm install -g @pdpp/local-collector').length, 1);
  assert.equal(scanLine('npx @pdpp/local-collector advertise').length, 1);
});

test('doc-tag guard accepts an explicit @beta tag or a pinned version', () => {
  assert.equal(scanLine('npm i -g @pdpp/cli@beta').length, 0);
  assert.equal(scanLine('npx -y @pdpp/cli@beta --help').length, 0);
  assert.equal(scanLine('npx -y @pdpp/local-collector@0.1.0-beta.7 run').length, 0);
});

test('doc-tag guard ignores shell comments and Markdown headings', () => {
  assert.equal(scanLine('# @pdpp/cli package, npx-launched pdpp binary').length, 0);
  assert.equal(scanLine('## Install @pdpp/cli').length, 0);
  assert.equal(scanLine('  # npx @pdpp/local-collector advertise (example)').length, 0);
});

test('doc-tag guard ignores prose mentions that are not install commands', () => {
  assert.equal(scanLine('The @pdpp/cli package is published to npm.').length, 0);
  assert.equal(scanLine('See @pdpp/local-collector for the runner.').length, 0);
});

test('doc-tag guard does not false-match a longer package name with the same prefix', () => {
  assert.equal(scanLine('npm i -g @pdpp/cli-extras').length, 0);
  assert.equal(scanLine('npm i -g @pdpp/local-collector-internal').length, 0);
});

test('doc-tag guard reports the offending file and line in its message', () => {
  const problems = findUntaggedInstallDocReferences({
    packageNames: PUBLISHABLE,
    docFiles: ['docs/local-collector.md'],
    readFile: () => 'npm i -g @pdpp/cli',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/local-collector\.md/);
  assert.match(problems[0], /@beta/);
});

test('dist-tag classifier treats placeholder latest as a hazard', () => {
  const result = classifyDistTagPosture('@pdpp/cli', { latest: placeholderVersion, beta: '0.1.0-beta.7' });
  assert.equal(result.status, 'hazard');
  assert.match(result.detail, /placeholder/);
});

test('dist-tag classifier treats a real latest as ok', () => {
  assert.equal(classifyDistTagPosture('@pdpp/cli', { latest: '1.2.3' }).status, 'ok');
  assert.equal(classifyDistTagPosture('@pdpp/cli', { latest: '1.2.3', beta: '1.3.0-beta.1' }).status, 'ok');
});

test('dist-tag classifier treats a missing latest with a published beta as a hazard', () => {
  assert.equal(classifyDistTagPosture('@pdpp/cli', { beta: '0.1.0-beta.7' }).status, 'hazard');
});

test('dist-tag classifier skips unpublished packages and unreachable registry', () => {
  assert.equal(classifyDistTagPosture('@pdpp/cli', null).status, 'skip');
  assert.equal(classifyDistTagPosture('@pdpp/cli', {}).status, 'skip');
});

test('the live repository passes the hermetic package-release policy check', () => {
  assert.deepEqual(policyErrors, []);
});
