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

  test('parity: slack channel_memberships excludes fetched_at; real membership move is a boundary', () => {
    const policy = findPolicy('slack', 'channel_memberships');
    assert.deepEqual(policy.excludeKeys, ['fetched_at']);
    const base = { id: 'C1:U1', channel_id: 'C1', user_id: 'U1' };
    // Script and canonical helper agree byte-for-byte under the exclusion.
    expectParity({ ...base, fetched_at: '2026-05-26T10:00:00Z' }, policy.excludeKeys, 'slack/channel_memberships t1');
    expectParity({ ...base, fetched_at: '2026-05-27T10:00:00Z' }, policy.excludeKeys, 'slack/channel_memberships t2');
    // A fetched_at-only delta must NOT change the fingerprint (the connector's
    // own no-op-emit definition — FINGERPRINT_EXCLUDE.channel_memberships).
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-05-26T10:00:00Z' }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-05-27T10:00:00Z' }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'fetched_at delta must not change the channel_memberships fingerprint');
    // A real membership field move (channel_id or user_id) MUST change it —
    // a membership appearing or disappearing is never hidden.
    const userMoved = scriptRecordFingerprint(
      { ...base, user_id: 'U2', fetched_at: '2026-05-26T10:00:00Z' },
      policy.excludeKeys,
    );
    const channelMoved = scriptRecordFingerprint(
      { ...base, channel_id: 'C2', fetched_at: '2026-05-26T10:00:00Z' },
      policy.excludeKeys,
    );
    assert.notEqual(noop1, userMoved, 'a user_id move MUST change the fingerprint');
    assert.notEqual(noop1, channelMoved, 'a channel_id move MUST change the fingerprint');
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

  test('parity: chase statements excludes fetched_at', () => {
    const policy = findPolicy('chase', 'statements');
    const base = {
      id: 'a1b2c3d4',
      account_id: 'INTACC123',
      title: 'April 2026 Statement',
      date_delivered: '2026-04-13',
      account_reference: 'Sapphire Preferred *9241',
      document_url: 'file:///tmp/chase/2026-04-aaaa.pdf',
      pdf_path: '/tmp/chase/2026-04-aaaa.pdf',
      pdf_sha256: 'a'.repeat(64),
    };
    expectParity({ ...base, fetched_at: '2026-04-22T12:00:00.000Z' }, policy.excludeKeys, 'chase/statements t1');
    expectParity({ ...base, fetched_at: '2026-05-22T12:00:00.000Z' }, policy.excludeKeys, 'chase/statements t2');
    const h1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-04-22T12:00:00.000Z' }, policy.excludeKeys);
    const h2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-05-22T12:00:00.000Z' }, policy.excludeKeys);
    assert.equal(h1, h2, 'fetched_at delta must not change the statements fingerprint');
  });

  test('parity: chase transactions excludes fetched_at but a REAL field move is a boundary', () => {
    const policy = findPolicy('chase', 'transactions');
    // A posted transaction's identity (id = account_id|fitid) and fields
    // are immutable; only `fetched_at` moves when the incremental window
    // re-downloads it. Excluding ONLY fetched_at is lossless: a no-op
    // re-download collapses, a real field move does not.
    const base = {
      id: 'INTACC123|FITID-0001',
      account_id: 'INTACC123',
      account_name: 'Sapphire Preferred',
      fitid: 'FITID-0001',
      date: '2026-04-10',
      amount: -4599,
      currency: 'USD',
      type: 'DEBIT',
      name: 'COFFEE SHOP',
      memo: null,
      check_number: null,
      reference_number: null,
      source: 'qfx_download_since_last_statement_2026-04-10',
    };
    expectParity({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys, 'chase/transactions t1');
    expectParity({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys, 'chase/transactions t2');
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'fetched_at delta must not change the transactions fingerprint (re-download collapses)');
    const amountMoved = scriptRecordFingerprint(
      { ...base, amount: -5000, fetched_at: '2026-06-02T10:00:00.000Z' },
      policy.excludeKeys,
    );
    const nameMoved = scriptRecordFingerprint(
      { ...base, name: 'CORRECTED MERCHANT', fetched_at: '2026-06-02T10:00:00.000Z' },
      policy.excludeKeys,
    );
    assert.notEqual(noop1, amountMoved, 'an amount move MUST change the fingerprint — real transaction data is never hidden');
    assert.notEqual(noop1, nameMoved, 'a name move MUST change the fingerprint');
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

  test('parity: usaa transactions excludes fetched_at but a REAL field move is a boundary', () => {
    const policy = findPolicy('usaa', 'transactions');
    // A posted transaction's identity (id = hashId(accountId|date|amount|
    // original|#ord)) and fields are immutable; only `fetched_at` moves when
    // the incremental window re-downloads it or the PDF is re-parsed.
    // Excluding ONLY fetched_at is lossless: a no-op re-surface collapses, a
    // real field move (e.g. balance_after_cents) does not.
    const base = {
      id: '6a249d555d12b055946a3c84248113df',
      account_id: 'ACCT-CHK-0001',
      account_name: 'USAA CLASSIC CHECKING',
      date: '2026-04-10',
      description: 'COFFEE SHOP',
      original_description: 'COFFEE SHOP',
      category: null,
      amount: -4599,
      currency: 'USD',
      balance_after_cents: null,
      check_number: null,
      source: 'csv_export',
    };
    expectParity({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys, 'usaa/transactions t1');
    expectParity({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys, 'usaa/transactions t2');
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'fetched_at delta must not change the transactions fingerprint (re-surface collapses)');
    const balMoved = scriptRecordFingerprint(
      { ...base, balance_after_cents: 105000, fetched_at: '2026-06-02T10:00:00.000Z' },
      policy.excludeKeys,
    );
    assert.notEqual(noop1, balMoved, 'a balance_after_cents move MUST change the fingerprint — real data is never hidden');
  });

  test('parity: usaa inbox_messages excludes fetched_at but a read/unread flip is a boundary', () => {
    const policy = findPolicy('usaa', 'inbox_messages');
    const base = {
      id: 'inbox-hash-1',
      date_received: '2026-05-14',
      status: 'unread',
      subject: 'Your statement is ready to view',
      preview: 'Your statement is ready to view',
    };
    expectParity({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys, 'usaa/inbox_messages t1');
    expectParity({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys, 'usaa/inbox_messages t2');
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'fetched_at delta must not change the inbox fingerprint (no-op re-scrape collapses)');
    const flipped = scriptRecordFingerprint({ ...base, status: 'read' }, policy.excludeKeys);
    assert.notEqual(noop1, flipped, 'a read/unread status flip MUST change the fingerprint — a real transition is never hidden');
  });

  test('parity: chase current_activity excludes fetched_at but a pending→posted transition is a boundary', () => {
    const policy = findPolicy('chase', 'current_activity');
    const base = {
      id: 'INTACC123|txn_20260514_A1',
      account_id: 'INTACC123',
      account_name: 'Sapphire Preferred',
      status: 'pending',
      activity_date: '2026-05-14',
      posted_date: null,
      amount: -4217,
      currency: 'USD',
      description: 'Whole Foods Market',
      memo: null,
      ui_transaction_id: 'txn_20260514_A1',
      source: 'chase_activity_ui',
    };
    expectParity({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys, 'chase/current_activity t1');
    expectParity({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys, 'chase/current_activity t2');
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'fetched_at delta must not change the current_activity fingerprint (re-render collapses)');
    const posted = scriptRecordFingerprint(
      { ...base, status: 'posted', posted_date: '2026-05-14', fetched_at: '2026-06-02T10:00:00.000Z' },
      policy.excludeKeys,
    );
    assert.notEqual(noop1, posted, 'a pending→posted transition MUST change the fingerprint — a real transition is never hidden');
  });

  test('parity: amazon orders excludes fetched_at but a delivery_status move is a boundary', () => {
    const policy = findPolicy('amazon', 'orders');
    const base = {
      id: '111-1234567-8901234',
      order_date: '2026-01-05',
      order_total: '$42.99',
      order_total_cents: 4299,
      delivery_status: 'Shipping',
      status_detail: null,
      recipient_name: 'Fake Name',
      shipping_address_summary: '123 Fake St',
      payment_method_summary: 'Visa ending in 0000',
      gift_order: false,
      digital_order: false,
      item_count: 1,
    };
    expectParity({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys, 'amazon/orders t1');
    expectParity({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys, 'amazon/orders t2');
    const noop1 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-01T10:00:00.000Z' }, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base, fetched_at: '2026-06-02T10:00:00.000Z' }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'fetched_at delta must not change the orders fingerprint (re-scrape collapses)');
    const shipped = scriptRecordFingerprint({ ...base, delivery_status: 'Delivered' }, policy.excludeKeys);
    assert.notEqual(noop1, shipped, 'a delivery_status move MUST change the fingerprint — real order state is never hidden');
  });

  test('parity: chatgpt custom_instructions whole-body fingerprint (no exclude); an edit is a boundary', () => {
    const policy = findPolicy('chatgpt', 'custom_instructions');
    assert.deepEqual(policy.excludeKeys, [], 'custom_instructions hashes the whole body (no run-clock field)');
    // The stored record_json is the full builder body including the stable
    // synthetic id. The connector gates with openFingerprintCursor() over the
    // whole record (excludeFromFingerprint []), so script(body, []) must equal
    // connector(body, []).
    const base = {
      id: 'user_custom_instructions',
      about_user: "I'm a tester",
      response_style: 'Be concise',
      enabled: true,
      updated_at: '2026-05-26T10:00:00.000Z',
    };
    expectParity(base, policy.excludeKeys, 'chatgpt/custom_instructions');
    // A true no-op refresh (identical body) is the same fingerprint → collapses.
    const noop1 = scriptRecordFingerprint(base, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'an identical body is one fingerprint (no-op re-emit collapses)');
    // A real instructions edit moves the body hash → retained as a boundary.
    const edited = scriptRecordFingerprint({ ...base, about_user: 'A different bio' }, policy.excludeKeys);
    assert.notEqual(noop1, edited, 'an instructions edit MUST change the fingerprint — real edits are never hidden');
  });

  test('parity: chatgpt shared_conversations whole-body fingerprint (no exclude); new id / title move is a boundary', () => {
    const policy = findPolicy('chatgpt', 'shared_conversations');
    assert.deepEqual(policy.excludeKeys, [], 'shared_conversations hashes the whole body (no run-clock field)');
    const base = {
      id: 'share-abc',
      conversation_id: 'conv-abc',
      share_url: 'https://chatgpt.com/share/share-abc',
      title: 'A shared chat',
      created_at: '2026-05-26T10:00:00.000Z',
      anonymous: false,
      is_public: true,
      highlighted_text: null,
    };
    expectParity(base, policy.excludeKeys, 'chatgpt/shared_conversations');
    const noop1 = scriptRecordFingerprint(base, policy.excludeKeys);
    const noop2 = scriptRecordFingerprint({ ...base }, policy.excludeKeys);
    assert.equal(noop1, noop2, 'a byte-identical re-list is one fingerprint (no-op re-emit collapses)');
    const retitled = scriptRecordFingerprint({ ...base, title: 'Renamed chat' }, policy.excludeKeys);
    assert.notEqual(noop1, retitled, 'a title change MUST change the fingerprint — real changes are never hidden');
    const newShare = scriptRecordFingerprint({ ...base, id: 'share-xyz' }, policy.excludeKeys);
    assert.notEqual(noop1, newShare, 'a new share id is a distinct fingerprint');
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

  test('parity: claude-code local-device record shapes (messages, attachments, sessions, mtime-stamped artifacts)', () => {
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
      'claude-code/messages',
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
      'claude-code/attachments',
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
      'claude-code/sessions',
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
      'claude-code/skills',
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
      'claude-code/memory_notes',
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
      'claude-code/slash_commands',
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
      'slack/channel_memberships',
      'ynab/payee_locations',
      'ynab/budgets',
      'gmail/labels',
      'usaa/statements',
      'chase/accounts',
      'chase/statements',
      'chase/transactions',
      'chase/current_activity',
      'usaa/accounts',
      'usaa/credit_card_billing',
      'usaa/transactions',
      'usaa/inbox_messages',
      'amazon/orders',
      'chatgpt/custom_instructions',
      'chatgpt/shared_conversations',
      // exact stable-JSON identity family (codex)
      'codex/messages',
      'codex/function_calls',
      'codex/sessions',
      'codex/skills',
      'codex/prompts',
      'codex/rules',
      // exact stable-JSON identity family (claude-code)
      'claude-code/messages',
      'claude-code/attachments',
      'claude-code/sessions',
      'claude-code/skills',
      'claude-code/memory_notes',
      'claude-code/slash_commands',
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
