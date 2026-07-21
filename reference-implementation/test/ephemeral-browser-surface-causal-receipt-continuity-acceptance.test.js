// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

const NOW = '2026-07-16T12:00:00.000Z';

function runtimeReceipt(connectionId) {
  return {
    connection_id: connectionId,
    connector_id: connectionId,
    profile_key: `${connectionId}:profile`,
    run_id: `${connectionId}:run_current`,
    surface_subject_id: `${connectionId}:subject`,
    surface_id: `${connectionId}:surface`,
    lease_id: `${connectionId}:lease`,
    generation: 7,
    lifecycle: ['ready', 'succeeded', 'released'],
    completed_at: NOW,
  };
}

test('LastSuccessfulRuntimeReceipt is historical-only, exact, bounded, and separate from replacement causes', async () => {
  const { evaluateLastSuccessfulRuntimeReceipt } = await import('../runtime/browser-surface/runtime-receipts.ts');
  const receipt = runtimeReceipt('connection-a');
  const context = {
    ...receipt,
    now: NOW,
    max_age_ms: 15 * 60 * 1000,
  };
  const accepted = evaluateLastSuccessfulRuntimeReceipt(receipt, context);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.authority, 'historical_only');
  assert.deepEqual(accepted.lifecycle, ['ready', 'succeeded', 'released']);

  const mismatches = [
    ['prior run', { run_id: 'connection-a:run_prior' }],
    ['old age', { completed_at: '2026-07-15T12:00:00.000Z' }],
    ['connection mismatch', { connection_id: 'connection-b' }],
    ['profile mismatch', { profile_key: 'connection-b:profile' }],
    ['surface subject mismatch', { surface_subject_id: 'connection-b:subject' }],
    ['surface mismatch', { surface_id: 'connection-b:surface' }],
    ['lease mismatch', { lease_id: 'connection-b:lease' }],
    ['generation mismatch', { generation: 6 }],
    ['sequence/order mismatch', { lifecycle: ['ready', 'released', 'succeeded'] }],
    ['time mismatch', { completed_at: '2026-07-16T12:30:00.000Z' }],
  ];
  for (const [name, change] of mismatches) {
    assert.equal(
      evaluateLastSuccessfulRuntimeReceipt({ ...receipt, ...change }, context).valid,
      false,
      name,
    );
  }
});

test('H-E-B and Reddit runtime success fixture accepts only the emitted succeeded completion shape', async () => {
  const { isSucceededRunCompletionEvent } = await import('../runtime/browser-surface/runtime-receipts.ts');
  for (const connector_id of ['heb', 'reddit']) {
    const context = { connector_id, run_id: `${connector_id}:run_1` };
    const emitted = {
      event_type: 'run.completed',
      status: 'succeeded',
      actor_id: connector_id,
      run_id: `${connector_id}:run_1`,
    };
    assert.equal(isSucceededRunCompletionEvent(emitted, context), true, connector_id);
    assert.equal(
      isSucceededRunCompletionEvent({ ...emitted, event_type: 'run.progress' }, context),
      false,
      'a generic succeeded status is not a run completion',
    );
    assert.equal(
      isSucceededRunCompletionEvent({ ...emitted, status: 'completed' }, context),
      false,
      'the event-type word is not the runtime done status',
    );
    assert.equal(isSucceededRunCompletionEvent({ ...emitted, actor_id: 'other' }, context), false, 'actor is exact');
    assert.equal(isSucceededRunCompletionEvent({ ...emitted, run_id: 'other:run' }, context), false, 'run is exact');
  }
});

test('replacement receipt ledger covers corrected causes, two phases, deterministic idempotency, and redaction', async () => {
  const { createBrowserSurfaceReplacementLedger } = await import('../runtime/browser-surface/replacement-receipt-ledger.ts');
  const causes = [
    'capacity_pressure',
    'idle_ttl',
    'operator_requested',
    'restart_reconcile',
    'readiness_invalidated',
    'allocator_internal_ensure_surface',
    'same_container_browser_generation_change',
    'external_or_host_loss',
  ];
  const ledger = createBrowserSurfaceReplacementLedger({ now: () => NOW, idPrefix: 'replacement' });

  for (const cause of causes) {
    const started = ledger.start({
      connection_id: 'connection-a',
      profile_key: 'connection-a:profile',
      surface_subject_id: 'connection-a:subject',
      previous_generation: 7,
      cause,
    });
    assert.equal(started.phase, 'started', cause);
    const completed = ledger.complete({
      replacement_id: started.replacement_id,
      connection_id: 'connection-a',
      next_generation: 8,
      cause,
    });
    assert.equal(completed.phase, 'completed', cause);
    assert.equal(completed.replacement_id, started.replacement_id, cause);
    assert.equal(completed.secret, undefined, 'replacement receipt is redacted');
    assert.deepEqual(ledger.complete({
      replacement_id: started.replacement_id,
      connection_id: 'connection-a',
      next_generation: 8,
      cause,
    }), completed, `idempotent completion for ${cause}`);
  }
});

test('allocator fakes preserve two independent container replacement causal chains', async () => {
  const {
    createBrowserSurfaceReplacementLedger,
    createReplacementObservingAllocator,
    deriveOpaqueGenerationHash,
  } = await import('../runtime/browser-surface/replacement-receipt-ledger.ts');

  function surface(subject, id, container) {
    return {
      surface_id: id,
      backend: 'neko',
      profile_key: 'shared-profile-key',
      connector_id: 'chatgpt',
      surface_subject_id: subject,
      cdp_url: `http://neko/${id}`,
      stream_base_url: `http://neko/${id}/stream`,
      health: 'ready',
      container_id: container,
      created_at: NOW,
      last_used_at: NOW,
    };
  }

  async function replacement(subject, id, oldContainer, newContainer) {
    const oldSurface = surface(subject, id, oldContainer);
    const newSurface = surface(subject, id, newContainer);
    const ledger = createBrowserSurfaceReplacementLedger({ now: () => NOW, idPrefix: 'replacement' });
    const persisted = [];
    const observed = createReplacementObservingAllocator({
      ensureSurface: async () => newSurface,
      getSurfaceStatus: async () => oldSurface,
      stopSurface: async () => null,
      listSurfaces: async () => [newSurface],
    }, {
      ledger,
      persist: async (receipt) => {
        persisted.push(receipt);
        return receipt;
      },
    });
    await observed.ensureSurface({
      surfaceId: id,
      connectorId: 'chatgpt',
      profileKey: 'shared-profile-key',
      surfaceSubjectId: subject,
    });
    const started = persisted[0];
    const browserGenerationHash = deriveOpaqueGenerationHash(`${id}:post-readiness-cdp-generation`);
    const completed = ledger.complete({
      replacement_id: started.replacement_id,
      connection_id: started.connection_id,
      profile_key: started.profile_key,
      surface_subject_id: subject,
      surface_id: id,
      cause: started.cause,
      next_generation_hash: browserGenerationHash,
    });
    persisted.push(completed);
    return { completed, ledger, persisted, browserGenerationHash };
  }

  const first = await replacement('connection-a:subject', 'surface-a', 'container-a-old', 'container-a-new');
  const second = await replacement('connection-b:subject', 'surface-b', 'container-b-old', 'container-b-new');
  const combined = createBrowserSurfaceReplacementLedger({ now: () => NOW, idPrefix: 'combined' });
  combined.hydrate([...first.persisted, ...second.persisted]);

  assert.deepEqual(first.persisted.map((receipt) => receipt.phase), ['started', 'completed']);
  assert.deepEqual(second.persisted.map((receipt) => receipt.phase), ['started', 'completed']);
  assert.notEqual(first.persisted[0].replacement_id, second.persisted[0].replacement_id);
  assert.notEqual(first.completed.scope, second.completed.scope);
  assert.equal(
    combined.selectCurrent('connection-a:subject', 'connection-a:subject', first.browserGenerationHash)?.replacement_id,
    first.completed.replacement_id,
  );
  assert.equal(
    combined.selectCurrent('connection-b:subject', 'connection-b:subject', second.browserGenerationHash)?.replacement_id,
    second.completed.replacement_id,
  );
  assert.equal(combined.selectCurrent('connection-a:subject', 'connection-a:subject', second.browserGenerationHash), null);
  assert.equal(combined.selectCurrent('connection-b:subject', 'connection-b:subject', first.browserGenerationHash), null);
  // Provider-session survival and an exact authenticated provider probe across both replacements remain a separate OPEN live gate.
});

test('typed repair decision requires provider proof, rejects ambiguous evidence, and deduplicates per connection', async () => {
  const { decideBrowserSurfaceRepair } = await import('../runtime/browser-surface/repair-decision.ts');
  const noProofEvidence = [
    { kind: 'replacement_verification_pending' },
    { kind: 'session_probe_false' },
    { kind: 'session_probe_indeterminate' },
    { kind: 'ambiguous_dom_profile_evidence' },
  ];
  for (const evidence of noProofEvidence) {
    assert.equal(
      decideBrowserSurfaceRepair({ connection_id: 'connection-a', evidence }).action,
      'none',
      evidence.kind,
    );
  }
  assert.throws(
    () => decideBrowserSurfaceRepair({ connection_id: 'connection-a', evidence: 'provider_proven_invalidation' }),
    'arbitrary strings cannot manufacture repair authority',
  );

  const proof = {
    kind: 'provider_invalidation_proof',
    provider: 'chatgpt',
    connection_id: 'connection-a',
    verified: true,
    evidence_id: 'provider-proof-a',
    observed_at: NOW,
  };
  const first = decideBrowserSurfaceRepair({ connection_id: 'connection-a', evidence: proof });
  assert.equal(first.action, 'repair');
  assert.equal(
    decideBrowserSurfaceRepair({
      connection_id: 'connection-a',
      evidence: proof,
      repaired_proof_keys: [first.dedupe_key],
    }).action,
    'none',
    'durable, explicit proof identity deduplicates one connection',
  );
  const otherProof = { ...proof, connection_id: 'connection-b' };
  assert.equal(
    decideBrowserSurfaceRepair({ connection_id: 'connection-b', evidence: otherProof }).action,
    'repair',
    'other connection remains independently actionable',
  );
});
