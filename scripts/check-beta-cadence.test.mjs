#!/usr/bin/env node
// Guards for the beta release-cadence check (scripts/check-beta-cadence.mjs).
//
// The cadence guard detects publishable commits stranded on `main` behind the
// `beta` publish lane. These tests pin the pure decision logic and the
// path-derivation, and inject a fake `git` runner so nothing shells out — the
// suite is fully hermetic and carries no date/current-version assertions.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyBetaCadence,
  collectLagCommits,
  defaultRunGit,
  resolvePublishablePaths,
  PUBLISH_BRANCH,
  TRUNK_BRANCH,
} from './check-beta-cadence.mjs';

test('classifier reports ok when no publishable change is stranded', () => {
  const result = classifyBetaCadence({ lagCommits: [] });
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 0);
});

test('classifier reports lag when publishable commits sit on main but not beta', () => {
  const result = classifyBetaCadence({
    lagCommits: ['abc123 fix(local-collector): stop steering hosts onto a stale @beta', 'def456 feat(cli): add onboarding'],
  });
  assert.equal(result.status, 'lag');
  assert.equal(result.count, 2);
  assert.match(result.detail, /stale/);
  assert.match(result.detail, new RegExp(PUBLISH_BRANCH));
  assert.match(result.detail, new RegExp(TRUNK_BRANCH));
});

test('classifier skips when the refs were unavailable (null lagCommits)', () => {
  const result = classifyBetaCadence({ lagCommits: null });
  assert.equal(result.status, 'skip');
  assert.equal(result.count, 0);
  assert.match(result.detail, /unavailable/);
});

test('publishable paths derive from .releaserc pkgRoots plus the release config and workflow', () => {
  const releaseConfig = [
    '  - - "@semantic-release/npm"',
    '    - pkgRoot: "packages/cli"',
    '  - - "@semantic-release/npm"',
    '    - pkgRoot: "packages/local-collector"',
  ].join('\n');
  const paths = resolvePublishablePaths(releaseConfig);
  assert.deepEqual(paths, [
    '.github/workflows/semantic-release.yml',
    '.releaserc.yaml',
    'packages/cli',
    'packages/local-collector',
  ]);
});

test('publishable paths stay unique and sorted even with no pkgRoots parsed', () => {
  const paths = resolvePublishablePaths('# no plugins here');
  assert.deepEqual(paths, ['.github/workflows/semantic-release.yml', '.releaserc.yaml']);
});

// --- collectLagCommits with an injected git runner (no real repo touched) ---

function fakeGit(responses) {
  // responses: map of joined-args -> stdout string (or null for "git failed").
  return (args) => {
    const key = args.join(' ');
    for (const [match, value] of Object.entries(responses)) {
      if (key.includes(match)) {
        return value;
      }
    }
    return null;
  };
}

test('collectLagCommits returns null (skip) when the beta ref is missing', () => {
  const runGit = fakeGit({
    [`refs/remotes/origin/${TRUNK_BRANCH}`]: 'trunksha\n',
    // no beta ref response → resolveRef returns null for beta
  });
  assert.equal(collectLagCommits(runGit, ['packages/cli']), null);
});

test('collectLagCommits returns null (skip) when the trunk ref is missing', () => {
  const runGit = fakeGit({
    [`refs/remotes/origin/${PUBLISH_BRANCH}`]: 'betasha\n',
  });
  assert.equal(collectLagCommits(runGit, ['packages/cli']), null);
});

test('collectLagCommits parses commit subjects when both refs resolve', () => {
  const runGit = fakeGit({
    [`refs/remotes/origin/${PUBLISH_BRANCH}`]: 'betasha\n',
    [`refs/remotes/origin/${TRUNK_BRANCH}`]: 'trunksha\n',
    'log': 'abc123 fix(local-collector): real fix\ndef456 feat(cli): another\n',
  });
  assert.deepEqual(collectLagCommits(runGit, ['packages/cli', 'packages/local-collector']), [
    'abc123 fix(local-collector): real fix',
    'def456 feat(cli): another',
  ]);
});

test('collectLagCommits yields an empty list (ok) when the log range is empty', () => {
  const runGit = fakeGit({
    [`refs/remotes/origin/${PUBLISH_BRANCH}`]: 'betasha\n',
    [`refs/remotes/origin/${TRUNK_BRANCH}`]: 'trunksha\n',
    'log': '\n',
  });
  assert.deepEqual(collectLagCommits(runGit, ['packages/cli']), []);
});

test('collectLagCommits falls back to the local branch ref when no remote-tracking ref exists', () => {
  const runGit = fakeGit({
    [`refs/heads/${PUBLISH_BRANCH}`]: 'betasha\n',
    [`refs/heads/${TRUNK_BRANCH}`]: 'trunksha\n',
    'log': 'abc123 feat(local-collector): only on trunk\n',
  });
  assert.deepEqual(collectLagCommits(runGit, ['packages/local-collector']), [
    'abc123 feat(local-collector): only on trunk',
  ]);
});

test('the live repository classifies without throwing (skip|ok|lag, never an error)', () => {
  // Exercises the real git runner against this checkout. We assert only that it
  // produces a well-formed verdict — never a specific count, so the test does
  // not go red the moment `beta` is advanced or `main` grows.
  const lagCommits = collectLagCommits(defaultRunGit, resolvePublishablePaths());
  assert.ok(lagCommits === null || Array.isArray(lagCommits));
  const result = classifyBetaCadence({ lagCommits });
  assert.ok(['ok', 'lag', 'skip'].includes(result.status));
  assert.equal(typeof result.detail, 'string');
  // count and the array length must agree when refs resolved.
  if (Array.isArray(lagCommits)) {
    assert.equal(result.count, lagCommits.length);
  }
});
