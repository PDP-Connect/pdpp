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

  test('parity: ynab budgets representative payload excludes last_month/last_modified_on', () => {
    const policy = findPolicy('ynab', 'budgets');
    const base = {
      id: 'b_1',
      name: 'My Budget',
      first_month: '2024-01-01',
      currency_iso_code: 'USD',
      currency_symbol: '$',
      currency_symbol_first: true,
      currency_decimal_digits: 2,
      currency_decimal_separator: '.',
      currency_group_separator: ',',
      date_format_string: 'MM/DD/YYYY',
      deleted: false,
    };
    expectParity(
      { ...base, last_month: '2026-01-01', last_modified_on: '2026-01-15T00:00:00Z' },
      policy.excludeKeys,
      'ynab/budgets month=01',
    );
    expectParity(
      { ...base, last_month: '2026-05-01', last_modified_on: '2026-05-30T00:00:00Z' },
      policy.excludeKeys,
      'ynab/budgets month=05',
    );
    // The two calendar/clock fields must not change the fingerprint — this is
    // the connector's own no-op definition (BUDGET_FINGERPRINT_EXCLUDE).
    const h1 = scriptRecordFingerprint(
      { ...base, last_month: '2026-01-01', last_modified_on: '2026-01-15T00:00:00Z' },
      policy.excludeKeys,
    );
    const h2 = scriptRecordFingerprint(
      { ...base, last_month: '2026-05-01', last_modified_on: '2026-05-30T00:00:00Z' },
      policy.excludeKeys,
    );
    assert.equal(h1, h2, 'last_month/last_modified_on delta must not change the budgets fingerprint');
  });

  test('parity: gmail labels representative payload (stored body, no id)', () => {
    const policy = findPolicy('gmail', 'labels');
    // The stored record_json has no `id` (the stream is keyed by `name`).
    // The connector hashes `{id:name, ...body}` with excludeFromFingerprint
    // ["id"], which strips the synthetic id and hashes exactly this body.
    // The compaction policy hashes the stored body with excludeKeys [].
    const body = {
      name: '[Gmail]/All Mail',
      canonical_name: 'all mail',
      is_system: true,
      parent_name: null,
      message_count: null,
    };
    expectParity(body, policy.excludeKeys, 'gmail/labels');
    // The connector's exclude-id fingerprint over {id, ...body} MUST equal
    // the compaction fingerprint over the bare stored body.
    const connectorFp = scriptRecordFingerprint({ id: body.name, ...body }, ['id']);
    const compactionFp = scriptRecordFingerprint(body, policy.excludeKeys);
    assert.equal(connectorFp, compactionFp, 'gmail/labels: connector(exclude id) == compaction(stored body)');
  });

  test('parity: usaa statements excludes fetched_at', () => {
    const policy = findPolicy('usaa', 'statements');
    const base = {
      id: 'IDX-ID-0001',
      account_id: 'ACCT-CHK-0001',
      title: 'April 2026 STATEMENT',
      date_delivered: '2026-04-13',
      account_reference: 'USAA CLASSIC CHECKING *9241',
      document_url: 'file:///tmp/usaa/2026-04-aaaa.pdf',
      pdf_sha256: 'a'.repeat(64),
      pdf_path: '/tmp/usaa/2026-04-aaaa.pdf',
    };
    expectParity({ ...base, fetched_at: '2026-04-22T12:00:00.000Z' }, policy.excludeKeys, 'usaa/statements t1');
    expectParity({ ...base, fetched_at: '2026-05-22T12:00:00.000Z' }, policy.excludeKeys, 'usaa/statements t2');
    const h1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-04-22T12:00:00.000Z' }, policy.excludeKeys);
    const h2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-05-22T12:00:00.000Z' }, policy.excludeKeys);
    assert.equal(h1, h2, 'fetched_at delta must not change the statements fingerprint');
  });

  test('parity: chase accounts excludes fetched_at', () => {
    const policy = findPolicy('chase', 'accounts');
    const base = {
      id: 'INTACC123',
      name: 'Sapphire Preferred',
      type: 'credit_card',
      last_four: '9241',
      balance_cents: null,
      available_balance_cents: null,
      credit_limit_cents: null,
      available_credit_cents: null,
      statement_balance_cents: null,
      status: null,
      balance_as_of: null,
    };
    expectParity({ ...base, fetched_at: '2026-04-22T12:00:00.000Z' }, policy.excludeKeys, 'chase/accounts t1');
    expectParity({ ...base, fetched_at: '2026-04-23T12:00:00.000Z' }, policy.excludeKeys, 'chase/accounts t2');
    const h1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-04-22T12:00:00.000Z' }, policy.excludeKeys);
    const h2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-04-23T12:00:00.000Z' }, policy.excludeKeys);
    assert.equal(h1, h2, 'fetched_at delta must not change the accounts fingerprint');
  });

  test('parity: usaa accounts excludes fetched_at but a REAL balance move is a boundary', () => {
    const policy = findPolicy('usaa', 'accounts');
    // Unlike chase/accounts (all balances null), USAA's account body carries
    // a REAL point-in-time balance_cents. Excluding ONLY fetched_at is
    // lossless: a no-op refresh collapses, a balance move does not.
    const base = {
      id: 'ACCT-CHK-0001',
      type: 'checking',
      name: 'USAA CLASSIC CHECKING',
      last_four: '9241',
      balance_cents: 123456,
      available_balance_cents: null,
      status: 'open',
    };
    expectParity({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys, 'usaa/accounts t1');
    expectParity({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys, 'usaa/accounts t2');
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'fetched_at delta must not change the accounts fingerprint (no-op refresh collapses)');
    const moved = scriptRecordFingerprint(
      { ...base, balance_cents: 100000, fetched_at: '2026-06-02T10:00:00.000Z' },
      policy.excludeKeys,
    );
    assert.notEqual(noop1, moved, 'a balance move MUST change the fingerprint — real financial state is never hidden');
  });

  test('parity: usaa credit_card_billing excludes fetched_at but REAL balance/rewards moves are boundaries', () => {
    const policy = findPolicy('usaa', 'credit_card_billing');
    const base = {
      id: 'CC-0001',
      account_id: 'CC-0001',
      account_nickname: 'Everyday Card',
      current_balance_cents: 120000,
      available_credit_cents: 380000,
      credit_limit_cents: 500000,
      annual_percent_rate: '24.99%',
      cash_advance_apr: '29.99%',
      cash_rewards_cents: 1500,
      billing_status: 'Minimum payment met',
      minimum_payment_met: true,
      card_holders: 'Member',
    };
    expectParity({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys, 'usaa/credit_card_billing t1');
    expectParity({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys, 'usaa/credit_card_billing t2');
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'fetched_at delta must not change the billing fingerprint (no-op refresh collapses)');
    // Any of the real financial fields moving is a fingerprint boundary.
    const balMoved = scriptRecordFingerprint({ ...base, current_balance_cents: 150000 }, policy.excludeKeys);
    const rewardsMoved = scriptRecordFingerprint({ ...base, cash_rewards_cents: 2250 }, policy.excludeKeys);
    const aprMoved = scriptRecordFingerprint({ ...base, annual_percent_rate: '26.99%' }, policy.excludeKeys);
    assert.notEqual(noop1, balMoved, 'a current_balance move MUST change the fingerprint');
    assert.notEqual(noop1, rewardsMoved, 'a cash_rewards move MUST change the fingerprint');
    assert.notEqual(noop1, aprMoved, 'an APR move MUST change the fingerprint');
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
      'ynab/budgets',
      'gmail/labels',
      'usaa/statements',
      'chase/accounts',
      'usaa/accounts',
      'usaa/credit_card_billing',
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
