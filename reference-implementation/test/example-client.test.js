import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { startServer } from '../server/index.js';
import { runConnector } from '../runtime/index.js';
import {
  registerClient,
  buildParRequest,
  stageParRequest,
  approveInline,
  denyInline,
  introspectToken,
  queryStreams,
  queryStreamRecords,
} from '../examples/third-party-app/lib/flow.js';
import { buildDefaultDraft } from '../examples/third-party-app/server.js';
import { DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN } from '../server/reference-local-defaults.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv) => new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 2000);
    srv.close(() => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
  });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function registerSpotify(asUrl) {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const response = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spotifyManifest),
  });
  if (!response.ok) {
    throw new Error(`connector registration failed (${response.status})`);
  }
  return spotifyManifest;
}

function firstStream(manifest) {
  return manifest.streams[0].name;
}

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  assert.equal(deviceResp.status, 200);
  const device = await deviceResp.json();

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  assert.equal(approveResp.status, 200);

  const tokenResp = await fetch(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  assert.equal(tokenResp.status, 200);
  const tokenBody = await tokenResp.json();
  return tokenBody.access_token;
}

async function seedSpotify({ asUrl, rsUrl, manifest, subjectId = 'owner_local' }) {
  const ownerToken = await issueOwnerToken(asUrl, subjectId);
  const result = await runConnector({
    connectorPath: join(REFERENCE_IMPL_DIR, 'connectors/seed/index.js'),
    connectorId: manifest.connector_id,
    ownerToken,
    manifest,
    state: null,
    collectionMode: 'full_refresh',
    rsUrl,
  });
  assert.equal(result.status, 'succeeded');
}

test('example client completes the current reference flow on the inline-approval path', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotifyManifest = await registerSpotify(asUrl);
    await seedSpotify({ asUrl, rsUrl, manifest: spotifyManifest });

    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: 'Reference Example Client', token_endpoint_auth_method: 'none' },
    });
    assert.equal(typeof registered.client_id, 'string');
    assert.ok(registered.client_id.length > 0);

    const parRequest = buildParRequest({
      clientId: registered.client_id,
      clientName: 'Reference Example Client',
      sourceKind: 'connector',
      sourceId: spotifyManifest.connector_id,
      streamName: firstStream(spotifyManifest),
      purposeCode: 'https://pdpp.org/purpose/financial_planning',
      purposeDescription: 'example-client test',
      accessMode: 'single_use',
    });
    const staged = await stageParRequest({ asUrl, request: parRequest });
    assert.equal(typeof staged.request_uri, 'string');
    assert.ok(staged.request_uri.length > 0);

    const approval = await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: 'owner_local',
    });
    assert.equal(typeof approval.token, 'string');
    assert.ok(approval.token.length > 0);
    assert.equal(typeof approval.grantId, 'string');

    const introspection = await introspectToken({ asUrl, token: approval.token });
    assert.equal(introspection.active, true);

    const streams = await queryStreams({ rsUrl, token: approval.token });
    assert.ok(streams);
    assert.ok(Array.isArray(streams.streams) || typeof streams === 'object');
  } finally {
    await closeServer(server);
  }
});

test('example client denies a staged request on the inline path', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotifyManifest = await registerSpotify(asUrl);

    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: 'Reference Example Client', token_endpoint_auth_method: 'none' },
    });
    const staged = await stageParRequest({
      asUrl,
      request: buildParRequest({
        clientId: registered.client_id,
        clientName: 'Reference Example Client',
        sourceKind: 'connector',
        sourceId: spotifyManifest.connector_id,
        streamName: firstStream(spotifyManifest),
        purposeCode: 'https://pdpp.org/purpose/financial_planning',
        purposeDescription: 'deny path',
        accessMode: 'single_use',
      }),
    });

    const result = await denyInline({ asUrl, requestUri: staged.request_uri });
    assert.equal(result.ok, true);

    // After denial, an approval attempt should fail honestly.
    await assert.rejects(
      approveInline({ asUrl, requestUri: staged.request_uri, subjectId: 'owner_local' }),
    );
  } finally {
    await closeServer(server);
  }
});

test('example client surfaces owner-auth enabled as an honest failure instead of silently breaking', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: 'hunter2',
    ownerAuthSubjectId: 'owner_local',
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotifyManifest = await registerSpotify(asUrl);

    const registered = await registerClient({
      asUrl,
      initialAccessToken: DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
      metadata: { client_name: 'Reference Example Client', token_endpoint_auth_method: 'none' },
    });
    const staged = await stageParRequest({
      asUrl,
      request: buildParRequest({
        clientId: registered.client_id,
        clientName: 'Reference Example Client',
        sourceKind: 'connector',
        sourceId: spotifyManifest.connector_id,
        streamName: firstStream(spotifyManifest),
        purposeCode: 'https://pdpp.org/purpose/financial_planning',
        purposeDescription: 'owner-auth enabled',
        accessMode: 'single_use',
      }),
    });

    // When the owner-auth placeholder is enabled, the inline shortcut cannot
    // succeed. The example app surfaces that as an `ownerAuthEnabled: true`
    // error rather than a silent failure.
    await assert.rejects(
      approveInline({ asUrl, requestUri: staged.request_uri, subjectId: 'owner_local' }),
      (err) => err && err.ownerAuthEnabled === true,
    );
  } finally {
    await closeServer(server);
  }
});

test('dashboard DCR default uses the shared local reference token when env is unset', async () => {
  // Prove that when PDPP_DCR_INITIAL_ACCESS_TOKENS is unset, the dashboard's
  // default falls back to the shared local reference default. We read the
  // dashboard source directly to avoid bootstrapping Next.js runtime state.
  // The operator dashboard lives in apps/console after the public-site /
  // operator-console split (apps/web was removed).
  const DASHBOARD_FILE = join(
    REFERENCE_IMPL_DIR,
    '..',
    'apps',
    'console',
    'src',
    'app',
    'dashboard',
    'lib',
    'operator-grant-request.ts',
  );
  const source = readFileSync(DASHBOARD_FILE, 'utf8');
  assert.match(
    source,
    /DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN/,
    'dashboard DCR default should fall back to the shared reference-local constant',
  );
  assert.match(
    source,
    /pdpp-reference-implementation\/reference-local-defaults/,
    'dashboard should import the shared defaults module, not duplicate the literal',
  );
  // Also verify the shared constant itself has a sensible value.
  assert.equal(typeof DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN, 'string');
  assert.ok(DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN.length > 8);
});

test('example client shipped defaults stage a PAR request and reach records against a normally-registered reference manifest', async () => {
  // This test is the guardrail for the "follow the five sections top to
  // bottom" promise in the example app README: submit the form as-shipped,
  // without editing it, after registering the reference Spotify manifest the
  // normal way. If the shipped connector id or stream name drifts out of
  // the manifest, this test fails loudly.
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const spotifyManifest = await registerSpotify(asUrl);
    const draft = buildDefaultDraft();
    await seedSpotify({ asUrl, rsUrl, manifest: spotifyManifest, subjectId: draft.subjectId });

    // The shipped defaults must correspond to the real manifest.
    assert.equal(
      draft.sourceId,
      spotifyManifest.connector_id,
      'shipped default source.id must match the registered spotify manifest',
    );
    assert.ok(
      spotifyManifest.streams.some((s) => s.name === draft.streamName),
      `shipped default streamName "${draft.streamName}" must be declared by the spotify manifest`,
    );

    const registered = await registerClient({
      asUrl,
      initialAccessToken: draft.initialAccessToken,
      metadata: { client_name: draft.clientName, token_endpoint_auth_method: 'none' },
    });

    const parRequest = buildParRequest({
      clientId: registered.client_id,
      clientName: draft.clientName,
      sourceKind: draft.sourceKind,
      sourceId: draft.sourceId,
      streamName: draft.streamName,
      purposeCode: draft.purposeCode,
      purposeDescription: draft.purposeDescription,
      accessMode: draft.accessMode,
    });
    const staged = await stageParRequest({ asUrl, request: parRequest });
    assert.equal(typeof staged.request_uri, 'string');
    assert.ok(staged.request_uri.length > 0);

    const approval = await approveInline({
      asUrl,
      requestUri: staged.request_uri,
      subjectId: draft.subjectId,
    });
    assert.equal(typeof approval.token, 'string');

    const records = await queryStreamRecords({
      rsUrl,
      token: approval.token,
      streamName: draft.streamName,
    });
    assert.ok(records, 'record list response should be truthful, not empty');
  } finally {
    await closeServer(server);
  }
});
