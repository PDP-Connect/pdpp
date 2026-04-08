/**
 * PDPP Authorization Server — grant issuance + token management
 *
 * Simplified AS for demo purposes:
 * - No real OAuth flow; uses a simple device-code-style PIN exchange
 * - Issues opaque bearer tokens (random strings)
 * - Implements RFC 7662-style introspection with PDPP extensions
 */
import { randomBytes } from 'crypto';
import { getDb, sql } from './db.js';

function generateToken() {
  return randomBytes(32).toString('hex');
}

function generateId(prefix = 'id') {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

// Pending consent requests (in-memory; for demo)
const pendingConsent = new Map(); // device_code -> { grant_params, approved: false, grant_id? }

/**
 * Register or update a connector manifest
 */
export async function registerConnector(manifest) {
  const db = getDb();
  await db.query(sql`
    INSERT INTO connectors(connector_id, manifest)
    VALUES(${manifest.connector_id}, ${JSON.stringify(manifest)})
    ON CONFLICT(connector_id) DO UPDATE SET manifest = excluded.manifest
  `);
  return manifest.connector_id;
}

/**
 * Get manifest by connector_id
 */
export async function getManifest(connectorId) {
  const db = getDb();
  const rows = await db.query(sql`
    SELECT manifest FROM connectors WHERE connector_id = ${connectorId}
  `);
  if (!rows.length) return null;
  return JSON.parse(rows[0].manifest);
}

/**
 * Initiate a grant request (device-code-style).
 * Returns { device_code, user_code, verification_uri, expires_in }
 */
export async function initiateGrant(params) {
  const deviceCode = generateId('dc');
  const userCode = randomBytes(3).toString('hex').toUpperCase();

  pendingConsent.set(deviceCode, {
    params,
    userCode,
    approved: false,
    grantId: null,
    createdAt: Date.now(),
  });

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `http://localhost:7662/consent/${deviceCode}`,
    expires_in: 300,
  };
}

/**
 * Get pending consent request for display in consent UI
 */
export function getPendingConsent(deviceCode) {
  return pendingConsent.get(deviceCode) || null;
}

/**
 * Approve a pending grant request — creates the grant and access token
 * Called by the consent UI (or auto-approved in demo mode)
 */
export async function approveGrant(deviceCode, subjectId = 'user_demo', opts = {}) {
  const pending = pendingConsent.get(deviceCode);
  if (!pending) throw new Error('Unknown device code');

  const db = getDb();
  const params = pending.params;

  // The AS MUST obtain explicit affirmative consent before issuing ai_training grants.
  const { ai_training_consented } = opts;
  if (params.purpose_code === 'https://pdpp.org/purpose/ai_training' && !ai_training_consented) {
    throw new Error('Explicit affirmative consent required for ai_training purpose');
  }

  // Resolve manifest for validation
  const manifest = await getManifest(params.connector_id);
  if (!manifest) throw new Error(`Unknown connector: ${params.connector_id}`);

  // Expand wildcards and validate streams
  let streams = params.streams || [];
  if (streams.length === 1 && streams[0].name === '*') {
    streams = manifest.streams.map(s => ({ name: s.name }));
  }

  // Validate streams against manifest + resolve views → fields
  const resolvedStreams = streams.map(sr => {
    const mStream = manifest.streams.find(s => s.name === sr.name);
    if (!mStream) throw new Error(`Unknown stream: ${sr.name}`);

    // Validate time_range requires consent_time_field
    if (sr.time_range && !mStream.consent_time_field) {
      throw new Error(`Stream '${sr.name}' does not support time_range (no consent_time_field)`);
    }

    // Resolve view → fields
    const sg = { name: sr.name };
    if (sr.view) {
      const viewDef = (mStream.views || []).find(v => v.id === sr.view);
      if (!viewDef) throw new Error(`Unknown view '${sr.view}' on stream '${sr.name}'`);
      sg.view = sr.view;
      sg.fields = viewDef.fields;
    } else if (sr.fields) {
      sg.fields = sr.fields;
    }
    if (sr.time_range) sg.time_range = sr.time_range;
    if (sr.resources) sg.resources = sr.resources;
    return sg;
  });

  const grantId = generateId('grt');
  const issuedAt = nowIso();
  const expiresAt = params.access_mode === 'single_use'
    ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24h for demo
    : (params.expires_at || null);

  const grant = {
    version: '0.1.0',
    grant_id: grantId,
    issued_at: issuedAt,
    subject: { id: subjectId },
    client: { client_id: params.client_id || 'demo_client' },
    connector_id: params.connector_id,
    manifest_version: manifest.version,
    purpose_code: params.purpose_code,
    purpose_description: params.purpose_description,
    access_mode: params.access_mode,
    streams: resolvedStreams,
    retention: params.retention,
    expires_at: expiresAt,
  };

  await db.query(sql`
    INSERT INTO grants(grant_id, subject_id, client_id, connector_id, grant_json, access_mode, issued_at, expires_at)
    VALUES(
      ${grantId},
      ${subjectId},
      ${params.client_id || 'demo_client'},
      ${params.connector_id},
      ${JSON.stringify(grant)},
      ${params.access_mode},
      ${issuedAt},
      ${expiresAt}
    )
  `);

  // Issue access token
  const token = await issueToken(grantId, subjectId, params.client_id || 'demo_client', expiresAt);

  pending.approved = true;
  pending.grantId = grantId;
  pending.token = token;

  return { grant, token };
}

/**
 * Poll for grant approval — returns token if approved
 */
export function pollGrant(deviceCode) {
  const pending = pendingConsent.get(deviceCode);
  if (!pending) return { status: 'expired' };
  if (!pending.approved) return { status: 'pending' };
  return { status: 'approved', token: pending.token, grant_id: pending.grantId };
}

/**
 * Issue an access token bound to a grant
 */
export async function issueToken(grantId, subjectId, clientId, expiresAt) {
  const db = getDb();
  const tokenId = generateToken();

  // Note: single_use grants are marked consumed after the first successful RS query,
  // not at token issuance — so the token is valid for exactly one query.

  await db.query(sql`
    INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
    VALUES(${tokenId}, ${grantId}, ${subjectId}, ${clientId}, 'client', ${expiresAt})
  `);

  return tokenId;
}

/**
 * Issue an owner token for a subject
 * Note: single_use grants are marked consumed after the first successful RS query (not at token issuance)
 */
export async function issueOwnerToken(subjectId) {
  const db = getDb();
  const tokenId = generateToken();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await db.query(sql`
    INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
    VALUES(${tokenId}, NULL, ${subjectId}, NULL, 'owner', ${expiresAt})
  `);
  return tokenId;
}

/**
 * RFC 7662-style introspection with PDPP extensions
 */
export async function introspect(token) {
  const db = getDb();
  const rows = await db.query(sql`
    SELECT t.token_id, t.grant_id, t.subject_id, t.client_id, t.token_kind, t.expires_at, t.revoked,
           g.status as grant_status, g.grant_json
    FROM tokens t
    LEFT JOIN grants g ON t.grant_id = g.grant_id
    WHERE t.token_id = ${token}
  `);

  if (!rows.length) return { active: false };

  const row = rows[0];

  if (row.revoked) return { active: false };

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { active: false };
  }

  // Check grant still active (for client tokens)
  if (row.token_kind === 'client' && row.grant_status !== 'active') {
    return { active: false };
  }

  // For single_use grants, reject if already consumed
  if (row.token_kind === 'client') {
    const grantRows = await db.query(sql`
      SELECT access_mode, consumed FROM grants WHERE grant_id = ${row.grant_id}
    `);
    if (grantRows.length && grantRows[0].access_mode === 'single_use' && grantRows[0].consumed) {
      return { active: false };
    }
  }

  const result = {
    active: true,
    pdpp_token_kind: row.token_kind,
    subject_id: row.subject_id,
    exp: row.expires_at ? Math.floor(new Date(row.expires_at).getTime() / 1000) : null,
  };

  if (row.token_kind === 'client') {
    result.grant_id = row.grant_id;
    result.client_id = row.client_id;
    result.grant = JSON.parse(row.grant_json);
  }

  return result;
}

/**
 * Revoke a grant
 */
export async function revokeGrant(grantId) {
  const db = getDb();
  await db.query(sql`UPDATE grants SET status = 'revoked' WHERE grant_id = ${grantId}`);
  // Also revoke all tokens for this grant
  await db.query(sql`UPDATE tokens SET revoked = 1 WHERE grant_id = ${grantId}`);
}
