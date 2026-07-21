import assert from "node:assert/strict";
import test from "node:test";
import { connectionIdsFromEnvelope, exploreHrefFromEnvelope, streamsFromEnvelope } from "./timeline-detail-view.tsx";

function spineEvent(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: null,
    actor_type: null,
    client_id: null,
    data: {},
    event_id: "evt_1",
    event_type: "run.started",
    grant_id: null,
    interaction_id: null,
    object_id: null,
    object_type: null,
    occurred_at: "2026-07-01T00:00:00Z",
    recorded_at: "2026-07-01T00:00:00Z",
    request_id: null,
    run_id: "run_1",
    scenario_id: null,
    status: null,
    stream_id: null,
    subject_id: null,
    subject_type: null,
    token_id: null,
    trace_id: "trc_1",
    version: "1",
    ...overrides,
  };
}

const routes = {
  section: { explore: "/explore" },
} as never;

test("connectionIdsFromEnvelope reads connector_instance_id from run event data", () => {
  const envelope = {
    event_count: 2,
    events: [
      spineEvent({ data: { connector_instance_id: "cin_github_personal" } }),
      spineEvent({ event_id: "evt_2", data: { connector_instance_id: "cin_github_personal" } }),
    ],
    object: "run_timeline",
    trace_id: "trc_1",
  };
  assert.deepEqual(connectionIdsFromEnvelope(envelope), ["cin_github_personal"]);
});

test("connectionIdsFromEnvelope falls back to data.connection_id alias", () => {
  const envelope = {
    event_count: 1,
    events: [spineEvent({ data: { connection_id: "cin_chase_card" } })],
    object: "run_timeline",
    trace_id: "trc_1",
  };
  assert.deepEqual(connectionIdsFromEnvelope(envelope), ["cin_chase_card"]);
});

test("connectionIdsFromEnvelope does not mistake source.id (connector type) for a connection id", () => {
  const envelope = {
    event_count: 1,
    events: [
      spineEvent({
        data: {},
        source: { id: "github", kind: "connector" },
      }),
    ],
    object: "run_timeline",
    trace_id: "trc_1",
  };
  assert.deepEqual(connectionIdsFromEnvelope(envelope), []);
});

test("connectionIdsFromEnvelope collects multiple distinct connections (grant/trace timelines)", () => {
  const envelope = {
    event_count: 2,
    events: [
      spineEvent({ data: { connector_instance_id: "cin_a" } }),
      spineEvent({ event_id: "evt_2", data: { connector_instance_id: "cin_b" } }),
    ],
    object: "grant_timeline",
    trace_id: "trc_1",
  };
  assert.deepEqual(connectionIdsFromEnvelope(envelope).sort(), ["cin_a", "cin_b"]);
});

test("connectionIdsFromEnvelope returns [] when no events carry connection identity", () => {
  const envelope = {
    event_count: 1,
    events: [spineEvent()],
    object: "run_timeline",
    trace_id: "trc_1",
  };
  assert.deepEqual(connectionIdsFromEnvelope(envelope), []);
});

test("streamsFromEnvelope collects distinct stream_id values from per-record events", () => {
  const envelope = {
    event_count: 3,
    events: [
      spineEvent({ stream_id: "messages" }),
      spineEvent({ event_id: "evt_2", stream_id: "labels" }),
      spineEvent({ event_id: "evt_3", stream_id: "messages" }),
    ],
    object: "run_timeline",
    trace_id: "trc_1",
  };
  assert.deepEqual(streamsFromEnvelope(envelope).sort(), ["labels", "messages"]);
});

test("streamsFromEnvelope returns [] when events carry no stream_id (e.g. run lifecycle events)", () => {
  const envelope = {
    event_count: 1,
    events: [spineEvent({ stream_id: null })],
    object: "run_timeline",
    trace_id: "trc_1",
  };
  assert.deepEqual(streamsFromEnvelope(envelope), []);
});

test("exploreHrefFromEnvelope allows scoped Explore links without stream ids", () => {
  const envelope = {
    event_count: 2,
    events: [
      spineEvent({ data: { connector_instance_id: "cin_github_personal" }, stream_id: null }),
      spineEvent({
        event_id: "evt_2",
        data: { connector_instance_id: "cin_github_personal" },
        stream_id: null,
      }),
    ],
    object: "run_timeline",
    trace_id: "trc_1",
  };
  const href = exploreHrefFromEnvelope(routes, envelope);
  assert.ok(href);
  const url = new URL(href, "https://example.test");
  assert.equal(url.pathname, "/explore");
  assert.equal(url.searchParams.get("since"), "2026-07-01");
  assert.equal(url.searchParams.get("until"), "2026-07-02");
  assert.deepEqual(url.searchParams.getAll("connection"), ["cin_github_personal"]);
  assert.deepEqual(url.searchParams.getAll("stream"), []);
});

test("exploreHrefFromEnvelope suppresses unsafe links without connection identity", () => {
  const envelope = {
    event_count: 1,
    events: [spineEvent({ data: {}, stream_id: "messages" })],
    object: "run_timeline",
    trace_id: "trc_1",
  };
  assert.equal(exploreHrefFromEnvelope(routes, envelope), null);
});
