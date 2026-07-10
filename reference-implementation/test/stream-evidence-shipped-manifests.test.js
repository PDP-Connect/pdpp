import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildCollectionReport } from '../server/ref-control.ts';

// Deterministic reproductions for the 2026-07-10 live-audit rows
// (openspec/changes/define-stream-coverage-freshness-evidence tasks.md 8.4):
// parse the REAL shipped manifests and feed the steady-state fact block each
// connector emits, then assert the projected per-stream coverage condition.
// This pins the whole declaration+classification chain — a manifest edit that
// drops a strategy, or a classifier change that stops honoring one, fails
// here by name rather than resting unmeasured on the live instance.

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(HERE, '..', '..', 'packages', 'polyfill-connectors', 'manifests');

function manifestStreams(connectorId) {
  const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, `${connectorId}.json`), 'utf8'));
  assert.ok(Array.isArray(manifest.streams) && manifest.streams.length > 0, `${connectorId} declares streams`);
  return manifest.streams;
}

/** A steady-state committed-checkpoint fact (STATE emitted, zero new records). */
function committedFact(stream) {
  return { stream, collected: 0, considered: null, covered: null, checkpoint: 'committed', pending_detail_gaps: 0, skipped: null };
}

/** A steady-state parent-detail fact: enumerated denominator, everything accounted. */
function accountedFact(stream, considered) {
  return { stream, collected: 0, considered, covered: considered, checkpoint: 'not_staged', pending_detail_gaps: 0, skipped: null };
}

function report(connectorId, streams) {
  return buildCollectionReport({
    collectionFacts: { streams },
    manifestStreams: manifestStreams(connectorId),
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
}

function condition(entries, stream) {
  const entry = entries.find((e) => e.stream === stream);
  assert.ok(entry, `entry for ${stream}`);
  return entry.coverage_condition;
}

// The audit-named streams, per connector, with the steady-state fact class
// the connector emits at HEAD for each (checkpoint commit vs accounted
// parent-detail denominator). Every row rested unmeasured on the live
// instance; this proves the shipped manifest + a steady-state run now
// classify them complete.
const CHECKPOINT_PROOF_CASES = {
  amazon: ['orders'],
  chase: ['balances', 'current_activity'],
  chatgpt: ['custom_gpts', 'custom_instructions', 'memories', 'shared_conversations'],
  github: ['user', 'user_stats'],
  gmail: ['messages', 'threads', 'labels'],
  reddit: ['comments', 'downvoted', 'hidden', 'saved', 'submitted', 'upvoted'],
  usaa: ['account_stats', 'credit_card_billing', 'credit_card_billing_stats', 'inbox_messages'],
  whatsapp: ['chats', 'messages'],
  ynab: [
    'accounts',
    'account_stats',
    'categories',
    'category_groups',
    'month_categories',
    'months',
    'payee_locations',
    'payees',
    'scheduled_transactions',
    'transactions',
  ],
};

const ACCOUNTED_PROOF_CASES = {
  chase: ['statements', 'transactions'],
  usaa: ['statements', 'transactions'],
};

for (const [connectorId, streams] of Object.entries(CHECKPOINT_PROOF_CASES)) {
  test(`shipped ${connectorId} manifest: steady-state committed checkpoints classify the audit-named streams complete`, () => {
    const entries = report(connectorId, streams.map((stream) => committedFact(stream)));
    for (const stream of streams) {
      assert.equal(condition(entries, stream), 'complete', `${connectorId}/${stream}`);
    }
  });
}

for (const [connectorId, streams] of Object.entries(ACCOUNTED_PROOF_CASES)) {
  test(`shipped ${connectorId} manifest: steady-state accounted denominators classify the audit-named parent-detail streams complete`, () => {
    const entries = report(connectorId, streams.map((stream) => accountedFact(stream, 4)));
    for (const stream of streams) {
      assert.equal(condition(entries, stream), 'complete', `${connectorId}/${stream}`);
    }
  });
}

test('shipped usaa manifest: a zero-candidate steady-state run (considered 0 / covered 0) classifies complete, not unmeasured', () => {
  const entries = report('usaa', [accountedFact('statements', 0), accountedFact('transactions', 0)]);
  assert.equal(condition(entries, 'statements'), 'complete');
  assert.equal(condition(entries, 'transactions'), 'complete');
});

test('shipped slack manifest: the accepted-absent quartet classifies by policy and never blocks; channel_stats proves by checkpoint', () => {
  const entries = report('slack', [committedFact('channel_stats')]);
  for (const stream of ['stars', 'user_groups', 'reminders', 'dm_read_states']) {
    const entry = entries.find((e) => e.stream === stream);
    assert.ok(entry, `entry for ${stream}`);
    assert.equal(entry.coverage_condition, 'deferred', `${stream} classifies by accepted manifest policy`);
    assert.equal(entry.required, false, `${stream} is non-required accepted absence`);
  }
  assert.equal(condition(entries, 'channel_stats'), 'complete');
});

test('shipped gmail manifest: message_bodies inherits the messages checkpoint through state_stream within one run', () => {
  const entries = buildCollectionReport({
    collectionFacts: {
      streams: [
        committedFact('messages'),
        { stream: 'message_bodies', collected: 0, considered: null, covered: null, checkpoint: 'not_staged', pending_detail_gaps: 0, skipped: null },
      ],
    },
    collectionFactsRunId: 'run_now',
    manifestStreams: manifestStreams('gmail'),
    freshness: 'fresh',
    attentionOpen: false,
    refresh: null,
  });
  assert.equal(condition(entries, 'message_bodies'), 'complete');
});

test('shipped manifests: a required stream with NO steady-state fact still rests unknown (the audit contract, not a blanket green)', () => {
  const entries = report('chase', [committedFact('current_activity')]);
  assert.equal(condition(entries, 'balances'), 'unknown', 'no fact -> unknown; only real evidence classifies complete');
});
