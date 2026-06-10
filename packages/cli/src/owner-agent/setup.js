// Owner-agent connection setup planning for the `pdpp owner-agent setup` and
// `pdpp owner-agent connectors` subcommands.
//
// A trusted local owner agent (or a human at the CLI) needs the SAME
// non-secret setup plan and next-step contract that the console add-connection
// flow and the owner-agent REST route surface. This module is a thin consumer
// of the server's `GET /v1/owner/connector-templates` and
// `POST /v1/owner/connections/intents` routes — it does not re-classify
// connectors, invent modalities, or maintain a supported-connector list. The
// server's connection setup planner is the single source of truth; the CLI only
// formats what the planner returns.
//
// Secret boundary (design.md Decision 5, "agent help is allowed; agent-held
// secrets are not"): the owner bearer is read from the stored credential and
// sent ONLY as an `Authorization: Bearer` header. It is never printed. The
// route response carries no provider credentials, owner cookies, browser
// cookies, or grant-scoped MCP bearers; it may carry an owner-openable
// enrollment code and route names, which are setup material, not secrets.

import { OwnerAgentError } from './errors.js';
import { getOwnerAgentAccessToken } from './lifecycle.js';

/**
 * Request an owner-mediated connection setup plan from the reference's
 * owner-agent intent route. Sends the owner bearer only as an Authorization
 * header and returns the parsed (non-secret) intent body.
 *
 * @param {object} args
 * @param {typeof fetch} args.fetchFn
 * @param {object} args.record         stored owner-agent credential record
 * @param {string} args.connectorId    connector id/key the owner wants to add
 * @param {string|null} [args.displayName]  optional owner-meaningful label
 * @returns {Promise<object>} the parsed `owner_connection_intent` body
 */
export async function requestConnectionSetupPlan({ fetchFn, record, connectorId, displayName }) {
  const token = getOwnerAgentAccessToken(record);
  if (!token) {
    throw new OwnerAgentError('credential_invalid', 'Stored credential is missing an access token.');
  }
  const resource = typeof record?.resource === 'string' ? record.resource.replace(/\/$/, '') : null;
  if (!resource) {
    throw new OwnerAgentError(
      'credential_invalid',
      'Stored credential has no resource origin; re-run `pdpp owner-agent onboard`.'
    );
  }
  const trimmedConnector = typeof connectorId === 'string' ? connectorId.trim() : '';
  if (!trimmedConnector) {
    throw new OwnerAgentError(
      'invalid_request',
      'Usage: pdpp owner-agent setup <connector-id> [--display-name <name>]',
      64
    );
  }

  const body = { connector_id: trimmedConnector };
  const trimmedDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
  if (trimmedDisplayName) {
    body.display_name = trimmedDisplayName;
  }

  const url = `${resource}/v1/owner/connections/intents`;
  let response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new OwnerAgentError('setup_failed', `Failed to request setup plan from ${url}: ${error.message}.`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new OwnerAgentError(
      'setup_unauthorized',
      `Owner-agent setup is not authorized (HTTP ${response.status}). The credential may be revoked or inactive; run \`pdpp owner-agent status\`.`,
      4
    );
  }

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const code = json?.error?.code ?? json?.error ?? `http_${response.status}`;
    const message = json?.error?.message ?? json?.message ?? null;
    const detail = typeof message === 'string' && message.trim() ? `: ${message.trim()}` : '';
    throw new OwnerAgentError('setup_failed', `Setup plan request failed (${code})${detail}.`);
  }

  if (!json || typeof json !== 'object') {
    throw new OwnerAgentError('setup_failed', `Response from ${url} was not a valid setup plan.`);
  }
  return json;
}

export async function requestConnectorTemplates({ fetchFn, record }) {
  const token = getOwnerAgentAccessToken(record);
  if (!token) {
    throw new OwnerAgentError('credential_invalid', 'Stored credential is missing an access token.');
  }
  const resource = typeof record?.resource === 'string' ? record.resource.replace(/\/$/, '') : null;
  if (!resource) {
    throw new OwnerAgentError(
      'credential_invalid',
      'Stored credential has no resource origin; re-run `pdpp owner-agent onboard`.'
    );
  }
  const url = `${resource}/v1/owner/connector-templates`;
  let response;
  try {
    response = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    throw new OwnerAgentError('templates_failed', `Failed to request connector templates from ${url}: ${error.message}.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new OwnerAgentError(
      'setup_unauthorized',
      `Owner-agent connector discovery is not authorized (HTTP ${response.status}). The credential may be revoked or inactive; run \`pdpp owner-agent status\`.`,
      4
    );
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const code = json?.error?.code ?? json?.error ?? `http_${response.status}`;
    throw new OwnerAgentError('templates_failed', `Connector template request failed (${code}).`);
  }
  return Array.isArray(json?.data) ? json.data : [];
}

// Maps planner support state + next step to a concise, honest status label. The
// support state is the source of truth; next_step.kind only explains the owner's
// next action.
function describeSetupStatus(supportState, kind) {
  switch (supportState) {
    case 'supported':
      return { label: 'supported', summary: 'This setup path can start now.' };
    case 'proof_gated':
      return { label: 'proof-gated', summary: 'A setup path exists, but support is not flipped without live proof.' };
    case 'needs_deployment_config':
      return { label: 'deployment-blocked', summary: 'An instance-level prerequisite is missing.' };
    case 'unsupported':
      return { label: 'unsupported', summary: 'No reference setup path for this connector yet.' };
    default:
      return { label: kind ? `next-step:${kind}` : 'unknown', summary: 'See the next-step details below.' };
  }
}

// Field names that carry owner-openable setup material the agent may surface
// (codes, route names, URLs, expiries). Everything else in `next_step` is
// rendered generically. No field here is a provider/credential secret: the
// route never returns those.
const NEXT_STEP_DETAIL_KEYS = [
  ['enroll_endpoint', 'enroll endpoint'],
  ['enrollment_code', 'enrollment code'],
  ['local_binding_name', 'local binding name'],
  ['capture_endpoint', 'capture endpoint'],
  ['authorization_url', 'authorization url'],
  ['runbook_path', 'runbook'],
  ['expires_at', 'expires'],
];

/**
 * Format an `owner_connection_intent` setup plan into a non-secret,
 * token-efficient text report. Returns the string the command writes to stdout.
 * Renders the support label, modality, connection-active state, the primary
 * next step with its reason, and any owner-openable next-step details.
 */
export function formatConnectionSetupPlan(plan) {
  const connectorKey = plan?.connector_key ?? plan?.connector_id ?? '(unknown connector)';
  const connectorModality = plan?.connector_modality ?? 'unknown';
  const setupModality = plan?.setup_modality ?? 'unknown';
  const supportState = plan?.support_state ?? null;
  const nextStep = plan?.next_step && typeof plan.next_step === 'object' ? plan.next_step : {};
  const kind = typeof nextStep.kind === 'string' ? nextStep.kind : null;
  const status = describeSetupStatus(supportState, kind);
  const deployment = plan?.deployment_readiness && typeof plan.deployment_readiness === 'object'
    ? plan.deployment_readiness
    : null;

  const lines = [];
  lines.push(`Connection setup plan for ${connectorKey} (non-secret):`);
  lines.push(`  status: ${status.label} — ${status.summary}`);
  lines.push(`  setup modality: ${setupModality}`);
  lines.push(`  connector modality: ${connectorModality}`);
  lines.push(`  connection active: ${plan?.connection_active === true ? 'yes' : 'no (materializes when the owner step completes)'}`);
  if (deployment?.state && deployment.state !== 'not_applicable') {
    lines.push(`  deployment readiness: ${deployment.state}`);
  }
  lines.push('');
  lines.push(`  Next step: ${kind ?? '(none)'}`);
  if (typeof nextStep.reason === 'string' && nextStep.reason.trim()) {
    lines.push(`    ${nextStep.reason.trim()}`);
  }

  const detailLines = [];
  for (const [key, label] of NEXT_STEP_DETAIL_KEYS) {
    const value = nextStep[key];
    if (typeof value === 'string' && value.trim()) {
      detailLines.push(`    ${label}: ${value.trim()}`);
    }
  }
  if (detailLines.length > 0) {
    lines.push('');
    lines.push('  Details:');
    lines.push(...detailLines);
  }

  const blockers = Array.isArray(deployment?.blockers) ? deployment.blockers : [];
  if (blockers.length > 0) {
    lines.push('');
    lines.push('  Deployment blockers:');
    for (const blocker of blockers) {
      const label = typeof blocker?.label === 'string' && blocker.label.trim() ? blocker.label.trim() : blocker?.key;
      if (typeof label === 'string' && label.trim()) {
        lines.push(`    ${label.trim()}${blocker?.secret === true ? ' (secret)' : ''}`);
      }
    }
  }

  lines.push('');
  lines.push('  Note: provider secrets are captured only through owner-mediated flows;');
  lines.push('  this plan and the owner bearer are never exposed to /mcp or grant-scoped reads.');
  return `${lines.join('\n')}\n`;
}

function templateSupportStatus(template) {
  const setupPlan = template?.setup_plan && typeof template.setup_plan === 'object' ? template.setup_plan : null;
  if (typeof setupPlan?.support_state === 'string') {
    return setupPlan.support_state;
  }
  const actions = Array.isArray(template?.supported_actions) ? template.supported_actions : [];
  const initiate = actions.find((action) => action?.family === 'initiate_connection');
  return typeof initiate?.status === 'string' ? initiate.status : 'unknown';
}

function templateNextStep(template) {
  const setupPlan = template?.setup_plan && typeof template.setup_plan === 'object' ? template.setup_plan : null;
  if (typeof setupPlan?.next_step_kind === 'string') {
    return setupPlan.next_step_kind;
  }
  const actions = Array.isArray(template?.supported_actions) ? template.supported_actions : [];
  const initiate = actions.find((action) => action?.family === 'initiate_connection');
  return typeof initiate?.reason === 'string' ? initiate.reason : 'unknown';
}

function templateMatches(template, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    template?.display_name,
    template?.connector_id,
    template?.connector_key,
    template?.connector_modality,
    templateSupportStatus(template),
    templateNextStep(template),
  ]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function sortedTemplates(templates) {
  return [...templates].sort((left, right) => {
    const leftName = left?.display_name ?? left?.connector_key ?? '';
    const rightName = right?.display_name ?? right?.connector_key ?? '';
    return String(leftName).localeCompare(String(rightName));
  });
}

export function findConnectorTemplates(templates, query) {
  return sortedTemplates(templates).filter((template) => templateMatches(template, query));
}

export function formatConnectorTemplates(templates, { query = '' } = {}) {
  const rows = findConnectorTemplates(templates, query);
  const lines = [];
  lines.push(query ? `Connector setup catalog matching "${query}" (non-secret):` : 'Connector setup catalog (non-secret):');
  if (rows.length === 0) {
    lines.push('  (no matching connector templates)');
    return `${lines.join('\n')}\n`;
  }
  for (const template of rows) {
    const connectorKey = template?.connector_key ?? template?.connector_id ?? '(unknown)';
    const displayName = template?.display_name ?? connectorKey;
    const status = templateSupportStatus(template);
    const next = templateNextStep(template);
    const connectionCount = Number.isFinite(template?.connection_count) ? template.connection_count : 0;
    lines.push(`  - ${displayName}  connector=${connectorKey}  status=${status}  connections=${connectionCount}`);
    lines.push(`      next: ${next}`);
    lines.push(`      explain: pdpp owner-agent connectors explain ${connectorKey}`);
  }
  lines.push('');
  lines.push('  Start setup with: pdpp owner-agent setup <connector-id> [--display-name <name>]');
  lines.push('  Note: setup may mint short-lived enrollment material; explain/list/search are read-only.');
  return `${lines.join('\n')}\n`;
}

export function formatConnectorTemplateExplain(template) {
  if (!template) {
    throw new OwnerAgentError('not_found', 'No matching connector template found.', 1);
  }
  const connectorKey = template?.connector_key ?? template?.connector_id ?? '(unknown)';
  const displayName = template?.display_name ?? connectorKey;
  const setupPlan = template?.setup_plan && typeof template.setup_plan === 'object' ? template.setup_plan : {};
  const lines = [];
  lines.push(`Connector setup preview for ${displayName} (${connectorKey}) — non-secret, read-only:`);
  lines.push(`  status: ${templateSupportStatus(template)}`);
  lines.push(`  connector modality: ${template?.connector_modality ?? 'unknown'}`);
  lines.push(`  setup modality: ${setupPlan.setup_modality ?? 'unknown'}`);
  lines.push(`  next step: ${templateNextStep(template)}`);
  if (setupPlan.proof_gate) {
    lines.push(`  proof gate: ${setupPlan.proof_gate}`);
  }
  if (setupPlan.runbook_path) {
    lines.push(`  runbook: ${setupPlan.runbook_path}`);
  }
  const blockers = Array.isArray(setupPlan.deployment_readiness?.blockers)
    ? setupPlan.deployment_readiness.blockers
    : [];
  if (blockers.length > 0) {
    lines.push('  deployment blockers:');
    for (const blocker of blockers) {
      const label = typeof blocker?.label === 'string' ? blocker.label : blocker?.key;
      if (label) {
        lines.push(`    ${label}${blocker?.secret === true ? ' (secret)' : ''}`);
      }
    }
  }
  const connections = Array.isArray(template?.connections) ? template.connections : [];
  lines.push(`  existing connections: ${connections.length}`);
  for (const connection of connections) {
    const connectionId = connection?.connection_id ?? connection?.connector_instance_id ?? '(no connection_id)';
    const display = typeof connection?.display_name === 'string' && connection.display_name.trim()
      ? ` "${connection.display_name.trim()}"`
      : '';
    lines.push(`    - ${connectionId}${display}`);
  }
  lines.push('');
  lines.push(`  Start setup: pdpp owner-agent setup ${connectorKey} --display-name "<name>"`);
  lines.push('  Repeat setup with another display name to add another account when this connector supports it.');
  lines.push('  This preview did not mint enrollment codes, provider secrets, owner cookies, or grant-scoped MCP bearers.');
  return `${lines.join('\n')}\n`;
}
