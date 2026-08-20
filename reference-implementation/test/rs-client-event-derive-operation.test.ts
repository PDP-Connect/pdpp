// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { ActiveSubscription } from "../operations/rs-client-event-derive/index.ts";
import {
  buildGrantRevokedEvent,
  buildTestEvent,
  buildVerifyEvent,
  changeCursorBefore,
  deriveClientEventsFromRecordChange,
} from "../operations/rs-client-event-derive/index.ts";

const baseSub = {
  authorityKind: "client_grant",
  clientId: "c_1",
  grantId: "g_1",
  status: "active",
  subscriptionId: "sub_1",
} as const;

function activeSub(overrides: Partial<ActiveSubscription> = {}): ActiveSubscription {
  return {
    ...baseSub,
    scope: {
      source: { connector_id: "gmail", id: "https://registry.pdpp.dev/connectors/gmail", kind: "connector" },
      streams: [
        { instance_ids: ["gmail_default"], name: "messages" },
        { instance_ids: ["gmail_default"], name: "contacts" },
      ],
    },
    ...overrides,
  };
}

test("derive emits records.changed when stream is in scope", () => {
  const events = deriveClientEventsFromRecordChange(
    {
      connectorId: "gmail",
      connectorInstanceId: "gmail_default",
      emittedAt: "2026-05-27T00:00:00Z",
      stream: "messages",
      version: 42,
    },
    [activeSub()]
  );
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event);
  assert.equal(event.type, "pdpp.records.changed");
  assert.equal(event.data.stream, "messages");
  const changesSince = event.data.changes_since;
  assert.ok(changesSince);
  assert.deepEqual(JSON.parse(Buffer.from(changesSince, "base64").toString("utf8")), {
    kind: "changes_since",
    v: 41,
    version: 41,
  });
});

test("derive lets trusted owner-agent wildcard subscriptions see current and future owner streams", () => {
  const sub = activeSub({
    authorityKind: "trusted_owner_agent",
    grantId: null,
    scope: { streams: [{ name: "*" }] },
    subjectId: "owner_a",
  });
  const events = deriveClientEventsFromRecordChange(
    {
      connectionId: "cin_spotify",
      connectorId: "spotify",
      connectorInstanceId: "cin_spotify",
      emittedAt: "now",
      ownerSubjectId: "owner_a",
      stream: "recent_tracks",
      version: 8,
    },
    [sub]
  );
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event);
  assert.equal(event.data.connector_id, "spotify");
  assert.equal(event.data.stream, "recent_tracks");
  assert.equal(event.data.connection_id, "cin_spotify");
});

test("derive isolates trusted owner-agent wildcard subscriptions by owner subject", () => {
  const sub = activeSub({
    authorityKind: "trusted_owner_agent",
    grantId: null,
    scope: { streams: [{ name: "*" }] },
    subjectId: "owner_a",
  });
  const events = deriveClientEventsFromRecordChange(
    {
      connectionId: "cin_spotify",
      connectorId: "spotify",
      connectorInstanceId: "cin_spotify",
      emittedAt: "now",
      ownerSubjectId: "owner_b",
      stream: "recent_tracks",
      version: 8,
    },
    [sub]
  );
  assert.equal(events.length, 0);
});

test("derive omits envelope for streams outside grant scope", () => {
  const events = deriveClientEventsFromRecordChange(
    {
      connectorId: "gmail",
      connectorInstanceId: "gmail_default",
      emittedAt: "now",
      stream: "labels",
      version: 1,
    },
    [activeSub()]
  );
  assert.equal(events.length, 0);
});

test("derive respects client-narrowed filters subset", () => {
  const sub = activeSub({
    scope: {
      filters: { streams: ["messages"] },
      source: { connector_id: "gmail", id: "https://registry.pdpp.dev/connectors/gmail", kind: "connector" },
      streams: [
        { instance_ids: ["gmail_default"], name: "messages" },
        { instance_ids: ["gmail_default"], name: "contacts" },
      ],
    },
  });
  const eventsMsgs = deriveClientEventsFromRecordChange(
    {
      connectorId: "gmail",
      connectorInstanceId: "gmail_default",
      emittedAt: "now",
      stream: "messages",
      version: 1,
    },
    [sub]
  );
  const eventsContacts = deriveClientEventsFromRecordChange(
    {
      connectorId: "gmail",
      connectorInstanceId: "gmail_default",
      emittedAt: "now",
      stream: "contacts",
      version: 2,
    },
    [sub]
  );
  assert.equal(eventsMsgs.length, 1);
  assert.equal(eventsContacts.length, 0);
});

test("derive enforces source and instance_ids from the closed grant", () => {
  const sub = activeSub({
    scope: {
      source: { connector_id: "gmail", id: "https://registry.pdpp.dev/connectors/gmail", kind: "connector" },
      streams: [{ instance_ids: ["conn_work"], name: "messages" }],
    },
  });
  const matches = deriveClientEventsFromRecordChange(
    {
      connectionId: "conn_work",
      connectorId: "gmail",
      connectorInstanceId: "conn_work",
      emittedAt: "now",
      stream: "messages",
      version: 1,
    },
    [sub]
  );
  const otherConn = deriveClientEventsFromRecordChange(
    {
      connectionId: "conn_personal",
      connectorId: "gmail",
      connectorInstanceId: "conn_personal",
      emittedAt: "now",
      stream: "messages",
      version: 1,
    },
    [sub]
  );
  assert.equal(matches.length, 1);
  const [match] = matches;
  assert.ok(match);
  assert.equal(match.data.connection_id, "conn_work");
  assert.equal(otherConn.length, 0);

  const otherSource = deriveClientEventsFromRecordChange(
    {
      connectionId: "conn_work",
      connectorId: "outlook",
      connectorInstanceId: "conn_work",
      emittedAt: "now",
      stream: "messages",
      version: 1,
    },
    [sub]
  );
  assert.equal(otherSource.length, 0);
});

test("derive enforces resource and time constraints before emitting a hint", () => {
  const sub = activeSub({
    scope: {
      source: { connector_id: "gmail", id: "https://registry.pdpp.dev/connectors/gmail", kind: "connector" },
      streams: [
        {
          instance_ids: ["gmail_default"],
          name: "messages",
          resources: ["message-1"],
          time_constraint: { field: "sent_at", since: "2026-01-01T00:00:00Z" },
        },
      ],
    },
  });
  const baseChange = {
    connectorId: "gmail",
    connectorInstanceId: "gmail_default",
    emittedAt: "now",
    stream: "messages",
    version: 1,
  } as const;
  assert.equal(
    deriveClientEventsFromRecordChange(
      { ...baseChange, data: { sent_at: "2026-02-01T00:00:00Z" }, recordKey: "message-1" },
      [sub]
    ).length,
    1
  );
  assert.equal(
    deriveClientEventsFromRecordChange(
      { ...baseChange, data: { sent_at: "2026-02-01T00:00:00Z" }, recordKey: "message-2" },
      [sub]
    ).length,
    0
  );
  assert.equal(
    deriveClientEventsFromRecordChange(
      { ...baseChange, data: { sent_at: "2025-12-01T00:00:00Z" }, recordKey: "message-1" },
      [sub]
    ).length,
    0
  );
});

test("derive ignores non-active subscriptions", () => {
  // @ts-expect-error -- ActiveSubscription.status is typed as the literal "active" only,
  // but deriveClientEventsFromRecordChange defensively filters on `sub.status !== "active"`
  // at runtime (subscriptions come from a DB row with a wider status domain). This
  // deliberately passes a non-"active" status to prove that runtime guard works.
  const sub = activeSub({ status: "pending_verification" });
  const events = deriveClientEventsFromRecordChange(
    {
      connectorId: "gmail",
      connectorInstanceId: "gmail_default",
      emittedAt: "now",
      stream: "messages",
      version: 1,
    },
    [sub]
  );
  assert.equal(events.length, 0);
});

test("derive output carries no record body or field values", () => {
  const events = deriveClientEventsFromRecordChange(
    {
      connectorId: "gmail",
      connectorInstanceId: "gmail_default",
      emittedAt: "now",
      stream: "messages",
      version: 1,
    },
    [activeSub()]
  );
  const [event] = events;
  assert.ok(event);
  const { data } = event;
  assert.equal("record" in data, false);
  assert.equal("record_json" in data, false);
  assert.equal("fields" in data, false);
});

test("cursor points immediately before the changed version", () => {
  assert.deepEqual(JSON.parse(Buffer.from(changeCursorBefore({ version: 7 }), "base64").toString("utf8")), {
    kind: "changes_since",
    v: 6,
    version: 6,
  });
  assert.deepEqual(JSON.parse(Buffer.from(changeCursorBefore({ version: 0 }), "base64").toString("utf8")), {
    kind: "changes_since",
    v: 0,
    version: 0,
  });
});

test("builders produce well-shaped envelopes", () => {
  assert.equal(buildVerifyEvent("sub_x", "chal", "now").type, "pdpp.subscription.verify");
  assert.equal(buildVerifyEvent("sub_x", "chal", "now").data.challenge, "chal");
  assert.equal(buildTestEvent("sub_x", "now").type, "pdpp.subscription.test");
  assert.equal(buildGrantRevokedEvent("sub_x", "now").type, "pdpp.grant.revoked");
});
