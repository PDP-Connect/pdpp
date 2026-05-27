import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGrantRevokedEvent,
  buildTestEvent,
  buildVerifyEvent,
  changeCursorBefore,
  deriveClientEventsFromRecordChange,
} from '../operations/rs-client-event-derive/index.ts';

const baseSub = {
  subscriptionId: 'sub_1',
  grantId: 'g_1',
  clientId: 'c_1',
  status: 'active',
};

function activeSub(overrides) {
  return {
    ...baseSub,
    scope: {
      source: { kind: 'connector', id: 'gmail' },
      streams: [{ name: 'messages' }, { name: 'contacts' }],
    },
    ...overrides,
  };
}

test('derive emits records.changed when stream is in scope', () => {
  const events = deriveClientEventsFromRecordChange(
    {
      connectorId: 'gmail',
      connectorInstanceId: 'gmail_default',
      stream: 'messages',
      version: 42,
      emittedAt: '2026-05-27T00:00:00Z',
    },
    [activeSub()],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'pdpp.records.changed');
  assert.equal(events[0].data.stream, 'messages');
  assert.deepEqual(
    JSON.parse(Buffer.from(events[0].data.changes_since, 'base64').toString('utf8')),
    { kind: 'changes_since', version: 41, v: 41 },
  );
});

test('derive omits envelope for streams outside grant scope', () => {
  const events = deriveClientEventsFromRecordChange(
    { connectorId: 'gmail', connectorInstanceId: 'g', stream: 'labels', version: 1, emittedAt: 'now' },
    [activeSub()],
  );
  assert.equal(events.length, 0);
});

test('derive respects client-narrowed filters subset', () => {
  const sub = activeSub({
    scope: {
      source: { kind: 'connector', id: 'gmail' },
      streams: [{ name: 'messages' }, { name: 'contacts' }],
      filters: { streams: ['messages'] },
    },
  });
  const eventsMsgs = deriveClientEventsFromRecordChange(
    { connectorId: 'gmail', connectorInstanceId: 'g', stream: 'messages', version: 1, emittedAt: 'now' },
    [sub],
  );
  const eventsContacts = deriveClientEventsFromRecordChange(
    { connectorId: 'gmail', connectorInstanceId: 'g', stream: 'contacts', version: 2, emittedAt: 'now' },
    [sub],
  );
  assert.equal(eventsMsgs.length, 1);
  assert.equal(eventsContacts.length, 0);
});

test('derive matches connection_id when grant binds one', () => {
  const sub = activeSub({
    scope: {
      streams: [{ name: 'messages', connection_id: 'conn_work' }],
    },
  });
  const matches = deriveClientEventsFromRecordChange(
    {
      connectorId: 'gmail',
      connectorInstanceId: 'g',
      connectionId: 'conn_work',
      stream: 'messages',
      version: 1,
      emittedAt: 'now',
    },
    [sub],
  );
  const otherConn = deriveClientEventsFromRecordChange(
    {
      connectorId: 'gmail',
      connectorInstanceId: 'g',
      connectionId: 'conn_personal',
      stream: 'messages',
      version: 1,
      emittedAt: 'now',
    },
    [sub],
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].data.connection_id, 'conn_work');
  assert.equal(otherConn.length, 0);
});

test('derive ignores non-active subscriptions', () => {
  const sub = activeSub({ status: 'pending_verification' });
  const events = deriveClientEventsFromRecordChange(
    { connectorId: 'gmail', connectorInstanceId: 'g', stream: 'messages', version: 1, emittedAt: 'now' },
    [sub],
  );
  assert.equal(events.length, 0);
});

test('derive output carries no record body or field values', () => {
  const events = deriveClientEventsFromRecordChange(
    { connectorId: 'gmail', connectorInstanceId: 'g', stream: 'messages', version: 1, emittedAt: 'now' },
    [activeSub()],
  );
  const data = events[0].data;
  assert.equal('record' in data, false);
  assert.equal('record_json' in data, false);
  assert.equal('fields' in data, false);
});

test('cursor points immediately before the changed version', () => {
  assert.deepEqual(
    JSON.parse(Buffer.from(changeCursorBefore({ version: 7 }), 'base64').toString('utf8')),
    { kind: 'changes_since', version: 6, v: 6 },
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(changeCursorBefore({ version: 0 }), 'base64').toString('utf8')),
    { kind: 'changes_since', version: 0, v: 0 },
  );
});

test('builders produce well-shaped envelopes', () => {
  assert.equal(buildVerifyEvent('sub_x', 'chal', 'now').type, 'pdpp.subscription.verify');
  assert.equal(buildVerifyEvent('sub_x', 'chal', 'now').data.challenge, 'chal');
  assert.equal(buildTestEvent('sub_x', 'now').type, 'pdpp.subscription.test');
  assert.equal(buildGrantRevokedEvent('sub_x', 'now').type, 'pdpp.grant.revoked');
});
