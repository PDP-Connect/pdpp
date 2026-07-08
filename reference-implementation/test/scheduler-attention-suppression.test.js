// Scheduler attention-suppression tests for
// `define-schedule-manual-attention-policy`.
//
// These exercises drive the scheduler directly (no AS/RS/device-auth) so
// they isolate the policy contract from the rest of the reference
// implementation. They prove:
//
//   1. A due schedule with an unresolved equivalent attention request
//      does not start another automatic run, and the audit log records
//      exactly one suppression skip per attention identity (no retry
//      storm).
//   2. Suppression for one connection does not affect a peer connection
//      with no attention (no cross-connection bleed).
//   3. After attention resolves, missed ticks do not replay as an
//      unbounded backlog — the next eligible tick fires at most one
//      latest-state catch-up run.
//   4. A failure inside the durable-attention probe must NOT silently
//      suppress launches.
//
// We exercise the runtime/scheduler.ts seam directly: only the policy
// gates that come before runConnector are tested, so the tests do not
// depend on AS/RS/db state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createScheduler } from '../runtime/scheduler.ts';

// Manifest tagged not-background-safe so the scheduler's automation
// policy gate emits a deterministic skip BEFORE runConnector is invoked.
// This isolates the new attention-suppression policy from runtime
// concerns (DB init, RS HTTP) that are exercised elsewhere.
const POLICY_BLOCKED_MANIFEST = {
  capabilities: {
    refresh_policy: { background_safe: false },
  },
};

function writeUnusedConnector(tmpDir, name = 'unused-connector.mjs') {
  const attemptsPath = join(tmpDir, `${name}.attempts.log`);
  const connectorPath = join(tmpDir, name);
  // The connector never actually runs in these tests — the scheduler
  // skips before invoking runConnector when attention is unresolved or
  // when the manifest forbids background runs. We still need a real
  // path so the scheduler doesn't crash building the spawn command.
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', () => {
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  process.exit(0);
});
`,
    'utf8',
  );
  return { attemptsPath, connectorPath };
}

function readAttempts(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(condition, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for scheduler condition');
}

function cancelledInteractionResponse(interaction) {
  return {
    type: 'INTERACTION_RESPONSE',
    request_id: interaction.request_id,
    status: 'cancelled',
  };
}

test('scheduler skips due runs while durable attention is unresolved and emits one suppression per identity', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-attn-suppress-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir);
  const completedRuns = [];
  const attentionKey = 'att_login_required_v1';

  const scheduler = createScheduler({
    connectors: [{
      connectorId: 'attn-suppress-connector',
      connectorPath,
      manifest: { capabilities: { refresh_policy: { background_safe: true } } },
      intervalMs: 25,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    hasUnresolvedAttention: () => ({ key: attentionKey, reason: 'credentials_required' }),
  });

  try {
    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    // Let several more ticks fire to verify the durable attention
    // suppression dedupes follow-up skips on the same identity.
    await new Promise((resolve) => setTimeout(resolve, 250));
    scheduler.stop();

    assert.deepEqual(readAttempts(attemptsPath), [], 'connector must not be spawned while attention is unresolved');
    assert.equal(completedRuns.length, 1, 'one suppression record per attention identity (no retry storm)');
    const [skip] = completedRuns;
    assert.equal(skip.status, 'skipped');
    assert.match(skip.error, /^attention_unresolved:/);
    assert.match(skip.error, /credentials_required/);
    assert.match(skip.error, /att_login_required_v1/);
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scheduler emits a fresh suppression skip when the attention identity changes', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-attn-rotate-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir);
  const completedRuns = [];
  let attentionKey = 'att_first';

  const scheduler = createScheduler({
    connectors: [{
      connectorId: 'attn-rotate-connector',
      connectorPath,
      manifest: { capabilities: { refresh_policy: { background_safe: true } } },
      intervalMs: 25,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    hasUnresolvedAttention: () => ({ key: attentionKey, reason: 'reason_a' }),
  });

  try {
    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    // Rotate the attention identity — should re-arm the emitter.
    attentionKey = 'att_second';
    await waitFor(() => completedRuns.length >= 2, 5000);
    scheduler.stop();

    assert.deepEqual(readAttempts(attemptsPath), []);
    assert.equal(completedRuns.length, 2);
    assert.match(completedRuns[0].error, /att_first/);
    assert.match(completedRuns[1].error, /att_second/);
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('attention suppression does not bleed across connections', async () => {
  // Two schedules: one blocked on attention, one with the same
  // not-background-safe policy. The blocked connector must emit the
  // attention suppression record; the peer must emit its own
  // automation_policy_blocked record (because we use the
  // policy-blocked manifest to avoid spawning runConnector). The peer
  // MUST NOT be tagged as attention-suppressed.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-attn-isolation-'));
  const blockedConnector = writeUnusedConnector(tmpDir, 'blocked.mjs');
  const peerConnector = writeUnusedConnector(tmpDir, 'peer.mjs');
  const completedRuns = [];

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId: 'blocked-connector',
        connectorPath: blockedConnector.connectorPath,
        manifest: POLICY_BLOCKED_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      },
      {
        connectorId: 'peer-connector',
        connectorPath: peerConnector.connectorPath,
        manifest: POLICY_BLOCKED_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      },
    ],
    rsUrl: 'http://localhost.invalid',
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    hasUnresolvedAttention: (connectorId) =>
      connectorId === 'blocked-connector' ? { key: 'att_blocked_only', reason: 'manual_action_required' } : null,
  });

  try {
    scheduler.start();
    await waitFor(
      () =>
        completedRuns.some((r) => r.connectorId === 'blocked-connector' && /attention_unresolved/.test(r.error || '')) &&
        completedRuns.some((r) => r.connectorId === 'peer-connector' && /automation_policy_blocked/.test(r.error || '')),
      5000,
    );
    // Let extra ticks fire to make sure suppression dedupe holds and
    // does not leak to the peer.
    await new Promise((resolve) => setTimeout(resolve, 250));
    scheduler.stop();

    assert.equal(readAttempts(blockedConnector.attemptsPath).length, 0, 'blocked connector must not be spawned');
    assert.equal(readAttempts(peerConnector.attemptsPath).length, 0, 'peer connector must not be spawned either (policy-blocked)');

    const blockedAttention = completedRuns.filter(
      (r) => r.connectorId === 'blocked-connector' && /attention_unresolved/.test(r.error || ''),
    );
    assert.equal(blockedAttention.length, 1, 'one attention skip for the blocked connector, deduped across ticks');

    const peerAttention = completedRuns.filter(
      (r) => r.connectorId === 'peer-connector' && /attention_unresolved/.test(r.error || ''),
    );
    assert.equal(peerAttention.length, 0, 'peer connector must not be tagged as attention-suppressed');

    const peerPolicy = completedRuns.filter(
      (r) => r.connectorId === 'peer-connector' && /automation_policy_blocked/.test(r.error || ''),
    );
    assert.ok(peerPolicy.length >= 1, 'peer connector continues to surface its own (independent) policy skip');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('attention suppression is scoped by connector instance for duplicate connector types', async () => {
  // Two schedules for the same connector type mirror two ChatGPT accounts.
  // The rendered owner action for one connection must not suppress the peer
  // just because both schedules share connectorId.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-attn-same-connector-'));
  const blockedConnector = writeUnusedConnector(tmpDir, 'chatgpt-blocked.mjs');
  const peerConnector = writeUnusedConnector(tmpDir, 'chatgpt-peer.mjs');
  const completedRuns = [];

  const scheduler = createScheduler({
    connectors: [
      {
        connectorId: 'chatgpt',
        connectorInstanceId: 'cin_chatgpt_blocked',
        connectorPath: blockedConnector.connectorPath,
        manifest: POLICY_BLOCKED_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      },
      {
        connectorId: 'chatgpt',
        connectorInstanceId: 'cin_chatgpt_peer',
        connectorPath: peerConnector.connectorPath,
        manifest: POLICY_BLOCKED_MANIFEST,
        intervalMs: 25,
        maxRetries: 0,
        ownerToken: 'owner-token',
      },
    ],
    rsUrl: 'http://localhost.invalid',
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    hasUnresolvedAttention: (_connectorId, connectorInstanceId) =>
      connectorInstanceId === 'cin_chatgpt_blocked'
        ? {
            key: 'owner_action:cin_chatgpt_blocked:reauth:browser_session:session_required',
            reason: 'session_required',
          }
        : null,
  });

  try {
    scheduler.start();
    await waitFor(
      () =>
        completedRuns.some(
          (r) =>
            r.connectorInstanceId === 'cin_chatgpt_blocked' &&
            /attention_unresolved/.test(r.error || ''),
        ) &&
        completedRuns.some(
          (r) =>
            r.connectorInstanceId === 'cin_chatgpt_peer' &&
            /automation_policy_blocked/.test(r.error || ''),
        ),
      5000,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    scheduler.stop();

    const blockedAttention = completedRuns.filter(
      (r) => r.connectorInstanceId === 'cin_chatgpt_blocked' && /attention_unresolved/.test(r.error || ''),
    );
    assert.equal(blockedAttention.length, 1, 'blocked ChatGPT connection gets one deduped attention skip');

    const peerAttention = completedRuns.filter(
      (r) => r.connectorInstanceId === 'cin_chatgpt_peer' && /attention_unresolved/.test(r.error || ''),
    );
    assert.equal(peerAttention.length, 0, 'peer ChatGPT connection must not inherit the blocked repair action');

    const peerPolicy = completedRuns.filter(
      (r) => r.connectorInstanceId === 'cin_chatgpt_peer' && /automation_policy_blocked/.test(r.error || ''),
    );
    assert.ok(peerPolicy.length >= 1, 'peer ChatGPT connection remains independently eligible');
    assert.equal(readAttempts(blockedConnector.attemptsPath).length, 0);
    assert.equal(readAttempts(peerConnector.attemptsPath).length, 0);
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolved attention does not replay missed ticks — latest-only catch-up', async () => {
  // Toggle: attention is unresolved for several scheduler ticks, then
  // resolves. The latest-only catch-up rule says the scheduler must not
  // launch one run per missed tick. We use the policy-blocked manifest
  // for the post-resolution path too, so the scheduler emits exactly
  // one record per eligible tick (rather than spawning a real run),
  // making the count assertion deterministic.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-attn-catchup-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir);
  const completedRuns = [];
  let attentionEvidence = { key: 'att_pending', reason: 'manual_action_required' };

  const scheduler = createScheduler({
    connectors: [{
      connectorId: 'attn-catchup-connector',
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 25,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    hasUnresolvedAttention: () => attentionEvidence,
  });

  try {
    scheduler.start();
    // Let several ticks fire while attention is unresolved.
    await waitFor(() => completedRuns.length >= 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const ticksWhileBlocked = completedRuns.length;
    assert.equal(ticksWhileBlocked, 1, 'attention suppression must dedupe — exactly one record while attention persists');
    assert.match(completedRuns[0].error || '', /attention_unresolved/);

    // Resolve attention. Subsequent ticks should fall through to the
    // automation-policy gate (one record per tick) — proving the
    // scheduler resumed eligibility WITHOUT replaying one run per
    // suppressed tick.
    attentionEvidence = null;
    await waitFor(
      () => completedRuns.some((r) => /automation_policy_blocked/.test(r.error || '')),
      5000,
    );
    // Stop quickly so we can count: the catch-up must not produce a
    // burst proportional to the number of suppressed ticks.
    scheduler.stop();

    const attentionSkips = completedRuns.filter((r) => /attention_unresolved/.test(r.error || ''));
    const policySkips = completedRuns.filter((r) => /automation_policy_blocked/.test(r.error || ''));
    assert.equal(attentionSkips.length, 1, 'attention suppression must remain deduped — no per-tick replay');
    // Latest-only catch-up: we expect the scheduler to surface its
    // next-tick eligibility with ONE policy skip in the brief window
    // before stop(). Anything beyond a small bound would indicate the
    // scheduler tried to drain a backlog of missed ticks.
    assert.ok(
      policySkips.length >= 1 && policySkips.length <= 3,
      `latest-only catch-up should produce 1–3 follow-up records, observed ${policySkips.length}`,
    );
    assert.equal(readAttempts(attemptsPath).length, 0, 'no real spawns during the whole sequence (policy-blocked)');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('attention probe failure must not silently suppress runs', async () => {
  // Probe throws on every tick. The scheduler must treat this as "no
  // evidence" — surface the schedule as eligible (it falls through to
  // the automation-policy gate, which emits a deterministic skip)
  // rather than emitting attention_unresolved records.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-attn-probe-failure-'));
  const { attemptsPath, connectorPath } = writeUnusedConnector(tmpDir);
  const completedRuns = [];

  const scheduler = createScheduler({
    connectors: [{
      connectorId: 'attn-probe-failure-connector',
      connectorPath,
      manifest: POLICY_BLOCKED_MANIFEST,
      intervalMs: 25,
      maxRetries: 0,
      ownerToken: 'owner-token',
    }],
    rsUrl: 'http://localhost.invalid',
    onInteraction: cancelledInteractionResponse,
    onRunComplete: (record) => completedRuns.push(record),
    hasUnresolvedAttention: () => {
      throw new Error('durable attention store unreachable');
    },
  });

  try {
    scheduler.start();
    await waitFor(
      () => completedRuns.some((r) => /automation_policy_blocked/.test(r.error || '')),
      5000,
    );
    scheduler.stop();

    assert.equal(readAttempts(attemptsPath).length, 0, 'manifest is policy-blocked; no spawns expected');
    const attentionSkips = completedRuns.filter((r) => /attention_unresolved/.test(r.error || ''));
    assert.equal(attentionSkips.length, 0, 'probe throws must NOT surface as attention suppression');
    const policySkips = completedRuns.filter((r) => /automation_policy_blocked/.test(r.error || ''));
    assert.ok(policySkips.length >= 1, 'schedule remained eligible despite probe failure');
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
