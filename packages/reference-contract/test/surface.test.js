import test from 'node:test';
import assert from 'node:assert/strict';

import { listOperations, validateRequest } from '../src/index.ts';
import { generateDocs } from '../src/docs/generate.js';
import { generateOpenApi } from '../src/openapi/index.js';
import { publicManifests } from '../src/public/index.ts';

test('public manifests cover metadata, auth, grant, and record surfaces', () => {
  const ids = new Set(publicManifests.map((manifest) => manifest.id));

  for (const operationId of [
    'getAuthorizationServerMetadata',
    'getProtectedResourceMetadata',
    'registerDynamicClient',
    'createPushedAuthorizationRequest',
    'approveConsent',
    'startOwnerDeviceAuthorization',
    'exchangeOwnerDeviceToken',
    'introspectToken',
    'revokeGrant',
    'listStreams',
    'getStreamMetadata',
    'listRecords',
    'getRecord',
    'getBlob',
  ]) {
    assert.ok(ids.has(operationId), `expected public manifest ${operationId}`);
  }

  const publicOperations = listOperations().filter((entry) => entry.surface === 'public');
  assert.ok(publicOperations.some((entry) => entry.id === 'createPushedAuthorizationRequest'));
  assert.ok(publicOperations.some((entry) => entry.id === 'revokeGrant'));
});

test('request validators accept the shipped public flow shapes', () => {
  const parRequest = validateRequest('createPushedAuthorizationRequest', {
    body: {
      client_id: 'longview',
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          connector_id: 'spotify',
          purpose_code: 'https://pdpp.org/purpose/personalization',
          access_mode: 'continuous',
          streams: [{ name: 'top_artists', view: 'basic' }],
        },
      ],
    },
  });
  assert.deepEqual(parRequest, { ok: true });

  const deviceAuthRequest = validateRequest('startOwnerDeviceAuthorization', {
    body: {
      client_id: 'cli_longview',
      audience: 'pdpp',
    },
  });
  assert.deepEqual(deviceAuthRequest, { ok: true });

  const tokenRequest = validateRequest('exchangeOwnerDeviceToken', {
    body: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc_owner_example',
      client_id: 'cli_longview',
    },
  });
  assert.deepEqual(tokenRequest, { ok: true });

  const introspectionRequest = validateRequest('introspectToken', {
    body: {},
  });
  assert.equal(introspectionRequest.ok, false);
  assert.ok(introspectionRequest.errors.some((error) => error.where === 'body'));
});

test('OpenAPI and docs generation include the auth/control routes alongside records', () => {
  const publicDocument = generateOpenApi({ includeReference: false });
  const fullDocument = generateOpenApi({ includeReference: true });
  const docs = generateDocs();

  assert.ok(publicDocument.paths['/.well-known/oauth-authorization-server']);
  assert.ok(publicDocument.paths['/.well-known/oauth-protected-resource']);
  assert.ok(publicDocument.paths['/oauth/par']);
  assert.ok(publicDocument.paths['/oauth/token']);
  assert.ok(publicDocument.paths['/grants/{grantId}/revoke']);
  assert.equal(publicDocument.paths['/_ref/connectors'], undefined);

  assert.ok(fullDocument.paths['/_ref/connectors']);
  assert.ok(fullDocument.paths['/_ref/search']);

  assert.match(docs.routes, /\/oauth\/par/);
  assert.match(docs.routes, /\/oauth\/token/);
  assert.match(docs.routes, /\/grants\/\{grantId\}\/revoke/);
  assert.match(docs.routes, /\/v1\/streams\/\{stream\}\/records/);
  assert.match(docs.referenceRoutes, /\/_ref\/search/);
  assert.match(docs.cookbook, /consent\/approve.*\{ grant_id, token, grant \}/);
  assert.ok(!publicDocument.paths['/v1/blobs/{blob_id}'].get.responses['302']);
  assert.deepEqual(
    fullDocument.paths['/_ref/records/timeline'].get.parameters
      .find((parameter) => parameter.name === 'timestamp_mode')?.schema?.enum,
    ['native', 'ingest'],
  );
  assert.ok(!fullDocument.paths['/_ref/dataset/summary'].get.responses['401']);
});
