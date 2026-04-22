import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExpandParams,
  buildOwnerDeviceAuthorizationRequest,
  buildParRequest,
  buildRecordsQuery,
} from '../src/builders/index.js';

test('buildExpandParams normalizes repeated relation names and expand limits', () => {
  assert.deepEqual(
    buildExpandParams({
      expand: ['albums', 'albums,artists', 'artists'],
      expand_limit: { albums: 5, artists: 2, empty: '' },
    }),
    {
      expand: ['albums', 'artists'],
      expand_limit: { albums: 5, artists: 2 },
    },
  );
});

test('buildRecordsQuery composes record-list query params without empty values', () => {
  assert.deepEqual(
    buildRecordsQuery({
      limit: 25,
      order: 'desc',
      filter: { source_updated_at: { gte: '2026-04-01T00:00:00Z' } },
      expand: ['artist'],
      expand_limit: { artist: 1 },
      connector_id: 'spotify',
      fields: ['id', 'name'],
    }),
    {
      limit: 25,
      order: 'desc',
      fields: 'id,name',
      filter: { source_updated_at: { gte: '2026-04-01T00:00:00Z' } },
      connector_id: 'spotify',
      expand: ['artist'],
      expand_limit: { artist: 1 },
    },
  );
});

test('buildOwnerDeviceAuthorizationRequest builds x-www-form-urlencoded payloads', () => {
  const params = buildOwnerDeviceAuthorizationRequest({
    client_id: 'cli_longview',
    scope: 'owner',
    audience: 'pdpp',
  });

  assert.equal(params.get('client_id'), 'cli_longview');
  assert.equal(params.get('scope'), 'owner');
  assert.equal(params.get('audience'), 'pdpp');
});

test('buildParRequest lifts flat data-access inputs into authorization_details', () => {
  assert.deepEqual(
    buildParRequest({
      client_id: 'concert_recommendation_app',
      scenario_id: 'scenario_contract_builders',
      connector_id: 'spotify',
      purpose_code: 'https://pdpp.org/purpose/personalization',
      purpose_description: 'Suggest concerts based on listening history',
      access_mode: 'single_use',
      streams: [{ name: 'top_artists', fields: ['id', 'name'] }],
    }),
    {
      client_id: 'concert_recommendation_app',
      scenario_id: 'scenario_contract_builders',
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          connector_id: 'spotify',
          purpose_code: 'https://pdpp.org/purpose/personalization',
          purpose_description: 'Suggest concerts based on listening history',
          access_mode: 'single_use',
          streams: [{ name: 'top_artists', fields: ['id', 'name'] }],
        },
      ],
    },
  );
});
