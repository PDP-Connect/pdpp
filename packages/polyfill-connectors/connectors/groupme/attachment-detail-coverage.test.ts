// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage proof for the `attachments` stream (manifest `coverage_strategy:
 * "parent_detail_accounting"` — see evidence/coherence.ts).
 *
 * BEFORE this fix, `collect()` emitted a STATE checkpoint for `attachments`
 * but never a DETAIL_COVERAGE message at all — the stream could never prove
 * coverage under `evaluateStreamCoherence` (rule 6: a declared strategy with
 * no measurement behind it reads `checkpoint_only`/`no_proof_strategy`,
 * never `proven`), regardless of how many attachments were actually
 * hydrated. This file proves the fix: `recordAttachmentCoverage` and
 * `buildAttachmentDetailCoverageMessage` build an honest per-run
 * considered/covered accounting from each attachment's OWN terminal
 * `hydration_status`, and `collect()` emits one report for each requested
 * parent stream that completed cleanly this run.
 *
 * `covered` counts hydrated outcomes plus explicit `unavailable` provider
 * objects. Deferred and failed outcomes remain uncovered.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { evaluateStreamCoherence } from "@pdpp/reference-contract/evidence";
import type { CollectContext, EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  __resetHttpGovernorForTests,
  __setZeroDelayHttpGovernorForTests,
  buildAttachmentDetailCoverageMessage,
  collect,
  makeAttachmentDetailCoverage,
  recordAttachmentCoverage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const TOKEN = "test-access-token";

before(() => {
  __setZeroDelayHttpGovernorForTests();
});
after(() => {
  __resetHttpGovernorForTests();
});

// ─── Unit level: recordAttachmentCoverage / buildAttachmentDetailCoverageMessage ──

test("recordAttachmentCoverage: zero attachments considered this run yields a proven-empty 0/0 claim", () => {
  const coverage = makeAttachmentDetailCoverage();
  const msg = buildAttachmentDetailCoverageMessage(coverage, "group_messages");

  assert.equal(msg.type, "DETAIL_COVERAGE");
  assert.equal(msg.stream, "attachments");
  assert.equal(msg.state_stream, "group_messages");
  assert.equal(msg.considered, 0, "a genuinely empty run must prove considered: 0, not omit it");
  assert.equal(msg.covered, 0);
  assert.deepEqual(msg.required_keys, []);
  assert.deepEqual(msg.hydrated_keys, []);
});

test("recordAttachmentCoverage: every attachment hydrated reports considered === covered (nonzero, full coverage)", () => {
  const coverage = makeAttachmentDetailCoverage();
  recordAttachmentCoverage(coverage, { id: "a1", hydration_status: "hydrated" });
  recordAttachmentCoverage(coverage, { id: "a2", hydration_status: "hydrated" });
  const msg = buildAttachmentDetailCoverageMessage(coverage, "group_messages");

  assert.equal(msg.considered, 2);
  assert.equal(msg.covered, 2, "a fully hydrated run must prove full coverage, not merely nonzero collection");
  assert.deepEqual(msg.hydrated_keys, ["a1", "a2"]);
});

test("recordAttachmentCoverage: a partial hydration failure reports covered < considered — must not be laundered into full coverage", () => {
  const coverage = makeAttachmentDetailCoverage();
  recordAttachmentCoverage(coverage, { id: "a1", hydration_status: "hydrated" });
  recordAttachmentCoverage(coverage, { id: "a2", hydration_status: "failed" });
  recordAttachmentCoverage(coverage, { id: "a3", hydration_status: "hydrated" });
  const msg = buildAttachmentDetailCoverageMessage(coverage, "group_messages");

  assert.equal(msg.considered, 3, "the failed attachment was still considered — it must not shrink the denominator");
  assert.equal(msg.covered, 2, "only the two genuinely hydrated attachments count toward covered");
  assert.deepEqual(msg.required_keys, ["a1", "a2", "a3"]);
  assert.deepEqual(msg.hydrated_keys, ["a1", "a3"], "the failed attachment must not appear in hydrated_keys");
});

test("recordAttachmentCoverage: a deferred attachment (no upload backend, or a null-returning fetch failure) is considered but not covered", () => {
  const coverage = makeAttachmentDetailCoverage();
  recordAttachmentCoverage(coverage, { id: "a1", hydration_status: "deferred" });
  const msg = buildAttachmentDetailCoverageMessage(coverage, "group_messages");

  assert.equal(msg.considered, 1);
  assert.equal(
    msg.covered,
    0,
    "deferred must never be credited as covered — it conflates 'no backend configured' with a real per-item failure"
  );
});

test("recordAttachmentCoverage: provider-unavailable media is an explicit optional skip", () => {
  const coverage = makeAttachmentDetailCoverage();
  recordAttachmentCoverage(coverage, { id: "gone", hydration_status: "unavailable" });
  const msg = buildAttachmentDetailCoverageMessage(coverage, "group_messages");

  assert.equal(msg.considered, 1);
  assert.equal(msg.covered, 1);
  assert.deepEqual(msg.hydrated_keys, []);
  assert.deepEqual(msg.optional_skip_keys, ["gone"]);
});

// ─── collect()-level: gating on parent-stream success/failure ──────────────

const GROUP = {
  id: "group-1",
  name: "Test Group",
  description: null,
  avatar_url: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_050,
  members_count: 3,
  messages_count: 1,
};

function groupMessageWithAttachment(id: string): Record<string, unknown> {
  return {
    id,
    text: "look at this",
    created_at: 1_700_000_100,
    user_id: "user-2",
    name: "Bob",
    avatar_url: null,
    attachments: [{ type: "image", url: "https://i.groupme.com/a.jpg" }],
    favorited_by: [],
    system: false,
  };
}

const CHAT = {
  id: "chat-1",
  last_message: "hey",
  last_message_at: 1_700_000_000,
  other_user: { id: "user-2", name: "Bob", avatar_url: null },
  avatar_url: null,
};

function directMessageWithAttachment(id: string): Record<string, unknown> {
  return {
    id,
    text: "look at this too",
    created_at: 1_700_000_100,
    user_id: "user-2",
    name: "Bob",
    avatar_url: null,
    attachments: [{ type: "image", url: "https://i.groupme.com/b.jpg" }],
  };
}

/** Route `globalThis.fetch` by request path, mirroring
 *  carry-forward-projection.test.ts's stub — collect()'s real fan-out hits
 *  several distinct paths in one run, not a fixed call sequence. */
function stubFetchByPath(routes: Record<string, unknown | { status: number; body: unknown }>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const route = routes[url.pathname];
    if (route === undefined) {
      throw new Error(`unstubbed path in attachment-detail-coverage test: ${url.pathname}`);
    }
    if (typeof route === "object" && route !== null && "status" in route) {
      const failure = route as { status: number; body: unknown };
      return Promise.resolve(new Response(JSON.stringify(failure.body), { status: failure.status }));
    }
    return Promise.resolve(new Response(JSON.stringify({ response: route }), { status: 200 }));
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const STREAMS: StreamScope[] = [
  { name: "groups" },
  { name: "group_messages" },
  { name: "direct_messages" },
  { name: "direct_chat_messages" },
  { name: "attachments" },
];

function makeCtx(
  state: Record<string, unknown> = {},
  detailGaps: CollectContext["detailGaps"] = []
): {
  ctx: CollectContext;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const ctx: CollectContext = {
    assist: () => Promise.resolve("asst_test"),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    credentials: { GROUPME_ACCESS_TOKEN: TOKEN },
    detailGaps,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-10T00:00:00.000Z",
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map(STREAMS.map((s) => [s.name, s])),
    scope: { streams: STREAMS },
    sendInteraction: () =>
      Promise.resolve({ request_id: "int_test", status: "cancelled" as const, type: "INTERACTION_RESPONSE" as const }),
    state,
  };
  return { ctx, emitted: harness.emitted, messages: harness.protocolMessages };
}

function attachmentsCoverageMessages(messages: readonly EmittedMessage[]): EmittedMessage[] {
  return messages.filter((m) => m.type === "DETAIL_COVERAGE" && m.stream === "attachments");
}

test("collect(): zero attachments across both parent streams proves a verified-empty 0/0 attachments claim with STATE", async () => {
  const restore = stubFetchByPath({
    "/v3/groups": [GROUP],
    "/v3/chats": [CHAT],
    "/v3/groups/group-1/messages": {
      count: 1,
      messages: [
        {
          id: "gmsg-1",
          text: "hi",
          created_at: 1_700_000_100,
          user_id: "user-2",
          name: "Bob",
          avatar_url: null,
          attachments: [],
          favorited_by: [],
          system: false,
        },
      ],
    },
    "/v3/direct_messages": {
      count: 1,
      direct_messages: [
        {
          id: "dmsg-1",
          text: "hi",
          created_at: 1_700_000_100,
          user_id: "user-2",
          name: "Bob",
          avatar_url: null,
          attachments: [],
        },
      ],
    },
  });
  try {
    const { ctx, messages } = makeCtx();
    await collect(ctx);

    const coverage = attachmentsCoverageMessages(messages);
    const state = messages.find((m) => m.type === "STATE" && m.stream === "attachments");

    assert.equal(coverage.length, 2, "each independently checkpointed parent must carry its own report");
    const parentStreams = coverage
      .map((report) => {
        assert.equal(report.type, "DETAIL_COVERAGE");
        return report.type === "DETAIL_COVERAGE" ? report.state_stream : "";
      })
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(parentStreams, ["direct_chat_messages", "group_messages"]);
    for (const report of coverage) {
      assert.equal(report.type === "DETAIL_COVERAGE" && report.considered, 0);
      assert.equal(report.type === "DETAIL_COVERAGE" && report.covered, 0);
    }

    assert.ok(state, "attachments STATE must be emitted when parent streams succeed cleanly");
  } finally {
    restore();
  }
});

test("collect(): nonzero attachments with no blob-upload backend configured proves considered > 0, covered: 0 — never false-complete, and emits STATE", async () => {
  // No PDPP_RS_URL/PDPP_OWNER_TOKEN in this test process env, so
  // makeUploader() returns undefined and every attachment with a URL stays
  // hydration_status: "deferred" (attempted this run, but not retained).
  const restore = stubFetchByPath({
    "/v3/groups": [GROUP],
    "/v3/chats": [CHAT],
    "/v3/groups/group-1/messages": { count: 1, messages: [groupMessageWithAttachment("gmsg-1")] },
    "/v3/direct_messages": { count: 1, direct_messages: [directMessageWithAttachment("dmsg-1")] },
  });
  try {
    const { ctx, messages } = makeCtx();
    await collect(ctx);

    const coverage = attachmentsCoverageMessages(messages);
    const state = messages.find((m) => m.type === "STATE" && m.stream === "attachments");

    assert.equal(coverage.length, 2, "each independently checkpointed parent must carry its own report");
    for (const report of coverage) {
      assert.equal(report.type === "DETAIL_COVERAGE" && report.considered, 1);
      assert.equal(
        report.type === "DETAIL_COVERAGE" && report.covered,
        0,
        "an unconfigured blob backend must never be reported as covered — that would be a false completeness claim"
      );
    }

    assert.ok(state, "attachments STATE must be emitted when parent streams succeed cleanly");
  } finally {
    restore();
  }
});

test("collect(): a failed requested parent emits no report for that parent while preserving the successful sibling", async () => {
  const restore = stubFetchByPath({
    "/v3/groups": [GROUP],
    "/v3/chats": [CHAT],
    "/v3/groups/group-1/messages": { status: 500, body: { error: "server error" } },
    "/v3/direct_messages": { count: 1, direct_messages: [directMessageWithAttachment("dmsg-1")] },
  });
  try {
    const { ctx, messages } = makeCtx({ attachments: { fingerprints: "prior-state" } });
    await collect(ctx);

    const coverage = attachmentsCoverageMessages(messages);
    const attachmentsState = messages.find((m) => m.type === "STATE" && m.stream === "attachments");

    assert.equal(coverage.length, 1, "the successful direct-message parent keeps its independent coverage report");
    assert.equal(
      coverage[0]?.type === "DETAIL_COVERAGE" && coverage[0].state_stream,
      "direct_chat_messages",
      "the failed group-message parent must emit no attachment coverage"
    );

    assert.ok(attachmentsState, "the successful parent's attachment fingerprints remain reusable");
  } finally {
    restore();
  }
});

test("collect(): a parent stream that was never requested does not block attachments coverage for the requested parent that succeeded", async () => {
  const harness = makeRecordingEmit(validateRecord);
  const streams: StreamScope[] = [{ name: "groups" }, { name: "group_messages" }, { name: "attachments" }];
  const ctx: CollectContext = {
    assist: () => Promise.resolve("asst_test"),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    credentials: { GROUPME_ACCESS_TOKEN: TOKEN },
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-10T00:00:00.000Z",
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map(streams.map((s) => [s.name, s])),
    scope: { streams },
    sendInteraction: () =>
      Promise.resolve({ request_id: "int_test", status: "cancelled" as const, type: "INTERACTION_RESPONSE" as const }),
    state: {},
  };
  const restore = stubFetchByPath({
    "/v3/groups": [GROUP],
    "/v3/groups/group-1/messages": { count: 1, messages: [groupMessageWithAttachment("gmsg-1")] },
  });
  try {
    await collect(ctx);

    const coverage = harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "attachments");
    assert.ok(
      coverage,
      "direct_chat_messages was never requested, so it must not block the attachments claim for the requested, successful group_messages parent"
    );
    assert.equal(coverage?.type === "DETAIL_COVERAGE" && coverage.considered, 1);
  } finally {
    restore();
  }
});

test("collect(): a transient attachment failure stays uncovered so the parent cursor can be withheld", async () => {
  const streams: StreamScope[] = [{ name: "groups" }, { name: "group_messages" }, { name: "attachments" }];
  const run = async (hydrated: boolean): Promise<EmittedMessage[]> => {
    const harness = makeRecordingEmit(validateRecord);
    const ctx: CollectContext = {
      assist: () => Promise.resolve("asst_test"),
      capture: null,
      completeAssistance: () => Promise.resolve(),
      credentials: { GROUPME_ACCESS_TOKEN: TOKEN },
      detailGaps: [],
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      emittedAt: "2026-08-10T00:00:00.000Z",
      progress: () => Promise.resolve(),
      requestDetailGapPage: () => Promise.resolve([]),
      requested: new Map(streams.map((stream) => [stream.name, stream])),
      scope: { streams },
      sendInteraction: () =>
        Promise.resolve({
          request_id: "int_test",
          status: "cancelled" as const,
          type: "INTERACTION_RESPONSE" as const,
        }),
      state: {},
    };
    await collect(ctx, {
      uploader: async () =>
        hydrated
          ? {
              blob_id: "blob-1",
              mime_type: "image/jpeg",
              sha256: "a".repeat(64),
              size_bytes: 4,
            }
          : { kind: "failed", reason: "attachment_http_500" },
    });
    return harness.protocolMessages;
  };
  const restoreFirst = stubFetchByPath({
    "/v3/groups": [GROUP],
    "/v3/groups/group-1/messages": { count: 1, messages: [groupMessageWithAttachment("retry-me")] },
  });
  try {
    const firstMessages = await run(false);
    assert.equal(
      firstMessages.some((message) => message.type === "DETAIL_GAP"),
      false,
      "a provider URL that cannot survive durable redaction must not be represented as independently replayable"
    );
    restoreFirst();
    const restoreSecond = stubFetchByPath({
      "/v3/groups": [GROUP],
      "/v3/groups/group-1/messages": { count: 1, messages: [groupMessageWithAttachment("retry-me")] },
    });
    let secondMessages: EmittedMessage[];
    try {
      // The runtime withholds group_messages state because the first coverage
      // report is short. The next pass therefore re-enumerates the message.
      secondMessages = await run(true);
    } finally {
      restoreSecond();
    }
    const [firstCoverage] = attachmentsCoverageMessages(firstMessages);
    const [secondCoverage] = attachmentsCoverageMessages(secondMessages);

    assert.equal(firstCoverage?.type === "DETAIL_COVERAGE" && firstCoverage.covered, 0);
    assert.deepEqual(firstCoverage?.type === "DETAIL_COVERAGE" && firstCoverage.hydrated_keys, []);
    assert.equal(firstCoverage?.type === "DETAIL_COVERAGE" && firstCoverage.gap_keys, undefined);
    assert.equal(secondCoverage?.type === "DETAIL_COVERAGE" && secondCoverage.covered, 1);
    assert.deepEqual(
      secondCoverage?.type === "DETAIL_COVERAGE" && secondCoverage.hydrated_keys,
      secondCoverage?.type === "DETAIL_COVERAGE" && secondCoverage.required_keys
    );
    assert.deepEqual(
      evaluateStreamCoherence(
        {
          checkpoint: "not_committed",
          collected: 1,
          considered: firstCoverage?.type === "DETAIL_COVERAGE" ? (firstCoverage.considered ?? null) : null,
          covered: firstCoverage?.type === "DETAIL_COVERAGE" ? (firstCoverage.covered ?? null) : null,
          pending_detail_gaps: 0,
          skipped: null,
        },
        { coverage_strategy: "parent_detail_accounting" }
      ),
      { proven: false, reason: "boundary_shortfall" }
    );
    assert.deepEqual(
      evaluateStreamCoherence(
        {
          checkpoint: "committed",
          collected: 1,
          considered: secondCoverage?.type === "DETAIL_COVERAGE" ? (secondCoverage.considered ?? null) : null,
          covered: secondCoverage?.type === "DETAIL_COVERAGE" ? (secondCoverage.covered ?? null) : null,
          pending_detail_gaps: 0,
          skipped: null,
        },
        { coverage_strategy: "parent_detail_accounting" }
      ),
      { proven: true, reason: "enumeration_boundary" }
    );
  } finally {
    // The first stub is already restored before pass two. Calling it again is
    // harmless and protects cleanup if pass one throws early.
    restoreFirst();
  }
});
