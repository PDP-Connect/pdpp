/**
 * Unit tests for hosted-MCP package picker selection encoding.
 *
 * The hosted MCP authorize-package consent form previously concatenated raw
 * connector ids with `:` delimiters (`connection:<connector_id>:<connection_id>`).
 * That collapsed when `connector_id` was URL-shaped — the first-party
 * reference connectors use `https://registry.pdpp.org/connectors/<name>` —
 * because `String.prototype.indexOf(':')` split on the scheme separator and
 * the AS tried to resolve `https` as a connector id.
 *
 * The fix is structural: selection values are base64url(JSON) payloads, not
 * delimited strings. These tests pin that property and the parser's
 * malformed-input behavior so the bug cannot regress.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
  hostedMcpSourceKey,
  parseHostedMcpSelection,
  parseHostedMcpSelections,
  parseHostedMcpStreamSelection,
  parseHostedMcpStreamSelections,
} from '../server/hosted-mcp-selection.js';

test('round-trips a URL-shaped connector id without delimiter collapse', () => {
  const urlShaped = 'https://registry.pdpp.org/connectors/gmail';
  const encoded = encodeHostedMcpSelection({ connectorId: urlShaped, connectionId: null });

  // The encoded form MUST NOT contain a literal `:` or `/`, so no downstream
  // splitter — including future buggy parsers — can rediscover the bug.
  assert.equal(encoded.includes(':'), false, 'opaque selection must not contain `:`');
  assert.equal(encoded.includes('/'), false, 'opaque selection must not contain `/`');

  const parsed = parseHostedMcpSelection(encoded);
  assert.deepEqual(parsed, { connectorId: urlShaped, connectionId: null });
});

test('round-trips a (connector, connection) tuple with URL-shaped connector id', () => {
  const urlShaped = 'https://registry.pdpp.org/connectors/gmail';
  const connectionId = 'conn_01HXYZ';
  const encoded = encodeHostedMcpSelection({ connectorId: urlShaped, connectionId });
  const parsed = parseHostedMcpSelection(encoded);
  assert.deepEqual(parsed, { connectorId: urlShaped, connectionId });
});

test('regression: literal "connection:<url>:<id>" is rejected, not split', () => {
  // This is the exact shape the old parser produced and accepted. The
  // structural parser MUST refuse it rather than guessing a connector id.
  const legacy = 'connection:https://registry.pdpp.org/connectors/gmail:conn_01HXYZ';
  assert.equal(parseHostedMcpSelection(legacy), null);
  assert.deepEqual(parseHostedMcpSelections([legacy]), []);
  assert.deepEqual(parseHostedMcpSelections(legacy), []);
});

test('regression: literal "connector:<url>" is rejected, not slice-parsed', () => {
  const legacy = 'connector:https://registry.pdpp.org/connectors/gmail';
  assert.equal(parseHostedMcpSelection(legacy), null);
  assert.deepEqual(parseHostedMcpSelections([legacy]), []);
});

test('accepts both string and array form values, dedupes by content', () => {
  const a = encodeHostedMcpSelection({ connectorId: 'slack', connectionId: null });
  const b = encodeHostedMcpSelection({ connectorId: 'gmail', connectionId: 'conn_a' });

  assert.deepEqual(parseHostedMcpSelections(a), [
    { connectorId: 'slack', connectionId: null },
  ]);

  assert.deepEqual(parseHostedMcpSelections([a, b, a]), [
    { connectorId: 'slack', connectionId: null },
    { connectorId: 'gmail', connectionId: 'conn_a' },
  ]);
});

test('dedupes two distinct encodings of the same tuple', () => {
  // Two payloads with different key orderings encode to different base64url
  // strings but represent the same (connector, connection). The deduper
  // collapses them by content.
  const canonical = encodeHostedMcpSelection({ connectorId: 'gmail', connectionId: 'conn_a' });
  const reordered = Buffer.from(
    JSON.stringify({ connection_id: 'conn_a', connector_id: 'gmail' }),
    'utf8',
  ).toString('base64url');
  assert.notEqual(canonical, reordered, 'precondition: distinct encodings');

  const parsed = parseHostedMcpSelections([canonical, reordered]);
  assert.deepEqual(parsed, [{ connectorId: 'gmail', connectionId: 'conn_a' }]);
});

test('drops empty, whitespace, non-string, and structurally invalid entries', () => {
  const valid = encodeHostedMcpSelection({ connectorId: 'gmail', connectionId: null });
  const malformed = Buffer.from('not json', 'utf8').toString('base64url');
  const missingConnector = Buffer.from(JSON.stringify({ connection_id: 'orphan' }), 'utf8').toString('base64url');
  const blankConnector = Buffer.from(JSON.stringify({ connector_id: '   ' }), 'utf8').toString('base64url');
  const jsonArray = Buffer.from(JSON.stringify(['gmail']), 'utf8').toString('base64url');
  const jsonNull = Buffer.from('null', 'utf8').toString('base64url');

  const parsed = parseHostedMcpSelections([
    '',
    '   ',
    null,
    undefined,
    42,
    {},
    'not-base64!@#$',
    malformed,
    missingConnector,
    blankConnector,
    jsonArray,
    jsonNull,
    valid,
  ]);
  assert.deepEqual(parsed, [{ connectorId: 'gmail', connectionId: null }]);
});

test('blank connection_id is normalized to null', () => {
  const payload = Buffer.from(
    JSON.stringify({ connector_id: 'gmail', connection_id: '   ' }),
    'utf8',
  ).toString('base64url');
  assert.deepEqual(parseHostedMcpSelection(payload), {
    connectorId: 'gmail',
    connectionId: null,
  });
});

test('returns [] for missing or non-iterable inputs without throwing', () => {
  assert.deepEqual(parseHostedMcpSelections(undefined), []);
  assert.deepEqual(parseHostedMcpSelections(null), []);
  assert.deepEqual(parseHostedMcpSelections(0), []);
  assert.deepEqual(parseHostedMcpSelections({}), []);
});

test('encoder rejects inputs without a usable connectorId', () => {
  assert.throws(() => encodeHostedMcpSelection(null), TypeError);
  assert.throws(() => encodeHostedMcpSelection({}), TypeError);
  assert.throws(() => encodeHostedMcpSelection({ connectorId: '' }), TypeError);
  assert.throws(() => encodeHostedMcpSelection({ connectorId: '   ' }), TypeError);
  assert.throws(() => encodeHostedMcpSelection({ connectorId: 42 }), TypeError);
});

test('stream selection round-trips a (connector, connection, stream) tuple', () => {
  const urlShaped = 'https://registry.pdpp.org/connectors/gmail';
  const encoded = encodeHostedMcpStreamSelection({
    connectorId: urlShaped,
    connectionId: 'conn_01HXYZ',
    streamName: 'messages',
  });
  assert.equal(encoded.includes(':'), false, 'opaque stream selection must not contain `:`');
  assert.equal(encoded.includes('/'), false, 'opaque stream selection must not contain `/`');
  assert.deepEqual(parseHostedMcpStreamSelection(encoded), {
    connectorId: urlShaped,
    connectionId: 'conn_01HXYZ',
    streamName: 'messages',
  });
});

test('stream selection encoder rejects inputs missing a stream or connector', () => {
  assert.throws(() => encodeHostedMcpStreamSelection(null), TypeError);
  assert.throws(() => encodeHostedMcpStreamSelection({}), TypeError);
  assert.throws(
    () => encodeHostedMcpStreamSelection({ connectorId: 'gmail' }),
    TypeError,
  );
  assert.throws(
    () => encodeHostedMcpStreamSelection({ connectorId: 'gmail', streamName: '   ' }),
    TypeError,
  );
  assert.throws(
    () => encodeHostedMcpStreamSelection({ connectorId: '', streamName: 'messages' }),
    TypeError,
  );
});

test('stream selections parse into entries and a per-source set keyed by hostedMcpSourceKey', () => {
  const gmailMessages = encodeHostedMcpStreamSelection({
    connectorId: 'gmail',
    connectionId: 'conn_a',
    streamName: 'messages',
  });
  const gmailThreads = encodeHostedMcpStreamSelection({
    connectorId: 'gmail',
    connectionId: 'conn_a',
    streamName: 'threads',
  });
  const slackChannels = encodeHostedMcpStreamSelection({
    connectorId: 'slack',
    connectionId: null,
    streamName: 'channels',
  });
  // Duplicate entry should be deduped.
  const { entries, bySource } = parseHostedMcpStreamSelections([
    gmailMessages,
    gmailThreads,
    slackChannels,
    gmailMessages,
    'not-a-real-selection',
  ]);
  assert.equal(entries.length, 3, 'duplicates and malformed entries dropped');
  const gmailKey = hostedMcpSourceKey({ connectorId: 'gmail', connectionId: 'conn_a' });
  const slackKey = hostedMcpSourceKey({ connectorId: 'slack', connectionId: null });
  assert.deepEqual([...bySource.get(gmailKey)].sort(), ['messages', 'threads']);
  assert.deepEqual([...bySource.get(slackKey)], ['channels']);
});

test('stream selections return empty containers for missing or non-iterable inputs', () => {
  const empty = parseHostedMcpStreamSelections(undefined);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.bySource.size, 0);
});

test('hostedMcpSourceKey matches the dedupe key parseHostedMcpStreamSelections uses internally', () => {
  const stream = encodeHostedMcpStreamSelection({
    connectorId: 'gmail',
    connectionId: 'conn_a',
    streamName: 'messages',
  });
  const { bySource } = parseHostedMcpStreamSelections([stream]);
  const lookup = hostedMcpSourceKey({ connectorId: 'gmail', connectionId: 'conn_a' });
  assert.ok(bySource.has(lookup), 'source key matches the parsed grouping key');
  assert.notDeepEqual(
    bySource.get(lookup),
    bySource.get(hostedMcpSourceKey({ connectorId: 'gmail', connectionId: null })),
    'blank connection id and present connection id must produce different keys',
  );
});
