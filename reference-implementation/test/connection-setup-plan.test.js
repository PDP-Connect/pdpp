import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_BOUND_RUNBOOK_PATH,
  STATIC_SECRET_RUNBOOK_PATH,
  buildConnectionSetupPlan,
  classifyConnectorIntentModality,
  classifyConnectorSetupModality,
} from '../server/connection-setup-plan.ts';

function manifest(connectorId, bindings, extra = {}) {
  return {
    connector_id: `https://registry.pdpp.org/connectors/${connectorId}`,
    display_name: connectorId,
    runtime_requirements: { bindings },
    ...extra,
  };
}

function staticSecretManifest(connectorId, credentialKind = 'api_key') {
  return manifest(connectorId, { network: { required: true } }, {
    setup: {
      modality: 'static_secret',
      credential_capture: {
        kind: credentialKind,
        label: `${connectorId} secret`,
        fields: [
          {
            name: 'secret',
            label: 'Provider secret',
            required: true,
            secret: true,
            type: 'password',
          },
        ],
      },
    },
  });
}

test('setup planner supports proven local collectors without creating active connections', () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: 'codex',
    manifest: manifest('codex', { filesystem: { required: true } }),
  });
  assert.equal(plan.connectorModality, 'local_collector');
  assert.equal(plan.setupModality, 'local_collector');
  assert.equal(plan.supportState, 'supported');
  assert.equal(plan.deploymentReadiness.state, 'not_applicable');
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
  assert.equal(plan.ownerAgentIntent.status, 'proof_gated');
  assert.equal(plan.ownerAgentIntent.nextStepKind, 'manual_runbook');
  assert.equal(plan.proofGate, 'local_collector_connector_proof_missing');
  assert.equal(plan.enrollmentKey, undefined);
});

test('setup planner keeps browser-bound connectors proof-gated before live proof', () => {
  const amazon = buildConnectionSetupPlan({
    connectorKey: 'amazon',
    manifest: manifest('amazon', { browser: { required: true }, network: { required: true } }),
  });
  assert.equal(amazon.connectorModality, 'browser_bound');
  assert.equal(amazon.setupModality, 'browser_bound');
  assert.equal(amazon.supportState, 'proof_gated');
  assert.equal(amazon.catalogDisposition, 'browser_collector_manual');
  assert.equal(amazon.nextStepKind, 'enroll_browser_collector');
  assert.equal(amazon.ownerAgentIntent.status, 'proof_gated');
  assert.equal(amazon.ownerAgentIntent.nextStepKind, 'manual_runbook');
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
    connectorKey: 'mailbox',
    manifest: staticSecretManifest('mailbox', 'app_password'),
  });
  assert.equal(plan.connectorModality, 'api_network');
  assert.equal(plan.setupModality, 'static_secret');
  assert.equal(plan.supportState, 'proof_gated');
  assert.equal(plan.catalogDisposition, 'static_secret_connect');
  assert.equal(plan.nextStepKind, 'capture_static_secret');
  assert.equal(plan.ownerAgentIntent.status, 'proof_gated');
  assert.equal(plan.ownerAgentIntent.nextStepKind, 'capture_static_secret');
  assert.equal(plan.proofGate, 'static_secret_live_proof_missing');
  assert.equal(plan.runbookPath, STATIC_SECRET_RUNBOOK_PATH);
});

test('setup planner does not infer static-secret setup from connector id alone', () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: 'gmail',
    manifest: manifest('gmail', { network: { required: true } }),
  });
  assert.equal(plan.connectorModality, 'api_network');
  assert.equal(plan.setupModality, 'unsupported');
  assert.equal(plan.supportState, 'unsupported');
});

test('setup planner distinguishes unsupported network connectors from static-secret connectors', () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: 'notion',
    manifest: manifest('notion', { network: { required: true } }),
  });
  assert.equal(plan.connectorModality, 'api_network');
  assert.equal(plan.setupModality, 'unsupported');
  assert.equal(plan.supportState, 'unsupported');
  assert.equal(plan.catalogDisposition, 'api_network_unsupported');
  assert.equal(plan.proofGate, null);
  assert.equal(plan.runbookPath, null);
});

test('setup planner distinguishes provider app readiness from owner authorization', () => {
  const providerManifest = {
    ...manifest('fitness-oauth', { network: { required: true } }),
    capabilities: {
      auth: {
        kind: 'oauth',
        deployment_config: ['FITNESS_OAUTH_CLIENT_ID', 'FITNESS_OAUTH_CLIENT_SECRET'],
      },
    },
  };
  const blocked = buildConnectionSetupPlan({
    connectorKey: 'fitness-oauth',
    manifest: providerManifest,
  });
  assert.equal(blocked.connectorModality, 'api_network');
  assert.equal(blocked.setupModality, 'provider_authorization');
  assert.equal(blocked.supportState, 'needs_deployment_config');
  assert.equal(blocked.catalogDisposition, 'provider_auth_deployment_blocked');
  assert.equal(blocked.nextStepKind, 'needs_deployment_config');
  assert.equal(blocked.proofGate, 'provider_app_deployment_config_missing');
  assert.equal(blocked.deploymentReadiness.state, 'needs_config');
  assert.deepEqual(
    blocked.deploymentReadiness.blockers.map((item) => item.key),
    ['FITNESS_OAUTH_CLIENT_ID', 'FITNESS_OAUTH_CLIENT_SECRET'],
  );
  assert.equal(blocked.deploymentReadiness.blockers[1].secret, true);
  assert.match(blocked.ownerAgentIntent.reason, /provider application/i);

  const readyButUnproven = buildConnectionSetupPlan({
    connectorKey: 'fitness-oauth',
    configuredProviderAuthConnectorKeys: ['fitness-oauth'],
    manifest: providerManifest,
  });
  assert.equal(readyButUnproven.deploymentReadiness.state, 'ready');
  assert.equal(readyButUnproven.supportState, 'proof_gated');
  assert.equal(readyButUnproven.catalogDisposition, 'provider_auth_proof_gated');
  assert.equal(readyButUnproven.nextStepKind, 'manual_runbook');
  assert.equal(readyButUnproven.ownerAgentIntent.status, 'proof_gated');
  assert.equal(readyButUnproven.ownerAgentIntent.nextStepKind, 'manual_runbook');
  assert.equal(readyButUnproven.proofGate, 'provider_authorization_lifecycle_missing');
});

test('classifyConnectorSetupModality separates binding class from setup class', () => {
  assert.equal(classifyConnectorSetupModality('gmail', staticSecretManifest('gmail', 'app_password')), 'static_secret');
  assert.equal(classifyConnectorSetupModality('gmail', manifest('gmail', { network: {} })), 'unsupported');
  assert.equal(
    classifyConnectorSetupModality('oauth-source', {
      ...manifest('oauth-source', { network: {} }),
      capabilities: { auth: { kind: 'oauth' } },
    }),
    'provider_authorization',
  );
  assert.equal(classifyConnectorSetupModality('notion', manifest('notion', { network: {} })), 'unsupported');
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
