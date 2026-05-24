import test from 'node:test';
import assert from 'node:assert/strict';

import { publicManifests } from '../src/public/index.ts';

function findOperation(operationId) {
  const operation = publicManifests.find((manifest) => manifest.id === operationId);
  assert.ok(operation, `expected public manifest ${operationId}`);
  return operation;
}

test('listStreams summary directs LLMs to /v1/schema for field capabilities', () => {
  const operation = findOperation('listStreams');
  assert.match(
    operation.summary,
    /\/v1\/schema/,
    'listStreams.summary must reference /v1/schema',
  );
  assert.match(
    operation.summary,
    /field_capabilities|filter/i,
    'listStreams.summary must explain why /v1/schema matters (filter / field_capabilities)',
  );
});

test('getStreamMetadata summary directs LLMs to /v1/schema for field capabilities', () => {
  const operation = findOperation('getStreamMetadata');
  assert.match(
    operation.summary,
    /\/v1\/schema/,
    'getStreamMetadata.summary must reference /v1/schema',
  );
  assert.match(
    operation.summary,
    /field_capabilities|filter/i,
    'getStreamMetadata.summary must explain why /v1/schema matters',
  );
});

test('searchRecordsHybrid summary references hybrid_pagination_supported and lexical fallback', () => {
  const operation = findOperation('searchRecordsHybrid');
  assert.match(
    operation.summary,
    /hybrid_pagination_supported/,
    'searchRecordsHybrid.summary must name the hybrid_pagination_supported discovery hint',
  );
  assert.match(
    operation.summary,
    /lexical|\/v1\/search\b/,
    'searchRecordsHybrid.summary must recommend the lexical fallback for cursor pagination',
  );
});

test('ListRecordsQuerySchema.filter description references field_capabilities and /v1/schema', () => {
  const listRecords = findOperation('listRecords');
  const filterSchema = listRecords.request?.query?.properties?.filter;
  assert.ok(filterSchema, 'listRecords query must declare a filter property');
  assert.equal(typeof filterSchema.description, 'string');
  assert.match(
    filterSchema.description,
    /field_capabilities/,
    'filter.description must name field_capabilities',
  );
  assert.match(
    filterSchema.description,
    /\/v1\/schema/,
    'filter.description must reference /v1/schema',
  );
});
