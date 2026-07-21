/**
 * Reference-local example third-party client app.
 *
 * What this is:
 * - a small Node + Express app that demonstrates the *current* thin PDPP
 *   reference provider-connect flow, end to end
 * - scoped to run against a local reference AS + RS (defaults:
 *   AS http://localhost:7662, RS http://localhost:7663)
 * - uses only the existing public reference endpoints:
 *     POST /oauth/register, POST /oauth/par, POST /consent/approve (inline
 *     JSON shortcut), GET /consent (hosted approval page), POST /introspect,
 *     GET {rs}/v1/streams, GET {rs}/v1/streams/:stream/records
 *
 * What this is NOT:
 * - not a generic OAuth authorization-code redirect client
 * - not a PKCE / code-exchange client
 * - not the PDPP server UI; this is a third-party client illustration
 *
 * In-memory single-session state keeps the reference demo obvious. Restart
 * the process to start over.
 */
import express from 'express';
import {
  registerClient,
  buildParRequest,
  stageParRequest,
  buildHostedApprovalUrl,
  approveInline,
  denyInline,
  introspectToken,
  queryStreams,
  queryStreamRecords,
} from './lib/flow.js';

const PORT = parseInt(process.env.PORT || '7674', 10);
const AS_URL = stripSlash(process.env.AS_URL || 'http://localhost:7662');
const RS_URL = stripSlash(process.env.RS_URL || 'http://localhost:7663');
const CLIENT_LABEL = process.env.CLIENT_LABEL || 'Reference Client (Longview)';

function stripSlash(value) {
  return value.replace(/\/+$/, '');
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Default draft values shipped with the example app. These match the
// reference Spotify connector manifest
// (`reference-implementation/manifests/spotify.json`) so a developer can run
// the example against a local reference stack (after registering that
// manifest) and stage a PAR request, approve it, and query records without
// having to edit the form. Exported so tests can prove the defaults remain
// usable when the example app ships.
export function buildDefaultDraft() {
  return {
    clientName: CLIENT_LABEL,
    initialAccessToken: '',
    sourceKind: 'connector',
    sourceId: 'https://registry.pdpp.org/connectors/spotify',
    streamName: 'top_artists',
    purposeCode: 'https://pdpp.org/purpose/personalization',
    purposeDescription: 'Recommend concerts based on your listening history.',
    accessMode: 'single_use',
    subjectId: 'owner_local',
    pastedToken: '',
    queryStream: '',
  };
}

// ───── In-memory demo state ─────
const state = {
  clientId: '',
  registeredClient: null,
  lastRegistrationError: null,
  stagedRequest: null,
  lastParError: null,
  tokenInfo: null,
  lastApprovalError: null,
  ownerAuthSuspected: false,
  introspection: null,
  lastIntrospectError: null,
  lastQuery: null,
  lastQueryError: null,
  draft: buildDefaultDraft(),
};

function updateDraft(body = {}) {
  for (const key of Object.keys(state.draft)) {
    if (typeof body[key] === 'string') {
      state.draft[key] = body[key].trim();
    }
  }
}

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PDPP Reference — Example Third-Party Client</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; color: #111; background: #f7f7f8; margin: 0; padding: 24px; }
  main { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px 0; }
  h2 { font-size: 16px; margin: 28px 0 8px 0; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .tag { display: inline-block; font-size: 11px; background: #eef; color: #225; padding: 2px 6px; border-radius: 3px; margin-right: 6px; }
  section { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
  form.inline { display: grid; grid-template-columns: 180px 1fr; gap: 8px 12px; align-items: center; }
  form.inline label { font-weight: 600; }
  form.inline input, form.inline textarea { padding: 4px 6px; border: 1px solid #bbb; border-radius: 3px; font: inherit; width: 100%; }
  form.actions { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: #225; color: #fff; border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font: inherit; }
  button.secondary { background: #777; }
  button.danger { background: #a33; }
  pre { background: #f0f0f2; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
  .muted { color: #666; }
  .err { color: #a33; white-space: pre-wrap; }
  .ok { color: #285; }
  code { background: #f0f0f2; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(CLIENT_LABEL)}</h1>
    <div class="muted">
      Reference-local example third-party client for PDPP. Demonstrates the current
      <strong>thin reference provider-connect flow</strong>: register &rarr; PAR &rarr; owner approval &rarr; token &rarr; RS query.
    </div>
    <div class="muted" style="margin-top: 6px;">
      This is <em>not</em> a generic OAuth authorization-code redirect client.
    </div>
  </header>

  <section>
    <h2><span class="tag">1</span>App setup</h2>
    <div><strong>AS:</strong> <code>${escapeHtml(AS_URL)}</code></div>
    <div><strong>RS:</strong> <code>${escapeHtml(RS_URL)}</code></div>
    <div style="margin-top: 6px;"><strong>Client ID:</strong> ${state.clientId ? `<code>${escapeHtml(state.clientId)}</code>` : '<span class="muted">(not yet registered)</span>'}</div>
    ${state.registeredClient ? `<details><summary>Registered client metadata</summary><pre>${escapeHtml(JSON.stringify(state.registeredClient, null, 2))}</pre></details>` : ''}
    ${state.lastRegistrationError ? `<div class="err">${escapeHtml(state.lastRegistrationError)}</div>` : ''}

    <form method="post" action="/register" class="inline" style="margin-top: 12px;">
      <label for="clientName">client_name</label>
      <input id="clientName" name="clientName" value="${escapeHtml(state.draft.clientName)}" />
      <label for="initialAccessToken">initial access token (optional)</label>
      <input id="initialAccessToken" name="initialAccessToken" value="${escapeHtml(state.draft.initialAccessToken)}" />
      <div></div>
      <div class="actions">
        <button type="submit">Dynamically register client</button>
      </div>
    </form>
  </section>

  <section>
    <h2><span class="tag">2</span>Request staging (PAR)</h2>
    <form method="post" action="/par" class="inline">
      <label for="sourceKind">source.kind</label>
      <input id="sourceKind" name="sourceKind" value="${escapeHtml(state.draft.sourceKind)}" />
      <label for="sourceId">source.id</label>
      <input id="sourceId" name="sourceId" value="${escapeHtml(state.draft.sourceId)}" />
      <label for="streamName">stream name</label>
      <input id="streamName" name="streamName" value="${escapeHtml(state.draft.streamName)}" />
      <label for="purposeCode">purpose_code</label>
      <input id="purposeCode" name="purposeCode" value="${escapeHtml(state.draft.purposeCode)}" />
      <label for="purposeDescription">purpose_description</label>
      <input id="purposeDescription" name="purposeDescription" value="${escapeHtml(state.draft.purposeDescription)}" />
      <label for="accessMode">access_mode</label>
      <input id="accessMode" name="accessMode" value="${escapeHtml(state.draft.accessMode)}" />
      <div></div>
      <div class="actions">
        <button type="submit">Stage PAR request</button>
      </div>
    </form>
    ${state.lastParError ? `<div class="err" style="margin-top: 10px;">${escapeHtml(state.lastParError)}</div>` : ''}
    ${state.stagedRequest ? `
      <div style="margin-top: 10px;">
        <div><strong>request_uri:</strong> <code>${escapeHtml(state.stagedRequest.request_uri || '')}</code></div>
        ${state.stagedRequest.authorization_url ? `<div><strong>authorization_url:</strong> <code>${escapeHtml(state.stagedRequest.authorization_url)}</code></div>` : ''}
        <details><summary>Full PAR response</summary><pre>${escapeHtml(JSON.stringify(state.stagedRequest, null, 2))}</pre></details>
      </div>
    ` : ''}
  </section>

  <section>
    <h2><span class="tag">3</span>Owner approval</h2>
    ${state.stagedRequest?.request_uri ? `
      <div>
        <a href="${escapeHtml(buildHostedApprovalUrl({ asUrl: AS_URL, requestUri: state.stagedRequest.request_uri }))}" target="_blank" rel="noopener noreferrer">Open hosted consent page &rarr;</a>
        <div class="muted">Use this path when the reference server has <code>PDPP_OWNER_PASSWORD</code> set — the hosted page is the authoritative approval surface.</div>
      </div>
      <form method="post" action="/approve" class="inline" style="margin-top: 12px;">
        <label for="subjectId">subject_id</label>
        <input id="subjectId" name="subjectId" value="${escapeHtml(state.draft.subjectId)}" />
        <div></div>
        <div class="actions">
          <button type="submit">Inline approve (reference-local shortcut)</button>
          <button type="submit" formaction="/deny" class="danger">Inline deny</button>
        </div>
      </form>
      ${state.ownerAuthSuspected ? `<div class="muted" style="margin-top: 8px;">Inline approval is unavailable because owner authentication is enabled. Use the hosted page above, then paste the issued token below.</div>` : ''}
      ${state.lastApprovalError ? `<div class="err" style="margin-top: 8px;">${escapeHtml(state.lastApprovalError)}</div>` : ''}
    ` : '<div class="muted">Stage a PAR request first.</div>'}
  </section>

  <section>
    <h2><span class="tag">4</span>Token</h2>
    ${state.tokenInfo?.token ? `
      <div class="ok">Token acquired via <code>${escapeHtml(state.tokenInfo.source)}</code></div>
      <div style="margin-top: 6px;"><strong>access_token:</strong> <code>${escapeHtml(state.tokenInfo.token)}</code></div>
      ${state.tokenInfo.grantId ? `<div><strong>grant_id:</strong> <code>${escapeHtml(state.tokenInfo.grantId)}</code></div>` : ''}
      <details><summary>Issued grant snapshot</summary><pre>${escapeHtml(JSON.stringify(state.tokenInfo.grant || state.tokenInfo, null, 2))}</pre></details>
      <form method="post" action="/introspect" class="actions">
        <button type="submit" class="secondary">Introspect token</button>
      </form>
      ${state.introspection ? `<details open><summary>Introspection result</summary><pre>${escapeHtml(JSON.stringify(state.introspection, null, 2))}</pre></details>` : ''}
      ${state.lastIntrospectError ? `<div class="err">${escapeHtml(state.lastIntrospectError)}</div>` : ''}
    ` : '<div class="muted">No token yet. Approve the request above, or paste a token obtained from the hosted consent page.</div>'}

    <form method="post" action="/token/paste" class="inline" style="margin-top: 16px;">
      <label for="pastedToken">paste access_token</label>
      <input id="pastedToken" name="pastedToken" value="${escapeHtml(state.draft.pastedToken)}" placeholder="Paste a token issued by the hosted consent page" />
      <div></div>
      <div class="actions">
        <button type="submit" class="secondary">Use pasted token</button>
      </div>
    </form>
  </section>

  <section>
    <h2><span class="tag">5</span>Resource query</h2>
    ${state.tokenInfo?.token ? `
      <form method="post" action="/query/streams" class="actions">
        <button type="submit">List streams (GET /v1/streams)</button>
      </form>
      <form method="post" action="/query/records" class="inline" style="margin-top: 12px;">
        <label for="queryStream">stream name</label>
        <input id="queryStream" name="queryStream" value="${escapeHtml(state.draft.queryStream || state.draft.streamName)}" />
        <div></div>
        <div class="actions">
          <button type="submit">Query records (GET /v1/streams/:stream/records)</button>
        </div>
      </form>
      ${state.lastQueryError ? `<div class="err" style="margin-top: 10px;">${escapeHtml(state.lastQueryError)}</div>` : ''}
      ${state.lastQuery ? `<details open style="margin-top: 10px;"><summary>${escapeHtml(state.lastQuery.label)}</summary><pre>${escapeHtml(JSON.stringify(state.lastQuery.body, null, 2))}</pre></details>` : ''}
    ` : '<div class="muted">Acquire a token first.</div>'}
  </section>

  <section>
    <form method="post" action="/reset" class="actions">
      <button type="submit" class="danger">Reset demo state</button>
    </form>
  </section>
</main>
</body>
</html>`;
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderPage());
});

app.post('/register', async (req, res) => {
  updateDraft(req.body);
  state.lastRegistrationError = null;
  try {
    const registered = await registerClient({
      asUrl: AS_URL,
      initialAccessToken: state.draft.initialAccessToken,
      metadata: {
        client_name: state.draft.clientName,
        token_endpoint_auth_method: 'none',
      },
    });
    state.registeredClient = registered;
    state.clientId = registered.client_id;
  } catch (err) {
    state.lastRegistrationError = err.message || String(err);
  }
  res.redirect('/');
});

app.post('/par', async (req, res) => {
  updateDraft(req.body);
  state.lastParError = null;
  try {
    const request = buildParRequest({
      clientId: state.clientId,
      clientName: state.draft.clientName,
      sourceKind: state.draft.sourceKind,
      sourceId: state.draft.sourceId,
      streamName: state.draft.streamName,
      purposeCode: state.draft.purposeCode,
      purposeDescription: state.draft.purposeDescription,
      accessMode: state.draft.accessMode,
    });
    const staged = await stageParRequest({ asUrl: AS_URL, request });
    state.stagedRequest = staged;
  } catch (err) {
    state.lastParError = err.message || String(err);
  }
  res.redirect('/');
});

app.post('/approve', async (req, res) => {
  updateDraft(req.body);
  state.lastApprovalError = null;
  state.ownerAuthSuspected = false;
  const requestUri = state.stagedRequest?.request_uri;
  if (!requestUri) {
    state.lastApprovalError = 'No staged request to approve.';
    return res.redirect('/');
  }
  try {
    const { token, grantId, grant } = await approveInline({
      asUrl: AS_URL,
      requestUri,
      subjectId: state.draft.subjectId,
    });
    state.tokenInfo = { token, grantId, grant, source: 'inline approval' };
  } catch (err) {
    state.lastApprovalError = err.message || String(err);
    if (err.ownerAuthEnabled) state.ownerAuthSuspected = true;
  }
  res.redirect('/');
});

app.post('/deny', async (_req, res) => {
  state.lastApprovalError = null;
  state.ownerAuthSuspected = false;
  const requestUri = state.stagedRequest?.request_uri;
  if (!requestUri) {
    state.lastApprovalError = 'No staged request to deny.';
    return res.redirect('/');
  }
  try {
    await denyInline({ asUrl: AS_URL, requestUri });
    state.lastApprovalError = 'Request denied.';
  } catch (err) {
    state.lastApprovalError = err.message || String(err);
    if (err.ownerAuthEnabled) state.ownerAuthSuspected = true;
  }
  res.redirect('/');
});

app.post('/token/paste', (req, res) => {
  updateDraft(req.body);
  const pasted = state.draft.pastedToken;
  if (pasted) {
    state.tokenInfo = { token: pasted, grantId: null, grant: null, source: 'pasted from hosted approval' };
    state.introspection = null;
    state.lastIntrospectError = null;
  } else {
    state.lastApprovalError = 'No token pasted.';
  }
  res.redirect('/');
});

app.post('/introspect', async (_req, res) => {
  state.lastIntrospectError = null;
  if (!state.tokenInfo?.token) {
    state.lastIntrospectError = 'No token to introspect.';
    return res.redirect('/');
  }
  try {
    state.introspection = await introspectToken({ asUrl: AS_URL, token: state.tokenInfo.token });
  } catch (err) {
    state.lastIntrospectError = err.message || String(err);
  }
  res.redirect('/');
});

app.post('/query/streams', async (_req, res) => {
  state.lastQueryError = null;
  if (!state.tokenInfo?.token) {
    state.lastQueryError = 'No token.';
    return res.redirect('/');
  }
  try {
    const body = await queryStreams({ rsUrl: RS_URL, token: state.tokenInfo.token });
    state.lastQuery = { label: 'GET /v1/streams', body };
  } catch (err) {
    state.lastQueryError = err.message || String(err);
  }
  res.redirect('/');
});

app.post('/query/records', async (req, res) => {
  updateDraft(req.body);
  state.lastQueryError = null;
  if (!state.tokenInfo?.token) {
    state.lastQueryError = 'No token.';
    return res.redirect('/');
  }
  const stream = state.draft.queryStream || state.draft.streamName;
  if (!stream) {
    state.lastQueryError = 'stream name required.';
    return res.redirect('/');
  }
  try {
    const body = await queryStreamRecords({ rsUrl: RS_URL, token: state.tokenInfo.token, streamName: stream });
    state.lastQuery = { label: `GET /v1/streams/${stream}/records`, body };
  } catch (err) {
    state.lastQueryError = err.message || String(err);
  }
  res.redirect('/');
});

app.post('/reset', (_req, res) => {
  state.clientId = '';
  state.registeredClient = null;
  state.lastRegistrationError = null;
  state.stagedRequest = null;
  state.lastParError = null;
  state.tokenInfo = null;
  state.lastApprovalError = null;
  state.ownerAuthSuspected = false;
  state.introspection = null;
  state.lastIntrospectError = null;
  state.lastQuery = null;
  state.lastQueryError = null;
  res.redirect('/');
});

if (process.argv[1] && process.argv[1].endsWith('examples/third-party-app/server.js')) {
  app.listen(PORT, () => {
    console.error(`[pdpp-reference-example-client] Listening on http://localhost:${PORT}`);
    console.error(`[pdpp-reference-example-client] AS ${AS_URL} / RS ${RS_URL}`);
  });
}

export { app };
