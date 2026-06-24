/**
 * Regression: manifest-authored x_pdpp_role roles reach the RECENT MERGED-TIMELINE
 * FEED, so a chatgpt/codex `messages` row renders a typed MESSAGE card (title = the
 * content) instead of falling to the generic "Id: <uuid>" card.
 *
 * THE BUG (docs context): the role declarations were live end-to-end on the PEEK
 * path (served via field_capabilities[].role → declaredRolesFromCapabilities →
 * buildRecordPreview), but the recent-feed entry builder (timelineRecordToEntry)
 * rebuilt capabilities from `manifestFieldCapabilities(...)`, which carries TYPES
 * and FIELD-NAMES but NOT ROLES. So `declaredRolesFromCapabilities(thatCapabilities)`
 * was ALWAYS empty → buildRecordPreview got no roles → every feed row degraded to
 * the honest-but-wrong generic card ("Id: <record_key>").
 *
 * THE FIX: thread a declared-ROLES map (parallel to the declared-TYPES map) from the
 * bundled manifest (extractDeclaredFieldRoles → ManifestMetadata.declaredFieldRoles)
 * straight to the feed builder, which now reads `declaredFieldRoles.get(metaKey)`
 * instead of re-deriving roles from a types-only capability list.
 *
 * These tests drive the REAL recent-feed path through assembleExplorerData with a
 * fake DashboardDataSource whose manifest declares x_pdpp_role (exactly as the
 * bundled chatgpt manifest does: content→primary-title, role→actor,
 * create_time→event-time). A pre-fix assembler returns a generic card (preview.kind
 * !== "message", preview.title === undefined) and FAILS these assertions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ExploreTimelinePage, ExploreTimelineRecord, RefConnectorSummary } from "../lib/ref-client.ts";
import type { ConnectorManifest, RecordsPage, StreamMetadata } from "../lib/rs-client.ts";
import { assembleExplorerData } from "./explore-data-assembler.ts";

const SNAPSHOT_AT = "2026-12-31T00:00:00Z";

function chatgptSummary(): RefConnectorSummary {
  return {
    connector_display_name: "ChatGPT",
    connector_id: "chatgpt",
    connection_id: "cin_chatgpt",
    connector_instance_id: "cin_chatgpt",
    display_name: "ChatGPT",
    freshness: {},
    last_run: null,
    last_successful_run: null,
    manifest_version: "test",
    schedule: null,
    stream_count: 1,
    streams: ["messages"],
    total_records: 10,
  } as RefConnectorSummary;
}

/**
 * A bundled-shape manifest: `connector_id` is the registry URI and `connector_key`
 * is the plain key records carry (the metaKey is built from the plain key). The
 * `messages` stream declares x_pdpp_role on three fields exactly as the shipped
 * chatgpt manifest does. This is the SOLE source of the feed's declared roles.
 */
function chatgptManifest(): ConnectorManifest {
  return {
    connector_id: "https://registry.pdpp.org/connectors/chatgpt",
    connector_key: "chatgpt",
    streams: [
      {
        name: "messages",
        schema: {
          properties: {
            role: { type: "string", x_pdpp_role: "actor" },
            content: { type: "string", x_pdpp_role: "primary-title" },
            // No event-time role on a message stream (Codex event-time check): the row
            // time comes from create_time via cursor_field/consent_time_field → displayAt,
            // not a presentation role. Mirrors the real chatgpt manifest.
            create_time: { type: "string" },
          },
        },
      },
    ],
  } as ConnectorManifest;
}

/** One `messages` record carrying content + role + create_time (the message body). */
function messageRecord(): ExploreTimelineRecord {
  return {
    object: "timeline_record" as const,
    connector_id: "chatgpt",
    connector_instance_id: "cin_chatgpt",
    stream: "messages",
    record_key: "msg-9f3c-uuid",
    emitted_at: "2026-06-01T00:00:00Z",
    // The server orders by semantic_time; provide it so displayAt is the authored time.
    semantic_time: "2026-05-20T12:00:00Z",
    data: {
      role: "assistant",
      content: "Here is the answer to your question about timelines.",
      create_time: "2026-05-20T12:00:00Z",
    },
  } as ExploreTimelineRecord;
}

function timelinePage(records: ExploreTimelineRecord[]): ExploreTimelinePage {
  return {
    object: "list",
    data: records,
    has_more: false,
    next_cursor: null,
    snapshot_at: SNAPSHOT_AT,
    new_since_snapshot: 0,
  };
}

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function makeDataSource(page: ExploreTimelinePage): DashboardDataSource {
  return {
    kind: "live",
    aggregateRecordsByTime: notStubbed,
    listConnectorSummaries: () =>
      Promise.resolve({ object: "list" as const, data: [chatgptSummary()], has_more: false }),
    listConnectorManifests: () => Promise.resolve([chatgptManifest()]),
    listExploreTimeline: (): Promise<ExploreTimelinePage> => Promise.resolve(page),
    // The recent feed never loads per-stream metadata before first paint; return an
    // empty capability set so any accidental reliance on served roles would NOT mask
    // the manifest-sourced roles under test.
    getStreamMetadata: (_c: string, stream: string): Promise<StreamMetadata> =>
      Promise.resolve({ name: stream, object: "stream_metadata", field_capabilities: {} }),
    queryRecords: (): Promise<RecordsPage> => Promise.resolve({ data: [], has_more: false, object: "list" }),
    getConnectorOverview: notStubbed,
    getDatasetSummary: notStubbed,
    getDeploymentDiagnostics: notStubbed,
    getGrantTimeline: () => Promise.resolve(null),
    getRecord: notStubbed,
    getRunTimeline: () => Promise.resolve(null),
    getTraceTimeline: () => Promise.resolve(null),
    isHybridRetrievalAdvertised: () => Promise.resolve(false),
    isSemanticRetrievalAdvertised: () => Promise.resolve(false),
    listGrants: () => Promise.resolve({ object: "list" as const, data: [], has_more: false }),
    listPendingApprovals: () => Promise.resolve({ object: "list" as const, data: [], has_more: false }),
    listRuns: () => Promise.resolve({ object: "list" as const, data: [], has_more: false }),
    listStreams: () => Promise.resolve([]),
    listTraces: () => Promise.resolve({ object: "list" as const, data: [], has_more: false }),
    refSearch: () =>
      Promise.resolve({ object: "search_result" as const, traces: [], grants: [], runs: [], exact: null }),
    searchRecordsHybrid: () => Promise.resolve({ object: "list" as const, data: [], has_more: false, warnings: [] }),
    searchRecordsLexical: () => Promise.resolve({ object: "list" as const, data: [], has_more: false, warnings: [] }),
    searchRecordsSemantic: () => Promise.resolve({ object: "list" as const, data: [], has_more: false, warnings: [] }),
  } satisfies DashboardDataSource;
}

test("recent feed: a chatgpt/messages row renders a TITLED card (title=content, author surfaced) from manifest x_pdpp_role, not the generic Id card", async () => {
  const ds = makeDataSource(timelinePage([messageRecord()]));

  // The empty-query recent merged-timeline lens (no cursor, no time window).
  const data = await assembleExplorerData({}, ds, "https://rs.test");

  assert.equal(data.feed.length, 1, "exactly one feed entry");
  const entry = data.feed[0];
  assert.ok(entry, "feed entry present");
  assert.ok(entry.preview, "feed entry MUST carry a preview (it was undefined/generic before the fix)");

  // THE FIX: the declared content→primary-title role drives a content card whose
  // title is the CONTENT value — not a generic "Id: <record_key>" card. The kind is
  // `titled`, NOT `message`: an `actor` role is attribution (also on tracks/PRs), so it
  // does not by itself claim a conversation — that needs a declared message TYPE
  // (Codex end-review blocker). The author still surfaces from the declared actor role.
  assert.equal(
    entry.preview?.kind,
    "titled",
    "declared title/actor roles dispatch a titled card, not an over-claimed message"
  );
  assert.equal(
    entry.preview?.title,
    "Here is the answer to your question about timelines.",
    "title is the declared content field value, NOT the record id"
  );
  // The actor role surfaces the author too (it shows on the titled card, declared content).
  assert.equal(entry.preview?.author, "assistant", "actor role surfaces the author even on the titled card");

  // Defence: the title is NOT the record id (the generic-card symptom of the bug).
  assert.notEqual(entry.preview?.title, entry.recordId, "title must not be the record id (the generic fallback)");
});

test("recent feed: an UNDECLARED stream still takes the honest generic card (no role guessing)", async () => {
  // Same connector, but a manifest stream that declares NO x_pdpp_role. The record
  // must NOT be guessed into a message card — it stays generic (Codex constraint #2/#7).
  const undeclaredManifest = {
    connector_id: "https://registry.pdpp.org/connectors/chatgpt",
    connector_key: "chatgpt",
    streams: [{ name: "messages", schema: { properties: { content: { type: "string" }, role: { type: "string" } } } }],
  } as ConnectorManifest;

  const ds: DashboardDataSource = {
    ...makeDataSource(timelinePage([messageRecord()])),
    listConnectorManifests: () => Promise.resolve([undeclaredManifest]),
  };

  const data = await assembleExplorerData({}, ds, "https://rs.test");
  const entry = data.feed[0];
  assert.ok(entry?.preview, "generic preview still present");
  // No declared role → no typed message card; the content is NOT promoted to a title.
  assert.notEqual(entry?.preview?.title, "Here is the answer to your question about timelines.");
  assert.notEqual(entry?.preview?.kind, "message", "undeclared stream must not be guessed into a message card");
});
