/**
 * PDPP Personal Server
 *
 * Combined AS + RS implementing PDPP v0.1.0 core spec.
 * Starts on port 7662 (AS/introspection) and 7663 (RS query API).
 */
import express from 'express';
import { initDb } from './db.js';
import {
  registerConnector, getManifest, initiateGrant, getPendingConsent,
  approveGrant, pollGrant, introspect, issueOwnerToken, revokeGrant, denyGrant, issueGrantToken,
} from './auth.js';
import {
  ingestRecord, queryRecords, getRecord, deleteRecord, deleteAllRecords,
  listStreams, listAllStreams, getSyncState, putSyncState,
} from './records.js';

const AS_PORT = parseInt(process.env.AS_PORT || '7662');
const RS_PORT = parseInt(process.env.RS_PORT || '7663');
const DB_PATH = process.env.PDPP_DB_PATH || process.env.DB_PATH || ':memory:';

// ─── Helpers ────────────────────────────────────────────────────────────────

function pdppError(res, status, code, message, param = null) {
  const body = { error: { type: typeFor(status), code, message } };
  if (param) body.error.param = param;
  body.error.request_id = `req_${Date.now()}`;
  res.status(status).json(body);
}

function typeFor(status) {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 410) return 'gone_error';
  if (status === 429) return 'rate_limit_error';
  return 'api_error';
}

const codeToStatus = {
  grant_stream_not_allowed: 403,
  grant_time_range_exceeded: 403,
  grant_expired: 403,
  grant_revoked: 403,
  grant_consumed: 403,
  grant_invalid: 403,
  field_not_granted: 403,
  insufficient_scope: 403,
  invalid_cursor: 400,
  invalid_request: 400,
  invalid_record: 400,
  invalid_record_identity: 400,
  invalid_expand: 400,
  unknown_field: 400,
  unsupported_version: 400,
  authentication_error: 401,
  blob_not_found: 404,
  not_found: 404,
  cursor_expired: 410,
};

function handleError(res, err) {
  const code = err.code || 'api_error';
  const status = codeToStatus[code] || 500;
  pdppError(res, status, code, err.message);
}

// ─── Auth middleware ─────────────────────────────────────────────────────────

async function requireToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return pdppError(res, 401, 'authentication_error', 'Missing Bearer token');
  }
  const token = auth.slice(7);
  const info = await introspect(token);
  if (!info.active) {
    if (info.inactive_reason === 'grant_revoked') {
      return pdppError(res, 403, 'grant_revoked', 'Grant has been revoked');
    }
    if (info.inactive_reason === 'grant_expired') {
      return pdppError(res, 403, 'grant_expired', 'Grant has expired');
    }
    return pdppError(res, 401, 'authentication_error', 'Invalid or expired token');
  }
  req.tokenInfo = info;
  next();
}

function requireOwner(req, res, next) {
  if (req.tokenInfo.pdpp_token_kind !== 'owner') {
    return pdppError(res, 403, 'permission_error', 'Owner token required');
  }
  next();
}

function requireClient(req, res, next) {
  if (req.tokenInfo.pdpp_token_kind !== 'client') {
    return pdppError(res, 403, 'permission_error', 'Client token required');
  }
  next();
}

// ─── AS App ─────────────────────────────────────────────────────────────────

function buildAsApp() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.setHeader('Request-Id', `req_${Date.now()}`);
    next();
  });

  // RFC 7662-style token introspection with PDPP extensions
  app.post('/introspect', async (req, res) => {
    const token = req.body.token;
    if (!token) return pdppError(res, 400, 'invalid_request', 'Missing token parameter');
    const info = await introspect(token);
    res.json(info);
  });

  // Register a connector manifest
  app.post('/connectors', async (req, res) => {
    try {
      const manifest = req.body;
      if (!manifest.connector_id) return pdppError(res, 400, 'invalid_request', 'Missing connector_id');
      await registerConnector(manifest);
      res.status(201).json({ connector_id: manifest.connector_id });
    } catch (err) {
      handleError(res, err);
    }
  });

  // Get manifest
  app.get('/connectors/:connectorId', async (req, res) => {
    const manifest = await getManifest(decodeURIComponent(req.params.connectorId));
    if (!manifest) return pdppError(res, 404, 'not_found', 'Connector not found');
    res.json(manifest);
  });

  // Initiate grant request (device code style)
  app.post('/grants/initiate', async (req, res) => {
    try {
      const result = await initiateGrant(req.body, {
        baseUrl: `${req.protocol}://${req.get('host')}`,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Consent UI — show pending consent
  app.get('/consent/:deviceCode', async (req, res) => {
    const pending = getPendingConsent(req.params.deviceCode);
    if (!pending) return res.status(404).send('Not found');
    const params = pending.params;
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>PDPP Consent</title><style>
        body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px; }
        .grant-box { border: 1px solid #ccc; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .stream { background: #f5f5f5; padding: 8px 12px; border-radius: 4px; margin: 4px 0; font-family: monospace; }
        button { padding: 10px 24px; font-size: 16px; cursor: pointer; border-radius: 6px; border: none; }
        .approve { background: #2563eb; color: white; }
        .deny { background: #dc2626; color: white; margin-left: 10px; }
        .code { font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #2563eb; }
      </style></head>
      <body>
        <h1>PDPP Data Access Request</h1>
        <p class="code">${pending.userCode}</p>
        <div class="grant-box">
          <p><strong>App:</strong> ${params.client_id || 'Demo Client'}</p>
          <p><strong>Connector:</strong> ${params.connector_id}</p>
          <p><strong>Purpose:</strong> ${params.purpose_description || params.purpose_code}</p>
          <p><strong>Access Mode:</strong> ${params.access_mode}</p>
          ${params.retention ? `<p><strong>Retention:</strong> ${params.retention.on_expiry} after ${params.retention.max_duration}</p>` : ''}
          <p><strong>Streams requested:</strong></p>
          ${(params.streams || []).map(s => `
            <div class="stream">
              ${s.name}
              ${s.time_range ? ` (since ${s.time_range.since || 'any'})` : ''}
              ${s.fields ? ` [fields: ${s.fields.join(', ')}]` : ''}
              ${s.view ? ` [view: ${s.view}]` : ''}
              ${s.necessity === 'optional' ? ' (optional)' : ''}
            </div>
          `).join('')}
        </div>
        <form method="POST" action="/consent/${req.params.deviceCode}/approve">
          <button type="submit" class="approve">Approve</button>
        </form>
        <form method="POST" action="/consent/${req.params.deviceCode}/deny" style="display:inline">
          <button type="submit" class="deny">Deny</button>
        </form>
      </body>
      </html>
    `);
  });

  // Auto-approve for demo (accepts subject_id param)
  app.post('/consent/:deviceCode/approve', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const subjectId = req.body?.subject_id || req.query?.subject_id || 'user_demo';
      const { grant, token } = await approveGrant(req.params.deviceCode, subjectId);
      res.send(`
        <html><body>
        <h2>✓ Access Approved</h2>
        <p>Grant ID: <code>${grant.grant_id}</code></p>
        <p>Token (copy to use with RS): <code>${token}</code></p>
        </body></html>
      `);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/consent/:deviceCode/deny', (req, res) => {
    const deleted = denyGrant(req.params.deviceCode);
    if (!deleted) return pdppError(res, 404, 'not_found', 'Pending consent request not found');
    res.send(`
      <html><body>
      <h2>Access Denied</h2>
      <p>The pending data access request was rejected and cleared.</p>
      </body></html>
    `);
  });

  // API auto-approve (for programmatic demo use)
  app.post('/consent/:deviceCode/approve-api', async (req, res) => {
    try {
      const subjectId = req.body?.subject_id || 'user_demo';
      const opts = { ai_training_consented: req.body?.ai_training_consented };
      const result = await approveGrant(req.params.deviceCode, subjectId, opts);
      res.json({ grant_id: result.grant.grant_id, token: result.token, grant: result.grant });
    } catch (err) {
      handleError(res, err);
    }
  });

  // Poll for grant status
  app.get('/grants/poll/:deviceCode', (req, res) => {
    const result = pollGrant(req.params.deviceCode);
    res.json(result);
  });

  // Issue owner token (demo endpoint — in prod this would be a real auth flow)
  app.post('/owner-token', async (req, res) => {
    const subjectId = req.body?.subject_id || 'user_demo';
    const token = await issueOwnerToken(subjectId);
    res.json({ token, subject_id: subjectId, pdpp_token_kind: 'owner' });
  });

  // Revoke grant
  app.post('/grants/:grantId/revoke', async (req, res) => {
    await revokeGrant(req.params.grantId);
    res.json({ revoked: true });
  });

  // Demo/admin helper: issue another client token for an existing grant.
  app.post('/grants/:grantId/tokens', async (req, res) => {
    try {
      const token = await issueGrantToken(req.params.grantId);
      res.status(201).json({ grant_id: req.params.grantId, token });
    } catch (err) {
      handleError(res, err);
    }
  });

  return app;
}

// ─── RS App ─────────────────────────────────────────────────────────────────

function buildRsApp() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.setHeader('Request-Id', `req_${Date.now()}`);
    // PDPP-Version negotiation
    const requestedVersion = req.headers['pdpp-version'];
    const CURRENT_VERSION = '2026-04-06';
    if (requestedVersion && requestedVersion !== CURRENT_VERSION) {
      return pdppError(res, 400, 'unsupported_version',
        `PDPP-Version '${requestedVersion}' is not supported. Current: ${CURRENT_VERSION}`);
    }
    res.setHeader('PDPP-Version', CURRENT_VERSION);
    next();
  });

  // GET /v1/streams — list streams (client or owner)
  app.get('/v1/streams', requireToken, async (req, res) => {
    try {
      const { tokenInfo } = req;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        const connectorId = req.query.connector_id;
        if (!connectorId) return pdppError(res, 400, 'invalid_request', 'connector_id required');
        const streams = await listAllStreams(connectorId);
        return res.json({ object: 'list', data: streams });
      }
      const grant = tokenInfo.grant;
      const streams = await listStreams(grant.connector_id, grant);
      res.json({ object: 'list', data: streams });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream — stream metadata
  app.get('/v1/streams/:stream', requireToken, async (req, res) => {
    try {
      const { tokenInfo } = req;
      const grant = tokenInfo.grant;
      const connectorId = grant?.connector_id || req.query.connector_id;
      if (!connectorId) return pdppError(res, 400, 'invalid_request', 'connector_id required for owner access');
      const manifest = await getManifest(connectorId);
      const mStream = manifest?.streams?.find(s => s.name === req.params.stream);
      if (!mStream) return pdppError(res, 404, 'not_found', `Stream '${req.params.stream}' not found`);

      res.json({
        object: 'stream_metadata',
        name: mStream.name,
        semantics: mStream.semantics,
        schema: mStream.schema,
        primary_key: mStream.primary_key,
        cursor_field: mStream.cursor_field,
        consent_time_field: mStream.consent_time_field,
        selection: mStream.selection,
        views: mStream.views || [],
        relationships: mStream.relationships || [],
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream/records
  app.get('/v1/streams/:stream/records', requireToken, async (req, res) => {
    try {
      const { tokenInfo } = req;

      // View and fields mutual exclusion
      if (req.query.view && req.query.fields) {
        return pdppError(res, 400, 'invalid_request', 'view and fields are mutually exclusive');
      }

      let grant = tokenInfo.grant;
      let connectorId;

      if (tokenInfo.pdpp_token_kind === 'owner') {
        // Self-export: owner can query without a client grant
        connectorId = req.query.connector_id;
        if (!connectorId) return pdppError(res, 400, 'invalid_request', 'connector_id required');
        // Synthesize a full-access grant
        const manifest = await getManifest(connectorId);
        if (!manifest) return pdppError(res, 404, 'not_found', 'Connector not found');
        const mStream = manifest.streams.find(s => s.name === req.params.stream);
        if (!mStream) return pdppError(res, 404, 'not_found', `Stream '${req.params.stream}' not found`);
        grant = {
          connector_id: connectorId,
          streams: [{ name: req.params.stream }],
        };
      } else {
        connectorId = grant.connector_id;
      }

      const manifest = await getManifest(connectorId);

      // Resolve view to fields if requested
      const requestParams = { ...req.query };
      if (req.query.view && !req.query.fields) {
        const mStream = manifest?.streams?.find(s => s.name === req.params.stream);
        const viewDef = (mStream?.views || []).find(v => v.id === req.query.view);
        if (!viewDef) return pdppError(res, 400, 'invalid_request', `Unknown view: ${req.query.view}`);
        // Check view is within grant fields
        const streamGrant = grant.streams.find(s => s.name === req.params.stream);
        if (streamGrant?.fields) {
          const unauthorized = viewDef.fields.filter(f => !streamGrant.fields.includes(f));
          if (unauthorized.length) {
            return pdppError(res, 403, 'field_not_granted', `View includes fields not in grant: ${unauthorized.join(', ')}`);
          }
        }
        requestParams.fields = viewDef.fields;
        delete requestParams.view;
      }

      const result = await queryRecords(connectorId, req.params.stream, grant, requestParams, manifest);

      res.json({ ...result, url: req.path });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /v1/streams/:stream/records/:id
  app.get('/v1/streams/:stream/records/:id', requireToken, async (req, res) => {
    try {
      const { tokenInfo } = req;
      let grant = tokenInfo.grant;
      let connectorId = grant?.connector_id || req.query.connector_id;
      if (tokenInfo.pdpp_token_kind === 'owner') {
        if (!connectorId) return pdppError(res, 400, 'invalid_request', 'connector_id required');
        grant = {
          connector_id: connectorId,
          streams: [{ name: req.params.stream }],
        };
      }
      const manifest = await getManifest(connectorId);
      const record = await getRecord(connectorId, req.params.stream,
        decodeURIComponent(req.params.id), grant, manifest);
      res.json(record);
    } catch (err) {
      handleError(res, err);
    }
  });

  // DELETE /v1/streams/:stream/records (owner-authenticated, demo reset — clears all records for a stream)
  app.delete('/v1/streams/:stream/records', requireToken, requireOwner, async (req, res) => {
    try {
      const connectorId = req.query.connector_id;
      if (!connectorId) return pdppError(res, 400, 'invalid_request', 'connector_id required');
      await deleteAllRecords(connectorId, req.params.stream);
      res.status(204).end();
    } catch (err) {
      handleError(res, err);
    }
  });

  // DELETE /v1/streams/:stream/records/:id (owner-authenticated)
  app.delete('/v1/streams/:stream/records/:id', requireToken, requireOwner, async (req, res) => {
    try {
      const connectorId = req.query.connector_id;
      if (!connectorId) return pdppError(res, 400, 'invalid_request', 'connector_id required');
      await deleteRecord(connectorId, req.params.stream, decodeURIComponent(req.params.id));
      res.status(204).end();
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /v1/ingest/:stream (Collection Profile, owner-authenticated)
  app.post('/v1/ingest/:stream', requireToken, requireOwner, express.text({ type: 'application/x-ndjson', limit: '10mb' }), async (req, res) => {
    try {
      const connectorId = req.query.connector_id;
      if (!connectorId) return pdppError(res, 400, 'invalid_request', 'connector_id required');

      const lines = (req.body || '').split('\n').filter(l => l.trim());
      let accepted = 0, rejected = 0;
      const errors = [];

      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          await ingestRecord(connectorId, { ...record, stream: req.params.stream });
          accepted++;
        } catch (e) {
          rejected++;
          errors.push(e.message);
        }
      }

      res.json({ stream: req.params.stream, records_accepted: accepted, records_rejected: rejected, errors });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /v1/state/:connectorId (Collection Profile, owner-authenticated)
  app.get('/v1/state/:connectorId', requireToken, requireOwner, async (req, res) => {
    try {
      const state = await getSyncState(decodeURIComponent(req.params.connectorId));
      res.json(state);
    } catch (err) {
      handleError(res, err);
    }
  });

  // PUT /v1/state/:connectorId (Collection Profile, owner-authenticated)
  app.put('/v1/state/:connectorId', requireToken, requireOwner, async (req, res) => {
    try {
      const state = await putSyncState(decodeURIComponent(req.params.connectorId), req.body.state || {});
      res.json(state);
    } catch (err) {
      handleError(res, err);
    }
  });

  return app;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function startServer(opts = {}) {
  await initDb(opts.dbPath || DB_PATH);
  console.error('[PDPP] Database initialized');

  const asApp = buildAsApp();
  const rsApp = buildRsApp();

  const asPort = opts.asPort || AS_PORT;
  const rsPort = opts.rsPort || RS_PORT;

  return new Promise((resolve) => {
    const asServer = asApp.listen(asPort, () => {
      console.error(`[PDPP AS] Authorization server on http://localhost:${asPort}`);
      const rsServer = rsApp.listen(rsPort, () => {
        console.error(`[PDPP RS] Resource server on http://localhost:${rsPort}`);
        resolve({ asServer, rsServer, asPort, rsPort });
      });
    });
  });
}

// Run directly
if (process.argv[1] && process.argv[1].endsWith('server/index.js')) {
  startServer().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
