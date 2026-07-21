#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CI_GATE_SELF_PATHS,
  changeTouchesCiGateSelf,
  changeTouchesConnectorSurface,
  ciModeSelfTestRequired,
  CONNECTOR_CONFORMANCE_TEST_FILES,
  connectorGateRequired,
  detectCiMode,
  getRequiredStatusContexts,
  HOSTED_CONTEXT,
  LOCAL_CONTEXT,
  rulesetWithRequiredStatusContexts,
  streamEvidenceInventoryGateRequired,
  STREAM_EVIDENCE_INVENTORY_PATHS,
  workflowUpdatesForMode,
} from './ci-mode.mjs';

const CI_MODE_SCRIPT = fileURLToPath(new URL('./ci-mode.mjs', import.meta.url));
const REPOSITORY_ROOT = dirname(dirname(CI_MODE_SCRIPT));

function fixtureRuleset() {
  return {
    bypass_actors: [],
    conditions: { ref_name: { exclude: [], include: ['refs/heads/main'] } },
    enforcement: 'active',
    id: 17916203,
    name: 'main: require PR + reference-implementation check',
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        parameters: {
          allowed_merge_methods: ['squash'],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
          required_reviewers: [],
        },
        type: 'pull_request',
      },
      {
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: HOSTED_CONTEXT }],
          strict_required_status_checks_policy: false,
        },
        type: 'required_status_checks',
      },
    ],
    target: 'branch',
  };
}

test('detectCiMode recognizes hosted and local modes', () => {
  assert.equal(detectCiMode([HOSTED_CONTEXT]), 'hosted');
  assert.equal(detectCiMode([LOCAL_CONTEXT]), 'local');
  assert.equal(detectCiMode(['other']), 'custom');
});

test('rulesetWithRequiredStatusContexts replaces only required status contexts', () => {
  const ruleset = fixtureRuleset();
  const next = rulesetWithRequiredStatusContexts(ruleset, [LOCAL_CONTEXT]);

  assert.deepEqual(getRequiredStatusContexts(next), [LOCAL_CONTEXT]);
  assert.deepEqual(next.conditions, ruleset.conditions);
  assert.equal(next.enforcement, ruleset.enforcement);
  assert.equal(next.name, ruleset.name);
  assert.equal(next.target, ruleset.target);
  assert.deepEqual(next.bypass_actors, []);
  assert.deepEqual(next.rules[0], ruleset.rules[0]);
  assert.deepEqual(next.rules[1], ruleset.rules[1]);
  assert.deepEqual(next.rules[2], ruleset.rules[2]);
  assert.equal(next.rules[3].parameters.do_not_enforce_on_create, false);
  assert.equal(next.rules[3].parameters.strict_required_status_checks_policy, false);
});

test('rulesetWithRequiredStatusContexts can add a required status rule if absent', () => {
  const ruleset = fixtureRuleset();
  const withoutStatusRule = {
    ...ruleset,
    rules: ruleset.rules.filter((rule) => rule.type !== 'required_status_checks'),
  };
  const next = rulesetWithRequiredStatusContexts(withoutStatusRule, [LOCAL_CONTEXT]);

  assert.deepEqual(getRequiredStatusContexts(next), [LOCAL_CONTEXT]);
  assert.equal(next.rules.length, withoutStatusRule.rules.length + 1);
});

test('workflowUpdatesForMode disables only active managed workflows in local mode', () => {
  const updates = workflowUpdatesForMode(
    [
      { id: 1, path: '.github/workflows/reference-implementation.yml', state: 'active' },
      { id: 2, path: '.github/workflows/spec-check.yml', state: 'disabled_manually' },
      { id: 3, path: '.github/workflows/other.yml', state: 'active' },
    ],
    'local',
    ['.github/workflows/reference-implementation.yml', '.github/workflows/spec-check.yml']
  );

  assert.deepEqual(
    updates.map((update) => ({
      action: update.action,
      missing: update.missing,
      needsChange: update.needsChange,
      path: update.path,
      state: update.state,
    })),
    [
      {
        action: 'disable',
        missing: false,
        needsChange: true,
        path: '.github/workflows/reference-implementation.yml',
        state: 'active',
      },
      {
        action: 'disable',
        missing: false,
        needsChange: false,
        path: '.github/workflows/spec-check.yml',
        state: 'disabled_manually',
      },
    ]
  );
});

test('workflowUpdatesForMode enables non-active managed workflows in hosted mode', () => {
  const updates = workflowUpdatesForMode(
    [
      { id: 1, path: '.github/workflows/reference-implementation.yml', state: 'disabled_manually' },
      { id: 2, path: '.github/workflows/spec-check.yml', state: 'active' },
    ],
    'hosted',
    ['.github/workflows/reference-implementation.yml', '.github/workflows/spec-check.yml']
  );

  assert.deepEqual(
    updates.map((update) => ({
      action: update.action,
      missing: update.missing,
      needsChange: update.needsChange,
      path: update.path,
      state: update.state,
    })),
    [
      {
        action: 'enable',
        missing: false,
        needsChange: true,
        path: '.github/workflows/reference-implementation.yml',
        state: 'disabled_manually',
      },
      {
        action: 'enable',
        missing: false,
        needsChange: false,
        path: '.github/workflows/spec-check.yml',
        state: 'active',
      },
    ]
  );
});

test('changeTouchesConnectorSurface flags bundled connector and reference-manifest paths', () => {
  assert.equal(changeTouchesConnectorSurface(['packages/polyfill-connectors/manifests/gmail.json']), true);
  assert.equal(changeTouchesConnectorSurface(['reference-implementation/manifests/github.json']), true);
  assert.equal(changeTouchesConnectorSurface(['reference-implementation/server/ref-control.ts']), false);
  assert.equal(changeTouchesConnectorSurface([]), false);
  assert.equal(
    changeTouchesConnectorSurface([
      'docs/reference/ci-mode.md',
      'packages/polyfill-connectors/src/connector-conformance-roster.ts',
    ]),
    true
  );
});

test('connectorGateRequired is required when the connector surface is touched', () => {
  assert.equal(connectorGateRequired(['packages/polyfill-connectors/connectors/gmail/index.ts']), true);
  assert.equal(connectorGateRequired(['reference-implementation/manifests/github.json']), true);
  assert.equal(connectorGateRequired(['CONTRIBUTING.md']), false);
  assert.equal(connectorGateRequired([]), false);
});

test('connectorGateRequired is ALSO required when only the gate itself changed (no connector-surface path)', () => {
  // CI_GATE_SELF_PATHS is distinct from CONNECTOR_SURFACE_PATH_PREFIXES — a
  // naive connector-surface-only check would miss a gate change. A change to
  // the gate must prove the conformance suite it runs still passes, not just
  // that ci:mode:test passes.
  assert.equal(connectorGateRequired(['scripts/ci-mode.mjs']), true);
  assert.equal(connectorGateRequired(['scripts/ci-mode.test.mjs']), true);
  assert.equal(connectorGateRequired(['package.json']), true);
});

test('changeTouchesCiGateSelf pins the gate implementation and every conformance test path', () => {
  const expectedSelfPaths = [
    'scripts/ci-mode.mjs',
    'scripts/ci-mode.test.mjs',
    'package.json',
    'packages/polyfill-connectors/src/stream-evidence-strategy-manifest.test.ts',
    'packages/polyfill-connectors/src/coverage-policy-manifest-honesty.test.ts',
    'packages/polyfill-connectors/src/connector-conformance.test.ts',
  ];
  assert.deepEqual(CI_GATE_SELF_PATHS, expectedSelfPaths);
  assert.deepEqual(
    CONNECTOR_CONFORMANCE_TEST_FILES,
    expectedSelfPaths.slice(3).map((path) => path.replace('packages/polyfill-connectors/', ''))
  );
  for (const path of expectedSelfPaths) {
    assert.equal(changeTouchesCiGateSelf([path]), true);
    assert.equal(ciModeSelfTestRequired([path]), true);
  }
  assert.equal(changeTouchesCiGateSelf(['scripts/other-script.mjs']), false);
  assert.equal(changeTouchesCiGateSelf(['packages/polyfill-connectors/package.json']), false);
  assert.equal(changeTouchesCiGateSelf([]), false);
});

test('ciModeSelfTestRequired does not over-trigger outside the pinned gate paths', () => {
  assert.equal(ciModeSelfTestRequired(['CONTRIBUTING.md']), false);
});

test('streamEvidenceInventoryGateRequired covers both shipped roots and only the inventory producer/artifact', () => {
  assert.deepEqual(STREAM_EVIDENCE_INVENTORY_PATHS, [
    'scripts/stream-evidence-inventory.mjs',
    'docs/reference/stream-evidence-inventory.md',
  ]);
  assert.equal(streamEvidenceInventoryGateRequired(['packages/polyfill-connectors/manifests/gmail.json']), true);
  assert.equal(streamEvidenceInventoryGateRequired(['reference-implementation/manifests/github.json']), true);
  for (const path of STREAM_EVIDENCE_INVENTORY_PATHS) {
    assert.equal(streamEvidenceInventoryGateRequired([path]), true);
  }
  assert.equal(streamEvidenceInventoryGateRequired(['reference-implementation/server/ref-control.ts']), false);
  assert.equal(streamEvidenceInventoryGateRequired([]), false);
});

/**
 * Build an isolated temp git repo containing only the files signoff's
 * pre-flight checks need (this script, so `main` can run; a real bare
 * "origin" remote so isCleanAndPushed's @{push} + --base origin/main both
 * resolve honestly instead of faking a ref). Never touches the real repo's
 * git state — no stash, no shared worktree risk.
 */
function copySignoffGateFixtureFiles(dir) {
  const copy = (from, to) => cpSync(join(REPOSITORY_ROOT, from), join(dir, to), { recursive: true });
  copy('packages/polyfill-connectors/src', 'packages/polyfill-connectors/src');
  copy('packages/polyfill-connectors/manifests', 'packages/polyfill-connectors/manifests');
  copy('packages/polyfill-connectors/connectors', 'packages/polyfill-connectors/connectors');
  copy('reference-implementation/manifests', 'reference-implementation/manifests');
  copy('scripts/stream-evidence-inventory.mjs', 'scripts/stream-evidence-inventory.mjs');
  copy('docs/reference/stream-evidence-inventory.md', 'docs/reference/stream-evidence-inventory.md');
  symlinkSync(join(REPOSITORY_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
}

function initSignoffFixtureRepo({ withSignoffGateFiles = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-mode-signoff-test-'));
  const bareDir = join(root, 'origin.git');
  const dir = join(root, 'work');
  execFileSync('git', ['init', '--bare', '--quiet', bareDir]);
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['clone', '--quiet', bareDir, dir], { stdio: ['ignore', 'ignore', 'ignore'] });
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'ci-mode test']);
  run(['checkout', '-b', 'main', '--quiet']);
  if (withSignoffGateFiles) {
    copySignoffGateFixtureFiles(dir);
    writeFileSync(join(dir, '.gitignore'), 'node_modules\nbin/\ngh-status-posted.txt\n');
  }
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  run(['add', '.']);
  run(['commit', '--quiet', '-m', 'initial']);
  run(['push', '--quiet', '-u', 'origin', 'main']);
  run(['checkout', '-b', 'feature', '--quiet']);
  run(['push', '--quiet', '-u', 'origin', 'feature']);
  return { dir, root, run };
}

function cleanupSignoffFixtureRepo({ root }) {
  rmSync(root, { recursive: true, force: true });
}

function runSignoffCli(dir, args, options = {}) {
  return execFileSync('node', [CI_MODE_SCRIPT, 'signoff', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env,
  });
}

function createFakeGh(dir) {
  const binDir = join(dir, 'bin');
  const marker = join(dir, 'gh-status-posted.txt');
  const command = join(binDir, 'gh');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    command,
    `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));\n`
  );
  chmodSync(command, 0o755);
  return {
    marker,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  };
}

test('signoff CLI rejects a dirty worktree before any gh call', () => {
  const fixture = initSignoffFixtureRepo();
  try {
    writeFileSync(join(fixture.dir, 'README.md'), 'dirty\n');
    assert.throws(() => runSignoffCli(fixture.dir, []), /uncommitted or unpushed changes/);
  } finally {
    cleanupSignoffFixtureRepo(fixture);
  }
});

test('signoff CLI rejects --sha that does not match HEAD', () => {
  const fixture = initSignoffFixtureRepo();
  try {
    const firstSha = fixture.run(['rev-parse', 'HEAD']).trim();
    writeFileSync(join(fixture.dir, 'other.txt'), 'x\n');
    fixture.run(['add', 'other.txt']);
    fixture.run(['commit', '--quiet', '-m', 'second']);
    fixture.run(['push', '--quiet']);
    assert.throws(() => runSignoffCli(fixture.dir, ['--sha', firstSha]), /does not match HEAD/);
  } finally {
    cleanupSignoffFixtureRepo(fixture);
  }
});

test('signoff CLI fails closed when --base cannot be resolved', () => {
  const fixture = initSignoffFixtureRepo();
  try {
    assert.throws(() => runSignoffCli(fixture.dir, ['--base', 'origin/does-not-exist']));
  } finally {
    cleanupSignoffFixtureRepo(fixture);
  }
});

test('signoff cannot post success for a reference-only required flip while the generated inventory is stale', () => {
  const fixture = initSignoffFixtureRepo({ withSignoffGateFiles: true });
  try {
    const manifestPath = join(fixture.dir, 'reference-implementation/manifests/github.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.streams[0].required = false;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fixture.run(['add', 'reference-implementation/manifests/github.json']);
    fixture.run(['commit', '--quiet', '-m', 'flip reference requiredness']);
    fixture.run(['push', '--quiet']);

    const fakeGh = createFakeGh(fixture.dir);
    let error;
    try {
      runSignoffCli(fixture.dir, [], { env: fakeGh.env });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, 'stale inventory must make signoff fail');
    assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, /stream-evidence inventory: FAIL/);
    assert.equal(existsSync(fakeGh.marker), false, 'inventory failure must prevent the gh status post');
  } finally {
    cleanupSignoffFixtureRepo(fixture);
  }
});

test('signoff cannot post success when a manifest moves out of either protected root and leaves inventory stale', () => {
  const moves = [
    {
      source: 'packages/polyfill-connectors/manifests/github.json',
      destination: 'archive/polyfill-github.json',
    },
    {
      source: 'reference-implementation/manifests/github.json',
      destination: 'archive/reference-github.json',
    },
  ];

  for (const { source, destination } of moves) {
    const fixture = initSignoffFixtureRepo({ withSignoffGateFiles: true });
    try {
      mkdirSync(dirname(join(fixture.dir, destination)), { recursive: true });
      fixture.run(['mv', source, destination]);
      fixture.run(['commit', '--quiet', '-m', `move ${source} out of protected root`]);
      fixture.run(['push', '--quiet']);

      const fakeGh = createFakeGh(fixture.dir);
      let error;
      try {
        runSignoffCli(fixture.dir, [], { env: fakeGh.env });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error, `${source} rename-out must make signoff fail`);
      assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, /stream-evidence inventory: FAIL/);
      assert.equal(existsSync(fakeGh.marker), false, `${source} rename-out must prevent the gh status post`);
    } finally {
      cleanupSignoffFixtureRepo(fixture);
    }
  }
});

test('signoff recognizes Unicode and embedded-newline paths under both protected manifest roots', () => {
  const fixture = initSignoffFixtureRepo({ withSignoffGateFiles: true });
  try {
    const protectedPaths = [
      'packages/polyfill-connectors/manifests/évidence.txt',
      'packages/polyfill-connectors/manifests/embedded\nnewline.txt',
      'reference-implementation/manifests/évidence.txt',
      'reference-implementation/manifests/embedded\nnewline.txt',
    ];
    for (const path of protectedPaths) {
      writeFileSync(join(fixture.dir, path), 'fixture\n');
    }
    fixture.run(['add', '.']);
    fixture.run(['commit', '--quiet', '-m', 'exercise unusual manifest paths']);
    fixture.run(['push', '--quiet']);

    const fakeGh = createFakeGh(fixture.dir);
    const output = runSignoffCli(fixture.dir, [], { env: fakeGh.env });
    assert.match(output, /shipped manifest root or this gate changed — running the connector-conformance gate/);
    assert.match(output, /shipped manifest root or stream-evidence inventory input changed — running the inventory check/);
    assert.equal(existsSync(fakeGh.marker), true, 'fake gh proves the protected paths reached the signoff gate');
  } finally {
    cleanupSignoffFixtureRepo(fixture);
  }
});

test('workflowUpdatesForMode reports missing managed workflows', () => {
  const updates = workflowUpdatesForMode([], 'local', ['.github/workflows/reference-implementation.yml']);

  assert.deepEqual(
    updates.map((update) => ({
      action: update.action,
      missing: update.missing,
      needsChange: update.needsChange,
      path: update.path,
      state: update.state,
    })),
    [
      {
        action: 'disable',
        missing: true,
        needsChange: false,
        path: '.github/workflows/reference-implementation.yml',
        state: 'missing',
      },
    ]
  );
});
