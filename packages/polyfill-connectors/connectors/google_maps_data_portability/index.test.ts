import assert from "node:assert/strict";
import test from "node:test";
import type {
  CollectContext,
  EmittedMessage,
  RecordData,
  StartMessage,
  StreamScope,
} from "../../src/connector-runtime.ts";
import type { AccessTypeResult, ArchiveStateResult, InitiateArchiveInput, InitiateArchiveResult } from "./api.ts";
import { collectGoogleMapsDataPortability } from "./index.ts";

class FakeGoogleDataPortabilityClient {
  readonly calls: Array<{ input?: unknown; method: string }> = [];

  checkAccessType(): Promise<AccessTypeResult> {
    this.calls.push({ method: "checkAccessType" });
    return Promise.resolve({
      oneTimeResources: ["maps.starred_places"],
      timeBasedResources: ["myactivity.maps"],
    });
  }

  initiateArchive(input: InitiateArchiveInput): Promise<InitiateArchiveResult> {
    this.calls.push({ input, method: "initiateArchive" });
    return Promise.resolve({
      accessType: "ACCESS_TYPE_ONE_TIME",
      archiveJobId: input.resources[0] === "maps.starred_places" ? "job-starred" : "job-activity",
    });
  }

  getArchiveState(archiveJobId: string): Promise<ArchiveStateResult> {
    this.calls.push({ input: archiveJobId, method: "getArchiveState" });
    return Promise.resolve({
      exportTime: "2026-06-11T00:00:00Z",
      name: `archiveJobs/${archiveJobId}/portabilityArchiveState`,
      startTime: "2026-06-10T00:00:00Z",
      state: "COMPLETE",
      urls: [`https://storage.example/${archiveJobId}.zip`],
    });
  }
}

function makeContext({
  state = {},
  streams = [{ name: "archive_jobs" }],
}: {
  readonly state?: Record<string, unknown>;
  readonly streams?: readonly StreamScope[];
} = {}): {
  readonly ctx: CollectContext;
  readonly messages: EmittedMessage[];
  readonly records: Array<{ data: RecordData; stream: string }>;
} {
  const messages: EmittedMessage[] = [];
  const records: Array<{ data: RecordData; stream: string }> = [];
  const start: StartMessage = {
    type: "START",
    scope: { streams },
    state,
  };
  return {
    messages,
    records,
    ctx: {
      assist: () => Promise.resolve("asst_test"),
      capture: null,
      completeAssistance: () => Promise.resolve(),
      credentials: {},
      detailGaps: [],
      emit: (msg) => {
        messages.push(msg);
        return Promise.resolve();
      },
      emitRecord: (stream, data) => {
        records.push({ data, stream });
        return Promise.resolve();
      },
      emittedAt: "2026-06-11T00:00:00.000Z",
      progress: (message, extra = {}) => {
        messages.push({ type: "PROGRESS", message, ...extra });
        return Promise.resolve();
      },
      requested: new Map(streams.map((stream) => [stream.name, stream])),
      requestDetailGapPage: () => Promise.resolve([]),
      scope: start.scope,
      sendInteraction: () =>
        Promise.resolve({
          request_id: "int_test",
          status: "cancelled",
          type: "INTERACTION_RESPONSE",
        }),
      state,
    },
  };
}

test("Google Maps Data Portability connector initiates archive jobs for authorized resource groups", async () => {
  const fakeClient = new FakeGoogleDataPortabilityClient();
  const { ctx, messages, records } = makeContext({
    streams: [
      {
        name: "archive_jobs",
        resources: ["maps.starred_places", "myactivity.maps"],
        time_range: {
          since: "2026-06-01T00:00:00Z",
          until: "2026-06-11T00:00:00Z",
        },
      },
    ],
  });

  await collectGoogleMapsDataPortability(ctx, {
    clientFactory: () => fakeClient,
    env: {
      GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "ya29.access",
      GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS: "maps.starred_places,myactivity.maps",
    },
  });

  assert.deepEqual(
    fakeClient.calls.map((call) => call.method),
    ["checkAccessType", "initiateArchive", "initiateArchive"]
  );
  const firstInitiate = fakeClient.calls[1];
  assert.ok(firstInitiate);
  assert.deepEqual(firstInitiate.input, {
    endTime: "2026-06-11T00:00:00Z",
    resources: ["maps.starred_places"],
    startTime: "2026-06-01T00:00:00Z",
  });
  assert.equal(records.length, 2);
  const firstRecord = records[0];
  assert.ok(firstRecord);
  assert.equal(firstRecord.stream, "archive_jobs");
  assert.deepEqual(firstRecord.data, {
    access_type: "ACCESS_TYPE_ONE_TIME",
    archive_job_id: "job-starred",
    download_url_count: 0,
    export_time: null,
    id: "maps.starred_places:job-starred",
    resource_group: "maps.starred_places",
    source: "google_data_portability_api",
    start_time: null,
    state: "IN_PROGRESS",
  });
  const coverage = messages.find((msg) => msg.type === "DETAIL_COVERAGE");
  assert.ok(coverage);
  assert.deepEqual(coverage.required_keys, ["maps.starred_places", "myactivity.maps"]);
  assert.deepEqual(coverage.hydrated_keys, ["maps.starred_places", "myactivity.maps"]);
  assert.deepEqual(coverage.optional_skip_keys ?? [], []);
  const state = messages.find((msg) => msg.type === "STATE");
  assert.ok(state);
  assert.equal(state.stream, "archive_jobs");
  const cursor = state.cursor as {
    google_maps_data_portability?: { archive_jobs?: Record<string, unknown> };
  };
  assert.ok(cursor.google_maps_data_portability?.archive_jobs?.["maps.starred_places"]);
});

test("Google Maps Data Portability connector resumes an in-progress archive instead of initiating a duplicate", async () => {
  const fakeClient = new FakeGoogleDataPortabilityClient();
  const { ctx, records } = makeContext({
    state: {
      google_maps_data_portability: {
        archive_jobs: {
          "maps.starred_places": {
            archive_job_id: "job-existing",
            state: "IN_PROGRESS",
          },
        },
      },
    },
    streams: [{ name: "archive_jobs", resources: ["maps.starred_places"] }],
  });

  await collectGoogleMapsDataPortability(ctx, {
    clientFactory: () => fakeClient,
    env: {
      GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "ya29.access",
      GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS: "maps.starred_places",
    },
  });

  assert.deepEqual(
    fakeClient.calls.map((call) => call.method),
    ["checkAccessType", "getArchiveState"]
  );
  const firstRecord = records[0];
  assert.ok(firstRecord);
  assert.equal(firstRecord.data.archive_job_id, "job-existing");
});
