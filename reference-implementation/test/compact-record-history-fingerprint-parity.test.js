/**
 * Parity test: compact-record-history.mjs:recordFingerprint
 * vs packages/polyfill-connectors/src/fingerprint-cursor.ts:recordFingerprint
 *
 * This script reimplements the canonical fingerprint shape locally
 * because it is a `.mjs` operational tool and importing the canonical
 * helper from `@pdpp/polyfill-connectors` would couple the tool to
 * either a TS build artifact or a runtime TS shim. The substitute for
 * that coupling is this test: drift between the two implementations
 * fails it loudly.
 *
 * Coverage:
 *   - Each of the five registered policies' representative payload
 *     shapes (workspace with `fetched_at` exclude, users, files,
 *     threads, payee_locations) hashes byte-identically under both
 *     implementations.
 *   - Adversarial payloads — nested objects, mixed key order, nested
 *     arrays of objects, `null` leaves, arrays of strings — also hash
 *     byte-identically.
 *
 * Run with:
 *   node --test --import tsx \
 *     reference-implementation/test/compact-record-history-fingerprint-parity.test.js
 *
 * This test is gated on tsx being available; without `--import tsx`
 * Node cannot resolve the canonical helper's `.ts` extension and the
 * test is skipped. The dependency-free pure-helper tests in
 * `compact-record-history.test.js` cover the script in isolation; this
 * test exists solely to lock the script's fingerprint shape against the
 * connector helper.
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_POLICIES,
  findPolicy,
  recordFingerprint as scriptRecordFingerprint,
} from '../scripts/compact-record-history.mjs';

let canonicalRecordFingerprint;
try {
  // Loaded via tsx — the canonical helper lives in TypeScript.
  const mod = await import(
    '../../packages/polyfill-connectors/src/fingerprint-cursor.ts'
  );
  canonicalRecordFingerprint = mod.recordFingerprint;
} catch (err) {
  // Without tsx the .ts extension cannot be resolved by Node directly.
  // We skip the suite rather than fail because the pure-helper tests in
  // compact-record-history.test.js still exercise this implementation
  // independently.
  test('compact-record-history fingerprint parity (skipped: tsx unavailable)', { skip: true }, () => {
    void err;
  });
}

function expectParity(payload, excludeKeys, label) {
  const a = scriptRecordFingerprint(payload, excludeKeys);
  const b = canonicalRecordFingerprint(payload, excludeKeys);
  assert.equal(
    a,
    b,
    `${label}: script ${a} != canonical ${b} — implementations drifted`,
  );
}

if (canonicalRecordFingerprint) {
  test('parity: gmail threads representative payload', () => {
    const policy = findPolicy('gmail', 'threads');
    expectParity(
      {
        id: 't_abc',
        snippet: 'hello world',
        message_count: 3,
        last_message_at: '2026-05-26T10:00:00Z',
        participants: ['alice@example.com', 'bob@example.com'],
        labels: ['INBOX', 'IMPORTANT'],
      },
      policy.excludeKeys,
      'gmail/threads',
    );
  });

  test('parity: slack workspace excludes fetched_at', () => {
    const policy = findPolicy('slack', 'workspace');
    const base = {
      id: 'T123',
      name: 'My Workspace',
      domain: 'my-ws',
      url: 'https://my-ws.slack.com/',
    };
    expectParity(
      { ...base, fetched_at: '2026-05-26T10:00:00Z' },
      policy.excludeKeys,
      'slack/workspace ts=10:00',
    );
    expectParity(
      { ...base, fetched_at: '2026-05-26T11:00:00Z' },
      policy.excludeKeys,
      'slack/workspace ts=11:00',
    );
    // And that the script and canonical helper both treat the
    // fetched_at-only delta as equal:
    const h1 = scriptRecordFingerprint(
      { ...base, fetched_at: '2026-05-26T10:00:00Z' },
      policy.excludeKeys,
    );
    const h2 = scriptRecordFingerprint(
      { ...base, fetched_at: '2026-05-26T11:00:00Z' },
      policy.excludeKeys,
    );
    assert.equal(h1, h2, 'fetched_at delta must not change the fingerprint');
  });

  test('parity: slack users representative payload', () => {
    const policy = findPolicy('slack', 'users');
    expectParity(
      {
        id: 'U999',
        name: 'asmith',
        real_name: 'Alice Smith',
        is_admin: false,
        profile: {
          email: 'alice@example.com',
          display_name: 'Alice',
          status_text: '',
        },
      },
      policy.excludeKeys,
      'slack/users',
    );
  });

  test('parity: slack files representative payload', () => {
    const policy = findPolicy('slack', 'files');
    expectParity(
      {
        id: 'F555',
        name: 'design.png',
        size: 12345,
        mimetype: 'image/png',
        channels: ['C1', 'C2'],
        thumb_url: 'https://files.slack.com/t/x',
      },
      policy.excludeKeys,
      'slack/files',
    );
  });

  test('parity: ynab payee_locations representative payload', () => {
    const policy = findPolicy('ynab', 'payee_locations');
    expectParity(
      {
        id: 'pl_abc',
        payee_id: 'p_xyz',
        latitude: '40.7',
        longitude: '-74.0',
      },
      policy.excludeKeys,
      'ynab/payee_locations',
    );
  });

  test('parity: nested objects with mixed key order', () => {
    const a = {
      id: 'x',
      meta: { z: 1, a: 2, m: { q: 'q', a: 'a' } },
      tags: ['b', 'a', 'c'],
    };
    const b = {
      tags: ['b', 'a', 'c'],
      meta: { a: 2, m: { a: 'a', q: 'q' }, z: 1 },
      id: 'x',
    };
    const hScript = scriptRecordFingerprint(a);
    const hCanonical = canonicalRecordFingerprint(a);
    assert.equal(hScript, hCanonical, 'top-level: nested objects');
    assert.equal(
      scriptRecordFingerprint(b),
      canonicalRecordFingerprint(b),
      'reordered: nested objects',
    );
    assert.equal(
      scriptRecordFingerprint(a),
      scriptRecordFingerprint(b),
      'script: stable across key order',
    );
  });

  test('parity: arrays of objects do not get re-sorted', () => {
    // Arrays preserve order; only object keys sort.
    const a = { id: 'x', items: [{ k: 1 }, { k: 2 }, { k: 3 }] };
    const b = { id: 'x', items: [{ k: 3 }, { k: 2 }, { k: 1 }] };
    assert.notEqual(
      scriptRecordFingerprint(a),
      scriptRecordFingerprint(b),
      'array order must matter',
    );
    assert.equal(
      scriptRecordFingerprint(a),
      canonicalRecordFingerprint(a),
      'parity on ordered arrays a',
    );
    assert.equal(
      scriptRecordFingerprint(b),
      canonicalRecordFingerprint(b),
      'parity on ordered arrays b',
    );
  });

  test('parity: null leaves and primitive values', () => {
    const payload = {
      id: 'x',
      a: null,
      b: 0,
      c: '',
      d: false,
      e: [null, 0, '', false],
      f: { g: null },
    };
    expectParity(payload, [], 'null+primitive leaves');
  });

  test('parity: exclude keys with no overlap is a no-op', () => {
    const payload = { id: 'x', name: 'n' };
    expectParity(payload, ['not_present'], 'noop exclude');
  });

  test('parity: codex local-device record shapes (messages, function_calls, sessions, mtime-stamped artifacts)', () => {
    // Codex records are derived from on-disk JSONL/sqlite. Exact-JSON
    // identity is the policy; verify the script and canonical helper
    // agree byte-for-byte across the representative shapes.
    expectParity(
      {
        id: 'session_abc:42',
        session_id: 'session_abc',
        role: 'assistant',
        type: 'message',
        content: 'hello',
        timestamp: '2026-05-26T10:00:00.000Z',
      },
      [],
      'codex/messages',
    );
    expectParity(
      {
        id: 'session_abc:43:output',
        session_id: 'session_abc',
        call_id: 'call_xyz',
        name: 'shell',
        arguments: '{"cmd":"ls"}',
        output_preview: 'a\nb\n',
        output_binary_reason: null,
        timestamp: '2026-05-26T10:00:01.000Z',
      },
      [],
      'codex/function_calls',
    );
    expectParity(
      {
        id: 'thread_xyz',
        cwd: '/home/user/proj',
        originator: 'codex_cli_rs',
        cli_version: '0.42.0',
        model_provider: 'openai',
        git_commit: 'abcdef0',
        git_branch: 'main',
        repository_url: null,
        started_at: '2026-05-20T00:00:00.000Z',
        last_event_at: '2026-05-26T10:00:01.000Z',
        message_count: 17,
        function_call_count: 5,
        title: 'pinned title',
        archived: false,
        tokens_used: 1234,
        first_user_message: 'hello',
        sandbox_policy: 'workspace-write',
        approval_mode: 'auto',
        rollout_path: '/home/user/.codex/sessions/2026/05/26/rollout-x.jsonl',
      },
      [],
      'codex/sessions',
    );
    expectParity(
      {
        id: 'skills:my-skill',
        name: 'my-skill',
        description: 'does the thing',
        content: '# my-skill\n…',
        path: '/home/user/.codex/skills/my-skill/SKILL.md',
        mtime_epoch: 1716700000,
      },
      [],
      'codex/skills',
    );
    expectParity(
      {
        id: 'prompts:hello.md',
        name: 'hello',
        description: null,
        content: 'Say hi.',
        path: '/home/user/.codex/prompts/hello.md',
        mtime_epoch: 1716700000,
      },
      [],
      'codex/prompts',
    );
    expectParity(
      {
        id: 'rules:foo:0',
        ruleset: 'foo',
        rule_text: 'this is the rule',
        rule_index: 0,
        path: '/home/user/.codex/rules/foo.rules',
        mtime_epoch: 1716700000,
      },
      [],
      'codex/rules',
    );
  });

  test('parity: claude_code local-device record shapes (messages, attachments, sessions, mtime-stamped artifacts)', () => {
    expectParity(
      {
        id: 'uuid-1',
        session_id: 'session-1',
        parent_uuid: null,
        role: 'user',
        type: 'user',
        content: 'hello',
        timestamp: '2026-05-26T10:00:00.000Z',
        is_sidechain: false,
        user_type: 'human',
        agent_id: null,
      },
      [],
      'claude_code/messages',
    );
    expectParity(
      {
        id: 'tool_result_file:proj/session-1/foo.txt',
        session_id: 'session-1',
        parent_uuid: null,
        event_type: 'tool_result_file',
        hook_name: null,
        tool_use_id: null,
        content_preview: 'abc',
        content_binary_reason: null,
        content_bytes: 3,
        timestamp: '2026-05-26T10:00:01.000Z',
      },
      [],
      'claude_code/attachments',
    );
    expectParity(
      {
        id: 'session-1',
        project_path: 'proj',
        cwd: '/home/user/proj',
        git_branch: 'main',
        version: '0.42.0',
        started_at: '2026-05-20T00:00:00.000Z',
        last_event_at: '2026-05-26T10:00:01.000Z',
        message_count: 17,
        user_type: 'human',
        entrypoint: 'cli',
      },
      [],
      'claude_code/sessions',
    );
    expectParity(
      {
        id: 'skills:my-skill',
        name: 'my-skill',
        description: 'does the thing',
        source: 'user',
        path: '/home/user/.claude/skills/my-skill/SKILL.md',
        content: '# my-skill\n…',
        frontmatter: { name: 'my-skill', description: 'does the thing' },
        mtime_epoch: 1716700000,
      },
      [],
      'claude_code/skills',
    );
    expectParity(
      {
        id: 'memory_notes:proj/foo.md',
        project_path: 'proj',
        note_path: 'foo.md',
        name: 'foo',
        description: null,
        path: '/home/user/.claude/projects/proj/memory/foo.md',
        content: 'note body',
        frontmatter: {},
        mtime_epoch: 1716700000,
      },
      [],
      'claude_code/memory_notes',
    );
    expectParity(
      {
        id: 'commands:foo',
        name: 'foo',
        description: null,
        path: '/home/user/.claude/commands/foo.md',
        content: 'do foo',
        frontmatter: {},
        mtime_epoch: 1716700000,
      },
      [],
      'claude_code/slash_commands',
    );
  });

  test('every registered policy has a parity-checked fixture above', () => {
    // Static guard: if a new policy is added without a parity fixture,
    // this assertion fails and points at the gap.
    const fixturedPairs = new Set([
      // connector-fingerprint family
      'gmail/threads',
      'slack/workspace',
      'slack/users',
      'slack/files',
      'ynab/payee_locations',
      // exact stable-JSON identity family (codex)
      'codex/messages',
      'codex/function_calls',
      'codex/sessions',
      'codex/skills',
      'codex/prompts',
      'codex/rules',
      // exact stable-JSON identity family (claude_code)
      'claude_code/messages',
      'claude_code/attachments',
      'claude_code/sessions',
      'claude_code/skills',
      'claude_code/memory_notes',
      'claude_code/slash_commands',
    ]);
    for (const p of COMPACTION_POLICIES) {
      const pair = `${p.connectorIds[0]}/${p.stream}`;
      assert.ok(
        fixturedPairs.has(pair),
        `policy ${pair} has no parity fixture in this test`,
      );
    }
  });
}
