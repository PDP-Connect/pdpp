import test from 'node:test';
import assert from 'node:assert/strict';

import { listOperations, validateRequest, validateResponse } from '../src/index.ts';
import { generateDocs } from '../src/docs/generate.js';
import { generateOpenApi } from '../src/openapi/index.js';
import {
  BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
  BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
  publicManifests,
} from '../src/public/index.ts';

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
          source: { kind: 'connector', id: 'spotify' },
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

test('PAR contract advertises batch consent caps as advisory metadata, not hard maxItems', () => {
  assert.equal(BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP, 8);
  assert.equal(BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD, 6);
  assert.ok(BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD < BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP);

  const entries = Array.from({ length: BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP + 1 }, (_, index) => ({
    type: 'https://pdpp.org/data-access',
    source: { kind: 'connector', id: `source_${index + 1}` },
    purpose_code: 'https://pdpp.org/purpose/personalization',
    access_mode: 'continuous',
    streams: [{ name: 'items', view: 'basic' }],
  }));
  const result = validateRequest('createPushedAuthorizationRequest', {
    body: {
      client_id: 'longview',
      authorization_details: entries,
    },
  });
  assert.deepEqual(result, { ok: true });

  const publicDocument = generateOpenApi({ includeReference: false });
  const schema =
    publicDocument.paths['/oauth/par'].post.requestBody.content['application/json'].schema.properties
      .authorization_details;
  assert.equal(schema.maxItems, undefined);
  assert.equal(schema['x-pdpp-soft-cap'], BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP);
  assert.equal(schema['x-pdpp-warning-threshold'], BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD);
});

test('listRecords response validator accepts runtime warning parameters', () => {
  const result = validateResponse('listRecords', {
    status: 200,
    body: {
      object: 'list',
      has_more: false,
      data: [],
      meta: {
        warnings: [
          {
            code: 'deprecated_alias_used',
            message: 'connector_instance_id is deprecated; use connection_id',
            param: 'connector_instance_id',
          },
        ],
      },
    },
  });

  assert.deepEqual(result, { ok: true, skipped: false });
});

test('registerDynamicClient response omits unset optional URI metadata', () => {
  const minimal = validateResponse('registerDynamicClient', {
    status: 201,
    body: {
      client_id: 'client_test',
      client_id_issued_at: 1780963200,
      token_endpoint_auth_method: 'none',
      client_name: null,
      redirect_uris: ['http://localhost:1455/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
  });
  assert.deepEqual(minimal, { ok: true, skipped: false });

  const withUri = validateResponse('registerDynamicClient', {
    status: 201,
    body: {
      client_id: 'client_test',
      client_id_issued_at: 1780963200,
      token_endpoint_auth_method: 'none',
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:1455/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_uri: 'https://claude.ai',
      policy_uri: 'https://claude.ai/legal/privacy',
    },
  });
  assert.deepEqual(withUri, { ok: true, skipped: false });

  const withNull = validateResponse('registerDynamicClient', {
    status: 201,
    body: {
      client_id: 'client_test',
      client_id_issued_at: 1780963200,
      token_endpoint_auth_method: 'none',
      client_name: null,
      redirect_uris: ['http://localhost:1455/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_uri: null,
    },
  });
  assert.equal(withNull.ok, false);
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
  assert.equal(publicDocument.paths['/_ref/dataset/summary/rebuild'], undefined);
  assert.equal(
    fullDocument.paths['/_ref/dataset/summary/rebuild'].post.operationId,
    'refDatasetSummaryRebuild',
  );
  assert.equal(publicDocument.paths['/_ref/dataset/summary/reconcile'], undefined);
  assert.equal(
    fullDocument.paths['/_ref/dataset/summary/reconcile'].post.operationId,
    'refDatasetSummaryReconcile',
  );

  assert.match(docs.routes, /\/oauth\/par/);
  assert.match(docs.routes, /\/oauth\/token/);
  assert.match(docs.routes, /\/grants\/\{grantId\}\/revoke/);
  assert.match(docs.routes, /\/v1\/streams\/\{stream\}\/records/);
  assert.match(docs.referenceRoutes, /\/_ref\/search/);
  assert.match(docs.referenceRoutes, /\/_ref\/dataset\/summary\/rebuild/);
  assert.match(docs.referenceRoutes, /\/_ref\/dataset\/summary\/reconcile/);
  assert.match(docs.cookbook, /consent\/approve.*\{ grant_id, token, grant \}/);
  assert.ok(!publicDocument.paths['/v1/blobs/{blob_id}'].get.responses['302']);
  assert.deepEqual(
    fullDocument.paths['/_ref/records/timeline'].get.parameters
      .find((parameter) => parameter.name === 'timestamp_mode')?.schema?.enum,
    ['native', 'ingest'],
  );
  assert.ok(!fullDocument.paths['/_ref/dataset/summary'].get.responses['401']);
});
