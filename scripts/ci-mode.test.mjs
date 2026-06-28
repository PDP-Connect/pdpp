#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectCiMode,
  getRequiredStatusContexts,
  HOSTED_CONTEXT,
  LOCAL_CONTEXT,
  rulesetWithRequiredStatusContexts,
  workflowUpdatesForMode,
} from './ci-mode.mjs';

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
