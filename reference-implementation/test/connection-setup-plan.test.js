import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_BOUND_RUNBOOK_PATH,
  STATIC_SECRET_RUNBOOK_PATH,
  buildConnectionSetupPlan,
  classifyConnectorIntentModality,
} from '../server/connection-setup-plan.ts';

function manifest(connectorId, bindings) {
  return {
    connector_id: `https://registry.pdpp.org/connectors/${connectorId}`,
    display_name: connectorId,
    runtime_requirements: { bindings },
  };
}

test('setup planner supports proven local collectors without creating active connections', () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: 'codex',
    manifest: manifest('codex', { filesystem: { required: true } }),
  });
  assert.equal(plan.connectorModality, 'local_collector');
  assert.equal(plan.supportState, 'supported');
  assert.equal(plan.catalogDisposition, 'local_collector_enroll');
  assert.equal(plan.nextStepKind, 'enroll_local_collector');
  assert.equal(plan.ownerAgentIntent.status, 'supported');
  assert.equal(plan.ownerAgentIntent.nextStepKind, 'enroll_local_collector');
  assert.equal(plan.enrollmentKey, 'codex');
});

test('setup planner supports URL-shaped local collector identifiers', () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: 'https://registry.pdpp.org/connectors/claude-code',
    manifest: manifest('claude-code', { filesystem: { required: true } }),
  });
  assert.equal(plan.connectorKey, 'claude-code');
  assert.equal(plan.supportState, 'supported');
  assert.equal(plan.catalogDisposition, 'local_collector_enroll');
  assert.equal(plan.enrollmentKey, 'claude_code');
});

test('setup planner proof-gates filesystem connectors outside the proven enrollment set', () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: 'slack',
    manifest: manifest('slack', { filesystem: { required: true } }),
  });
  assert.equal(plan.connectorModality, 'local_collector');
  assert.equal(plan.supportState, 'proof_gated');
  assert.equal(plan.catalogDisposition, 'local_collector_unproven');
  assert.equal(plan.ownerAgentIntent.status, 'unsupported');
  assert.equal(plan.proofGate, 'local_collector_connector_proof_missing');
  assert.equal(plan.enrollmentKey, undefined);
});

test('setup planner keeps browser-bound connectors proof-gated before live proof', () => {
  const amazon = buildConnectionSetupPlan({
    connectorKey: 'amazon',
    manifest: manifest('amazon', { browser: { required: true }, network: { required: true } }),
  });
  assert.equal(amazon.connectorModality, 'browser_bound');
  assert.equal(amazon.supportState, 'proof_gated');
  assert.equal(amazon.catalogDisposition, 'browser_collector_manual');
  assert.equal(amazon.nextStepKind, 'enroll_browser_collector');
  assert.equal(amazon.ownerAgentIntent.status, 'unsupported');
  assert.equal(amazon.proofGate, 'browser_collector_live_proof_missing');
  assert.equal(amazon.runbookPath, BROWSER_BOUND_RUNBOOK_PATH);

  const chase = buildConnectionSetupPlan({
    connectorKey: 'chase',
    manifest: manifest('chase', { browser: { required: true } }),
  });
  assert.equal(chase.catalogDisposition, 'browser_bound_runbook');
  assert.equal(chase.enrollmentKey, undefined);
});

test('setup planner keeps static-secret connectors proof-gated before live proof', () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: 'gmail',
    manifest: manifest('gmail', { network: { required: true } }),
  });
  assert.equal(plan.connectorModality, 'api_network');
  assert.equal(plan.supportState, 'proof_gated');
  assert.equal(plan.catalogDisposition, 'static_secret_connect');
  assert.equal(plan.nextStepKind, 'manual_runbook');
  assert.equal(plan.ownerAgentIntent.status, 'unsupported');
  assert.equal(plan.proofGate, 'static_secret_live_proof_missing');
  assert.equal(plan.runbookPath, STATIC_SECRET_RUNBOOK_PATH);
});

test('setup planner distinguishes unsupported network connectors from static-secret connectors', () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: 'notion',
    manifest: manifest('notion', { network: { required: true } }),
  });
  assert.equal(plan.connectorModality, 'api_network');
  assert.equal(plan.supportState, 'unsupported');
  assert.equal(plan.catalogDisposition, 'api_network_unsupported');
  assert.equal(plan.proofGate, null);
  assert.equal(plan.runbookPath, null);
});

test('setup planner returns typed unknown for missing manifests', () => {
  const plan = buildConnectionSetupPlan({ connectorKey: 'bogus', manifest: null });
  assert.equal(plan.connectorKey, 'bogus');
  assert.equal(plan.connectorModality, 'unknown');
  assert.equal(plan.supportState, 'unsupported');
  assert.equal(plan.catalogDisposition, 'unknown_unsupported');
  assert.equal(plan.ownerAgentIntent.status, 'unsupported');
});

test('classifyConnectorIntentModality preserves filesystem over browser over network precedence', () => {
  assert.equal(classifyConnectorIntentModality(manifest('x', { network: {} })), 'api_network');
  assert.equal(classifyConnectorIntentModality(manifest('x', { browser: {}, network: {} })), 'browser_bound');
  assert.equal(classifyConnectorIntentModality(manifest('x', { filesystem: {}, browser: {} })), 'local_collector');
  assert.equal(classifyConnectorIntentModality(null), 'unknown');
});
