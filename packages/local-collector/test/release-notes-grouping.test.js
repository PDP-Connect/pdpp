// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import createPreset from 'conventional-changelog-conventionalcommits';

// Task 6.3 — Conventional Commit scope grouping for the shared semantic-release
// stream. Both @pdpp/cli and @pdpp/local-collector publish from one version,
// so per-scope sections inside the shared release notes are the contract we
// guarantee. This test exercises the same `presetConfig.types` block that
// `.releaserc.yaml` feeds into `@semantic-release/release-notes-generator`,
// so any drift between the lockstep config in YAML and the contract this test
// asserts surfaces immediately. See openspec/changes/publish-pdpp-local-collector/design.md §5.

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function loadReleasercTypes() {
  const yaml = await readFile(new URL('.releaserc.yaml', `file://${repoRoot}`), 'utf8');
  // We avoid a YAML dep — extract the first commit-analyzer / release-notes
  // `types:` block in declaration order. Both plugin entries should hold the
  // same shape (the asserter checks that), so we parse the first one.
  const firstTypesBlockMatch = yaml.match(/presetConfig:\s*\n\s+types:\s*\n([\s\S]*?)(?=\n\s+- - "|\n\s+- "|\n[A-Za-z])/);
  if (!firstTypesBlockMatch) {
    throw new Error('.releaserc.yaml does not declare a presetConfig.types block');
  }
  const block = firstTypesBlockMatch[1];
  return parseTypesYaml(block);
}

function parseTypesYaml(block) {
  const entries = [];
  let current = null;
  for (const rawLine of block.split('\n')) {
    if (!rawLine.trim()) continue;
    const dashMatch = rawLine.match(/^\s+-\s+type:\s+(\S+)\s*$/);
    if (dashMatch) {
      if (current) entries.push(current);
      current = { type: dashMatch[1] };
      continue;
    }
    if (!current) continue;
    const kv = rawLine.match(/^\s+(\w+):\s*(?:"([^"]*)"|(\S.*))\s*$/);
    if (kv) {
      const [, key, quoted, bare] = kv;
      const value = quoted !== undefined ? quoted : bare === 'true' ? true : bare === 'false' ? false : bare;
      current[key] = value;
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function makeTransform() {
  const types = await loadReleasercTypes();
  const preset = createPreset({ types });
  return { transform: preset.writer.transform, types };
}

function commit({ type, scope, subject = 'something happened' }) {
  return {
    type,
    scope,
    subject,
    header: `${type}${scope ? `(${scope})` : ''}: ${subject}`,
    body: null,
    footer: null,
    notes: [],
    references: [],
    mentions: [],
    revert: null,
    merge: null,
    hash: 'a'.repeat(40),
  };
}

test('release notes config exists and lists both scoped and generic sections', async () => {
  const types = await loadReleasercTypes();
  const sections = types.filter((entry) => entry.scope || entry.type === 'feat' || entry.type === 'fix').map((entry) => entry.section);
  assert.ok(sections.includes('Features (@pdpp/local-collector)'), 'must declare a local-collector Features section');
  assert.ok(sections.includes('Features (@pdpp/cli)'), 'must declare a cli Features section');
  assert.ok(sections.includes('Features'), 'must keep a generic Features fallback section');
  assert.ok(sections.includes('Bug Fixes (@pdpp/local-collector)'), 'must declare a local-collector Bug Fixes section');
});

test('release notes config keeps both plugin entries in lockstep', async () => {
  const yaml = await readFile(new URL('.releaserc.yaml', `file://${repoRoot}`), 'utf8');
  const blocks = [...yaml.matchAll(/presetConfig:\s*\n\s+types:\s*\n([\s\S]*?)(?=\n\s+- - "|\n\s+- "|\n[A-Za-z])/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, 'commit-analyzer and release-notes-generator must both define presetConfig.types');
  const first = parseTypesYaml(blocks[0]);
  const second = parseTypesYaml(blocks[1]);
  assert.deepEqual(first, second, 'commit-analyzer and release-notes-generator presetConfig.types must match exactly');
});

test('feat(local-collector) routes to the local-collector section', async () => {
  const { transform } = await makeTransform();
  const transformed = transform(commit({ type: 'feat', scope: 'local-collector', subject: 'enroll smoke' }), { host: '', owner: '', repository: '' });
  assert.ok(transformed, 'commit should be retained');
  assert.equal(transformed.type, 'Features (@pdpp/local-collector)');
});

test('feat(cli) routes to the cli section', async () => {
  const { transform } = await makeTransform();
  const transformed = transform(commit({ type: 'feat', scope: 'cli', subject: 'help text' }), { host: '', owner: '', repository: '' });
  assert.ok(transformed);
  assert.equal(transformed.type, 'Features (@pdpp/cli)');
});

test('fix(local-collector) routes to the local-collector Bug Fixes section', async () => {
  const { transform } = await makeTransform();
  const transformed = transform(commit({ type: 'fix', scope: 'local-collector', subject: 'retry path' }), { host: '', owner: '', repository: '' });
  assert.ok(transformed);
  assert.equal(transformed.type, 'Bug Fixes (@pdpp/local-collector)');
});

test('feat with no scope falls back to the generic Features section', async () => {
  const { transform } = await makeTransform();
  const transformed = transform(commit({ type: 'feat', subject: 'generic change' }), { host: '', owner: '', repository: '' });
  assert.ok(transformed);
  assert.equal(transformed.type, 'Features');
});

test('feat with an unknown scope still falls back to the generic Features section', async () => {
  const { transform } = await makeTransform();
  const transformed = transform(commit({ type: 'feat', scope: 'web', subject: 'unrelated change' }), { host: '', owner: '', repository: '' });
  assert.ok(transformed, 'unrecognised scopes must not be dropped from release notes');
  assert.equal(transformed.type, 'Features');
});

test('chore is suppressed for both scoped and unscoped commits', async () => {
  const { transform } = await makeTransform();
  const generic = transform(commit({ type: 'chore', subject: 'bump dev dep' }), { host: '', owner: '', repository: '' });
  assert.equal(generic, undefined);
  const scoped = transform(commit({ type: 'chore', scope: 'local-collector', subject: 'tidy fixtures' }), { host: '', owner: '', repository: '' });
  assert.equal(scoped, undefined);
});
