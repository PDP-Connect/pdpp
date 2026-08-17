// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-connector fixture drivers for `coverage-conformance.test.ts`.
 *
 * Each driver exercises a connector's REAL collection code — the same
 * `index.ts` entrypoint or exported orchestration function its own
 * integration test drives — against synthetic, credential-free fixtures
 * (a fake local HTTP/CardDAV server, a fake subprocess binary, a scripted
 * fetch, or an in-memory page/request stub). No connector source file is
 * modified: every driver reaches the connector only through an already-public
 * surface (an exported function, or the real stdin/stdout Collection Profile
 * protocol via `runConnectorProtocolSubprocess`).
 *
 * Two driver shapes cover every connector this gate drives:
 *   - `runDirectImportDriver` — calls an exported collection function
 *     in-process with a fake `CollectContext`; used for connectors with no
 *     rate governor whose production entrypoint takes a context object
 *     (Reddit, Amazon, GroupMe) or an injectable request seam (YNAB).
 *   - the subprocess drivers (Jellyfin, Apple Contacts, Google Messages) go
 *     through the real stdin/stdout protocol via `runConnectorProtocolSubprocess`
 *     against a fake local server or fake CLI binary.
 *
 * A driver returns `{ exercised: true, messages }` when it successfully ran
 * the connector to a real DONE (or the exported orchestration function
 * completed) and captured the emitted protocol messages. It returns
 * `{ exercised: false, reason }` when no cheap, deterministic, credential-free
 * fixture path exists — the gate reports that honestly rather than asserting
 * anything about a stream it never touched.
 *
 * Deliberately excluded from the aggregate gate: YNAB's per-budget streams
 * that route through its real governed `ynab()` fetch. Its module-level HTTP
 * governor (`createConnectorHttpGovernor` in connectors/ynab/index.ts) paces
 * every request through a real GCRA bucket with a 20-second floor interval
 * and no test-mode bypass. `ynabCollect`'s own sanctioned DI seam — an
 * injected `request` function (see `driveYnabAccountStats` below) — avoids
 * the governor entirely without bypassing or weakening it, so `account_stats`
 * (this gate's `singleton_presence` driver) is driven through it; the
 * remaining YNAB streams stay off this gate and rely on YNAB's own dedicated
 * suites (e.g. scheduled-transactions-coverage.test.ts, budgets-considered.test.ts).
 *
 * This module intentionally covers only the connectors this gate can
 * currently drive cheaply (a few seconds, no real network pacing) without
 * live credentials. Every other production-ready connector's required
 * stream is reported `unexercised`, not silently skipped and not assumed
 * broken.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/collector-runtime";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { makeRecordingEmit, type RecordingEmit } from "../../src/test-harness.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A record `emitRecord()` rejected via schema validation — the direct-call
 * counterpart of a real runtime SKIP_RESULT. Drivers that call a connector's
 * exported function directly (Reddit, Amazon, GroupMe, YNAB) use
 * `makeRecordingEmit`, whose `emitRecord` shape-check failures land in its
 * own `.skipped` bookkeeping array, NOT in the `messages`/`emit()` stream —
 * the real runtime would emit an actual SKIP_RESULT protocol message for the
 * same failure, but `makeRecordingEmit` (by design, for ordinary unit tests)
 * never synthesizes one. `runDirectImportDriver` surfaces these
 * automatically so `deriveStreamEnvelope` sees the same "this stream had an
 * unresolved validation failure" fact the runtime's SKIP_RESULT would carry
 * — omitting this silently drops evidence and lets a stream with 100%
 * invalid records still read as `checkpoint_only`/`enumeration_boundary`
 * proven, because the shared oracle never saw the failure.
 */
export interface SkippedRecordFact {
  readonly stream: string;
}

export type DriverResult =
  | { exercised: true; messages: readonly EmittedMessage[]; skippedRecords?: readonly SkippedRecordFact[] }
  | { exercised: false; reason: string };

/**
 * Run a connector's exported collection function in-process against a
 * schema-aware recording harness, and fold `harness.skipped` into
 * `skippedRecords` automatically. `harness.emit` already accumulates every
 * protocol message into `harness.protocolMessages` — callers must NOT
 * separately re-wrap `emit` to collect messages themselves; that would only
 * duplicate what this harness already tracks (an earlier version of this
 * file did exactly that in every driver).
 *
 * `body` receives the harness's `emit`/`emitRecord` so it can build whatever
 * shape of context/args the connector's real entrypoint needs (a full
 * `CollectContext`, or a narrower deps bag like Amazon's `emitOrderAndItems`
 * — those are structurally different enough across connectors that this
 * helper does not try to unify the context shape itself, only the
 * harness/capture plumbing around it).
 */
async function runDirectImportDriver(
  validateRecord: Parameters<typeof makeRecordingEmit>[0],
  body: (harness: RecordingEmit) => Promise<void>
): Promise<DriverResult> {
  const harness = makeRecordingEmit(validateRecord);
  await body(harness);
  return {
    exercised: true,
    messages: harness.protocolMessages,
    skippedRecords: harness.skipped.map((s) => ({ stream: s.stream })),
  };
}

/**
 * The fields of a real `CollectContext` every direct-import driver in this
 * file needs to override are `credentials`/`requested`/`scope`/`state`; the
 * rest (`assist`, `capture`, `completeAssistance`, `detailGaps`,
 * `requestDetailGapPage`, `sendInteraction`) are the same honest no-op stubs
 * none of Reddit/GroupMe/Amazon's collection paths read, matching how each
 * connector's own integration tests construct a fixture context.
 */
function baseCollectContextStubs(
  harness: RecordingEmit
): Pick<
  CollectContext,
  | "assist"
  | "capture"
  | "completeAssistance"
  | "detailGaps"
  | "emit"
  | "emitRecord"
  | "emittedAt"
  | "progress"
  | "requestDetailGapPage"
  | "sendInteraction"
> {
  return {
    assist: () => Promise.reject(new Error("assist not implemented in coverage-conformance driver")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-04-24T12:00:00.000Z",
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    sendInteraction: () => Promise.reject(new Error("sendInteraction not implemented in coverage-conformance driver")),
  };
}

// ─── Reddit: collectAllStreams, the exact function production's collect() ──
// ─── callback calls — driven like reddit/integration.test.ts's own oracle ──
// ─── tests ("collectAllStreams: ... emits DETAIL_COVERAGE").              ──
//
// collectAllStreams(ctx: BrowserCollectContext) is the top-level per-run
// orchestrator: it loops buildStreamTable, calls collectStream per requested
// stream, and emits the run-level DETAIL_COVERAGE. Driving the lower-level
// collectStream directly (an earlier version of this driver did) would miss
// that emission entirely once it lives one level up in collectAllStreams —
// this driver must track wherever production's collect() callback actually
// delegates, not a frozen mirror of an older internal shape. Reddit has no
// rate governor, so no real fetch/pacing occurs; the "browser" surface is a
// minimal mock Page whose evaluate() redirects to a scripted in-memory
// listing, the same createMockPageForFetch shape Reddit's own
// integration.test.ts oracle tests use — collectAllStreams calls
// page.evaluate(fn, {path, userAgent}) under the hood (via the connector's
// private redditFetch), so the mock only needs to honor that one call
// shape, not a real browser.

function createMockRedditPage(fetchPath: (path: string) => Promise<{ status: number; json: unknown }>) {
  return {
    evaluate: (_fn: unknown, args: unknown) => {
      const { path } = args as { path: string };
      return fetchPath(path);
    },
  };
}

/**
 * A schema-valid `t3_*` post child (submitted.json's shape) and a
 * schema-valid `t1_*` comment child (comments/saved/upvoted/downvoted/
 * hidden's shape) — the two record kinds `buildStreamTable`'s 6 endpoints
 * route to `submittedRecord`/`commentRecord`/`savedRecord`/`voteRecord`.
 * IDs must match `schemas.ts`'s `t[13]_[a-z0-9]+` fullname regexes exactly
 * (no underscores in the suffix) — an earlier version of this fixture used
 * `t3_coverage_conformance`, which every one of the 6 streams' schema
 * rejected, silently zeroing `covered` while `considered` stayed 1. Exported
 * so the malformed-counterexample test below can build a deliberately
 * invalid sibling from the same valid base.
 */
function validRedditPost(): { kind: "t3"; data: Record<string, unknown> } {
  return {
    kind: "t3",
    data: {
      name: "t3_covconf1",
      subreddit: "test",
      title: "fixture post",
      permalink: "/r/test/comments/covconf1/fixture_post/",
      url: "https://example.com/article",
      selftext: "",
      is_self: false,
      over_18: false,
      score: 1,
      num_comments: 0,
      upvote_ratio: 1,
      created_utc: 1_700_000_000,
    },
  };
}

function validRedditComment(): { kind: "t1"; data: Record<string, unknown> } {
  return {
    kind: "t1",
    data: {
      name: "t1_covconf1",
      subreddit: "test",
      body: "fixture comment",
      link_id: "t3_covconf1",
      parent_id: "t3_covconf1",
      permalink: "/r/test/comments/covconf1/x/covconf1/",
      score: 1,
      created_utc: 1_700_000_000,
    },
  };
}

const REDDIT_REQUESTED_STREAMS = ["submitted", "comments", "saved", "upvoted", "downvoted", "hidden"];

/** Build the fully-typed BrowserCollectContext collectAllStreams needs, with
 *  every field it actually reads real and the rest honest no-op stubs for
 *  fields this connector never touches (assistance/detail-gap plumbing,
 *  browser context) — matching how Reddit's own integration.test.ts oracle
 *  tests construct this context. */
function buildRedditCollectContext(
  fetchPath: (path: string) => Promise<{ status: number; json: unknown }>,
  harness: RecordingEmit
) {
  return {
    ...baseCollectContextStubs(harness),
    // biome-ignore lint/suspicious/noExplicitAny: no real Playwright BrowserContext exists in this fixture; collectAllStreams never reads `context` (only `page`), so an empty stand-in is honest, not a disguised real value.
    context: {} as any,
    credentials: { REDDIT_USERNAME: "coverage-conformance" },
    // biome-ignore lint/suspicious/noExplicitAny: no real Playwright Page exists in this fixture; only the one evaluate() call collectAllStreams's private redditFetch makes is implemented, matching Reddit's own createMockPageForFetch in integration.test.ts.
    page: createMockRedditPage(fetchPath) as any,
    requested: new Map(REDDIT_REQUESTED_STREAMS.map((name) => [name, { name }])),
    scope: { streams: REDDIT_REQUESTED_STREAMS.map((name) => ({ name })) },
    state: {},
  };
}

async function driveReddit(): Promise<DriverResult> {
  const { collectAllStreams } = await import("../reddit/index.ts");
  const { validateRecord } = await import("../reddit/schemas.ts");

  return runDirectImportDriver(validateRecord, async (harness) => {
    // submitted.json needs a t3 post; every other endpoint (comments, saved,
    // upvoted, downvoted, hidden) needs a t1 comment — see submittedRecord /
    // commentRecord / savedRecord / voteRecord in buildStreamTable's toRecord.
    const postListing = { data: { children: [validRedditPost()], after: null } };
    const commentListing = { data: { children: [validRedditComment()], after: null } };
    const fetchPath = (path: string) =>
      Promise.resolve({ status: 200, json: path.includes("/submitted.json") ? postListing : commentListing });

    await collectAllStreams(buildRedditCollectContext(fetchPath, harness));
  });
}

/**
 * Mutation counterexample: every one of Reddit's 6 streams sees a record
 * whose `id`/`name` fails its schema (an underscore in the fullname suffix,
 * exactly the earlier fixture bug this driver itself once had) — proving
 * the gate distinguishes "considered but validation-rejected" from
 * "considered and covered." Used only by the discriminating test below, not
 * registered in CONNECTOR_DRIVERS.
 */
async function driveRedditMalformed(): Promise<DriverResult> {
  const { collectAllStreams } = await import("../reddit/index.ts");
  const { validateRecord } = await import("../reddit/schemas.ts");

  return runDirectImportDriver(validateRecord, async (harness) => {
    const malformedPost = { kind: "t3" as const, data: { ...validRedditPost().data, name: "t3_has_underscore" } };
    const malformedComment = { kind: "t1" as const, data: { ...validRedditComment().data, name: "t1_has_underscore" } };
    const postListing = { data: { children: [malformedPost], after: null } };
    const commentListing = { data: { children: [malformedComment], after: null } };
    const fetchPath = (path: string) =>
      Promise.resolve({ status: 200, json: path.includes("/submitted.json") ? postListing : commentListing });

    await collectAllStreams(buildRedditCollectContext(fetchPath, harness));
  });
}

// ─── Jellyfin: real subprocess entrypoint against a fake local HTTP server ──
//
// Jellyfin has no rate governor and no auth token exchange delay — the real
// entrypoint completes against a same-host fake HTTP server in ~1s, exactly
// as connectors/jellyfin/protocol-subprocess.test.ts already proves.

async function driveJellyfin(): Promise<DriverResult> {
  const { createServer } = await import("node:http");
  const { runConnectorProtocolSubprocess } = await import("../../src/test-harness.ts");

  const server = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/System/Info") {
      res.writeHead(200);
      res.end(JSON.stringify({ Id: "test", ServerName: "Test Jellyfin", Version: "10.11.11" }));
      return;
    }
    if (path === "/Users") {
      res.writeHead(200);
      res.end(JSON.stringify([{ Id: "user-1", Name: "Test" }]));
      return;
    }
    if (path === "/Users/user-1/Views") {
      res.writeHead(200);
      res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Movies", CollectionType: "movies" }] }));
      return;
    }
    if (path.includes("/Users/user-1/Items")) {
      const url = new URL(path, "http://localhost");
      const startIndex = Number.parseInt(url.searchParams.get("StartIndex") || "0", 10);
      if (startIndex === 0) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            Items: [{ Id: "item-1", Name: "Item 1", Type: "Movie", UserData: { PlayCount: 0, Played: false } }],
            TotalRecordCount: 1,
          })
        );
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ Items: [], TotalRecordCount: 1 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const { port } = server.address() as { port: number };

  try {
    const result = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: join(PACKAGE_ROOT, "connectors/jellyfin/index.ts"),
      env: { JELLYFIN_BASE_URL: `http://127.0.0.1:${port}`, JELLYFIN_API_KEY: "test-key" },
      start: {
        type: "START",
        scope: { streams: [{ name: "libraries" }, { name: "items" }] },
        state: { libraries: {}, items: {} },
      },
    });
    return { exercised: true, messages: result.messages };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ─── Apple Contacts: real subprocess entrypoint against a fake CardDAV server ──
//
// Apple Contacts has no rate governor either — the fake server responds
// in-process, so the whole sync completes in under a second, exactly as
// connectors/apple_contacts/integration.test.ts already proves.

async function driveAppleContacts(): Promise<DriverResult> {
  const { runConnectorProtocolSubprocess } = await import("../../src/test-harness.ts");
  const { buildVCard, startFakeCardDavServer } = await import("../apple_contacts/test-carddav-server.ts");

  const username = "owner@example.com";
  const password = "app-specific-pw";
  const server = await startFakeCardDavServer({ username, password });
  try {
    server.contacts.set("coverage-conformance", {
      uid: "coverage-conformance",
      href: "/addressbooks/owner/card/coverage-conformance.vcf",
      vcard: buildVCard({ uid: "coverage-conformance", fn: "Fixture Contact", email: "fixture@example.com" }),
    });

    const result = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: join(PACKAGE_ROOT, "connectors/apple_contacts/index.ts"),
      env: { APPLE_ID: username, APPLE_APP_SPECIFIC_PASSWORD: password, APPLE_CARDDAV_ORIGIN: server.origin },
      start: {
        type: "START",
        scope: { streams: [{ name: "address_books" }, { name: "contacts" }, { name: "contact_groups" }] },
        state: {},
      },
    });
    return { exercised: true, messages: result.messages };
  } finally {
    await server.close();
  }
}

/**
 * Apple Contacts with a rejected credential: the real subprocess entrypoint
 * fails cleanly with DONE.status === "failed" (verified against
 * connectors/apple_contacts/integration.test.ts's own "fails cleanly on
 * rejected credentials" test) — a genuine, real-production failed run, not
 * a synthetic DONE message. Used by the aggregate gate's "failed/partial
 * never pass" capability pin to prove a failed driver run is treated as a
 * hard failure for every stream it would have proven, not silently exempted.
 */
async function driveAppleContactsAuthFailure(): Promise<DriverResult> {
  const { runConnectorProtocolSubprocess } = await import("../../src/test-harness.ts");
  const { startFakeCardDavServer } = await import("../apple_contacts/test-carddav-server.ts");

  const username = "owner@example.com";
  const server = await startFakeCardDavServer({ username, password: "app-specific-pw" });
  try {
    const result = await runConnectorProtocolSubprocess({
      allowFailedDone: true,
      cwd: PACKAGE_ROOT,
      entrypoint: join(PACKAGE_ROOT, "connectors/apple_contacts/index.ts"),
      env: { APPLE_ID: username, APPLE_APP_SPECIFIC_PASSWORD: "wrong-password", APPLE_CARDDAV_ORIGIN: server.origin },
      start: {
        type: "START",
        scope: { streams: [{ name: "address_books" }, { name: "contacts" }, { name: "contact_groups" }] },
        state: {},
      },
    });
    return { exercised: true, messages: result.messages };
  } finally {
    await server.close();
  }
}

export const APPLE_CONTACTS_AUTH_FAILURE_DRIVER: ConnectorDriver = {
  coveredStreams: ["address_books", "contacts", "contact_groups"],
  run: driveAppleContactsAuthFailure,
};

// ─── Google Messages: real subprocess entrypoint against a fake gmcli binary ─
//
// The only registered `snapshot_import_receipt` driver. gmcli is wrapped
// arms-length as a subprocess (see connectors/google_messages/index.ts's file
// header) — the connector's own integration.test.ts already proves the real
// START -> RECORD/SKIP_RESULT/DONE wire protocol against a fake gmcli binary
// (fixtures/fake-gmcli.mjs) selected via GMCLI_BIN + FAKE_GMCLI_MODE, so no
// real gmcli install or paired Android device is needed here either.

const GOOGLE_MESSAGES_ENTRYPOINT = join(PACKAGE_ROOT, "connectors/google_messages/index.ts");
const FAKE_GMCLI = join(PACKAGE_ROOT, "connectors/google_messages/fixtures/fake-gmcli.mjs");

async function driveGoogleMessagesWithMode(mode: string): Promise<DriverResult> {
  const { runConnectorProtocolSubprocess } = await import("../../src/test-harness.ts");
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: PACKAGE_ROOT,
    entrypoint: GOOGLE_MESSAGES_ENTRYPOINT,
    env: { GMCLI_BIN: FAKE_GMCLI, FAKE_GMCLI_MODE: mode, PDPP_OWNER_TOKEN: "", PDPP_RS_URL: "", RS_URL: "" },
    start: {
      type: "START",
      scope: { streams: [{ name: "messages" }] },
      state: {},
    },
  });
  return { exercised: true, messages: result.messages };
}

function driveGoogleMessages(): Promise<DriverResult> {
  return driveGoogleMessagesWithMode("healthy");
}

/**
 * Genuinely empty archive (`gmcli chats list` returns zero conversations):
 * proves the `considered === covered === 0` verified-empty shape is
 * reachable through the real subprocess path for a `snapshot_import_receipt`
 * stream, not merely a nonzero run that happens to pass.
 */
export const GOOGLE_MESSAGES_EMPTY_DRIVER: ConnectorDriver = {
  coveredStreams: ["messages"],
  run: () => driveGoogleMessagesWithMode("empty"),
};

/**
 * gmcli returns messages output missing required fields for the one fetched
 * conversation: the connector's real schema-drift handling emits a genuine
 * `SKIP_RESULT` for the `messages` stream itself (reason `gmcli_query_failed`
 * — see connectors/google_messages/integration.test.ts's "schema drift:
 * malformed messages output" test), proving the mutation-detection path for
 * this strategy runs through real production error handling, not a
 * synthetic envelope.
 */
export const GOOGLE_MESSAGES_MALFORMED_DRIVER: ConnectorDriver = {
  coveredStreams: ["messages"],
  run: () => driveGoogleMessagesWithMode("malformed_messages"),
};

/**
 * gmcli reports the device as unpaired: the connector cannot enumerate any
 * conversation, so it emits a real `SKIP_RESULT` (reason `gmcli_not_paired`)
 * for `messages` — but this connector treats an unpaired device as a soft,
 * user-actionable skip rather than a hard run failure, so DONE still reports
 * `status: "succeeded"` (verified against
 * connectors/google_messages/integration.test.ts's own "not paired" test).
 * This is a second, independent real-production route to `unresolved_attempt`
 * distinct from the schema-drift mutation above — proves the gate reads the
 * SKIP_RESULT itself, not the run's overall success/failure, as what
 * withholds proof for this stream.
 */
export const GOOGLE_MESSAGES_NOT_PAIRED_DRIVER: ConnectorDriver = {
  coveredStreams: ["messages"],
  run: () => driveGoogleMessagesWithMode("not_paired"),
};

// ─── Amazon: emitOrderAndItems/emitOrdersCoverage, no browser required ────
//
// No governor, no network: these are pure exported functions the connector's
// own collect() calls directly, matching connectors/amazon/integration.test.ts.

async function driveAmazon(): Promise<DriverResult> {
  const { emitOrderAndItems, emitOrdersCoverage, newOrdersCoverage } = await import("../amazon/index.ts");
  const { validateRecord } = await import("../amazon/schemas.ts");

  return runDirectImportDriver(validateRecord, async (harness) => {
    const ordersCoverage = newOrdersCoverage();
    const deps = {
      capture: null,
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      emittedAt: "2026-04-22T12:00:00.000Z",
      ordersCoverage,
      progress: (): Promise<void> => Promise.resolve(),
      skipDetail: false,
      wantsItems: false,
      wantsOrders: true,
    };
    const listOrder = {
      orderId: "111-1234567-8901234",
      orderDateRaw: "January 5, 2026",
      orderTotal: "$42.99",
      deliveryStatus: "Delivered",
      items: [{ asin: "B01ABCDEFG", name: "Fixture Widget", url: "https://amazon.com/dp/B01ABCDEFG" }],
    };

    await emitOrderAndItems(deps, listOrder, null, "2026-01-05");
    await emitOrdersCoverage(deps, ordersCoverage);
  });
}

/**
 * Amazon "orders" with a genuinely empty boundary: the year sweep considered
 * zero orders (no `emitOrderAndItems` call at all — the real collect() loop
 * simply never iterates when the source has nothing in scope this run), then
 * emits the run-level DETAIL_COVERAGE exactly as collect() does after an
 * empty year loop. Proves the `considered === covered === 0` "verified
 * empty" shape is reachable through the real emitOrdersCoverage path, not
 * merely a nonzero run that happens to pass.
 */
async function driveAmazonZeroResult(): Promise<DriverResult> {
  const { emitOrdersCoverage, newOrdersCoverage } = await import("../amazon/index.ts");
  const { validateRecord } = await import("../amazon/schemas.ts");

  return runDirectImportDriver(validateRecord, async (harness) => {
    const ordersCoverage = newOrdersCoverage();
    const deps = {
      capture: null,
      emit: harness.emit,
      emitRecord: harness.emitRecord,
      emittedAt: "2026-04-22T12:00:00.000Z",
      ordersCoverage,
      progress: (): Promise<void> => Promise.resolve(),
      skipDetail: false,
      wantsItems: false,
      wantsOrders: true,
    };
    // No emitOrderAndItems call: the year sweep considered zero orders.
    await emitOrdersCoverage(deps, ordersCoverage);
  });
}

// ─── GroupMe: collect(), the exact function production's runConnector calls ─
//
// GroupMe's real module-level governor paces at 10s/request; these drivers use
// GroupMe's own `__setZeroDelayHttpGovernorForTests()` test seam (the same one
// attachment-detail-coverage.test.ts uses) to avoid paying that pacing for a
// handful of in-process fixture requests. No browser dependency — `collect()`
// takes a real `CollectContext` and fetches through ordinary `globalThis.fetch`,
// stubbed by path exactly like GroupMe's own test file. Driving `collect()`
// directly (rather than a lower-level per-stream helper) is required because
// the `attachments` DETAIL_COVERAGE is only emitted from `collect()` itself,
// gated on whether the REQUESTED parent streams (`group_messages`,
// `direct_chat_messages`) completed cleanly this run — see index.ts's
// `attachmentParentsProvenClean`.

const GROUPME_GROUP = {
  id: "group-1",
  name: "Fixture Group",
  description: null,
  avatar_url: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_050,
  members_count: 2,
  messages_count: 1,
};

const GROUPME_CHAT = {
  last_message: { created_at: 1_700_000_000, text: "hey" },
  other_user: { id: "user-2", name: "Fixture Friend", avatar_url: null },
  avatar_url: null,
};

function groupMessageWithAttachment(id: string): Record<string, unknown> {
  return {
    id,
    text: "look at this",
    created_at: 1_700_000_100,
    user_id: "user-2",
    name: "Fixture Friend",
    avatar_url: null,
    attachments: [{ type: "image", url: "https://i.groupme.com/coverage-conformance.jpg" }],
    favorited_by: [],
    system: false,
  };
}

type GroupMeRouteValue = Record<string, unknown> | readonly unknown[] | string | number | boolean | null;
type GroupMeRoute = GroupMeRouteValue | ((url: URL) => GroupMeRouteValue);

/** Stub `globalThis.fetch` by request pathname, mirroring GroupMe's own
 *  attachment-detail-coverage.test.ts `stubFetchByPath`. A route may be a
 *  resolver when a fixture needs to distinguish pagination query parameters.
 *  Returns a restore function; callers MUST call it even on a thrown error
 *  (try/finally). */
function stubGroupMeFetchByPath(routes: Record<string, GroupMeRoute>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const configuredRoute = routes[url.pathname];
    const route = typeof configuredRoute === "function" ? configuredRoute(url) : configuredRoute;
    if (route === undefined) {
      throw new Error(`unstubbed path in coverage-conformance GroupMe driver: ${url.pathname}`);
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

const GROUPME_STREAMS = ["groups", "group_messages", "direct_messages", "direct_chat_messages", "attachments"];

/**
 * Drives `collect()` against the given GroupMe routes
 * fetch routes, with the zero-delay governor seam (see the file-header
 * comment above) and fetch stubbing/governor restore handled once here. The
 * same helper is used by the aggregate required-stream driver and the
 * attachment capability pins, so all of them exercise production's exact
 * `collect()` terminal path.
 */
async function driveGroupMe(
  routes: Record<string, GroupMeRoute>,
  state: Record<string, unknown> = {}
): Promise<DriverResult> {
  const { __resetHttpGovernorForTests, __setZeroDelayHttpGovernorForTests, collect } = await import(
    "../groupme/index.ts"
  );
  const { validateRecord } = await import("../groupme/schemas.ts");

  __setZeroDelayHttpGovernorForTests();
  try {
    return await runDirectImportDriver(validateRecord, async (harness) => {
      const restore = stubGroupMeFetchByPath(routes);
      try {
        await collect({
          ...baseCollectContextStubs(harness),
          credentials: { GROUPME_ACCESS_TOKEN: "coverage-conformance" },
          requested: new Map(GROUPME_STREAMS.map((name) => [name, { name }])),
          scope: { streams: GROUPME_STREAMS.map((name) => ({ name })) },
          state,
        });
      } finally {
        restore();
      }
    });
  } finally {
    __resetHttpGovernorForTests();
  }
}

const GROUPME_NORMAL_ROUTES: Record<string, GroupMeRoute> = {
  "/v3/groups": [GROUPME_GROUP],
  "/v3/chats": [GROUPME_CHAT],
  "/v3/groups/group-1/messages": { count: 1, messages: [groupMessageWithAttachment("gmsg-1")] },
  "/v3/direct_messages": { count: 0, direct_messages: [] },
};

/** The required-stream driver: all four required GroupMe streams run through
 * the real collector and are judged by the shared conformance oracle. */
export const GROUPME_ALL_STREAMS_DRIVER: ConnectorDriver = {
  coveredStreams: ["groups", "group_messages", "direct_messages", "direct_chat_messages"],
  run: () => driveGroupMe(GROUPME_NORMAL_ROUTES),
};

/** A non-degenerate empty-direct-inventory fixture. The groups side still
 * completes with one message, so `0/0` on both direct streams is measured
 * absence, not a run that did no work at all. */
export const GROUPME_ZERO_DIRECT_INVENTORY_DRIVER: ConnectorDriver = {
  coveredStreams: ["groups", "group_messages", "direct_messages", "direct_chat_messages"],
  run: () =>
    driveGroupMe({
      "/v3/groups": [GROUPME_GROUP],
      "/v3/chats": [],
      "/v3/groups/group-1/messages": {
        count: 1,
        messages: [
          {
            id: "gmsg-zero-direct",
            text: "group activity",
            created_at: 1_700_000_100,
            user_id: "user-2",
            name: "Fixture Friend",
            avatar_url: null,
            attachments: [],
            favorited_by: [],
            system: false,
          },
        ],
      },
    }),
};

const GROUPME_HIGH_VOLUME_MESSAGES_PER_GROUP = 205;
const GROUPME_HIGH_VOLUME_GROUPS = [
  { ...GROUPME_GROUP, id: "group-1", name: "High Volume One", messages_count: GROUPME_HIGH_VOLUME_MESSAGES_PER_GROUP },
  { ...GROUPME_GROUP, id: "group-2", name: "High Volume Two", messages_count: GROUPME_HIGH_VOLUME_MESSAGES_PER_GROUP },
];

function groupMessagesForHighVolumeFixture(groupId: string): Record<string, unknown>[] {
  return Array.from({ length: GROUPME_HIGH_VOLUME_MESSAGES_PER_GROUP }, (_value, index) => ({
    id: `${groupId}-message-${String(index)}`,
    text: "high-volume fixture message",
    // Newest first, matching GroupMe's documented backward-pagination order.
    created_at: 1_700_000_000 + GROUPME_HIGH_VOLUME_MESSAGES_PER_GROUP - index,
    user_id: "user-2",
    name: "Fixture Friend",
    avatar_url: null,
    attachments: [],
    favorited_by: [],
    system: false,
  }));
}

function highVolumeMessagesRoute(messages: readonly Record<string, unknown>[]): GroupMeRoute {
  return (url) => {
    const beforeId = url.searchParams.get("before_id");
    const start = beforeId === null ? 0 : messages.findIndex((message) => message.id === beforeId) + 1;
    if (beforeId !== null && (start <= 0 || start > messages.length)) {
      throw new Error(`unexpected GroupMe high-volume before_id ${beforeId ?? "<none>"}`);
    }
    const page = messages.slice(start, start + 100);
    return { count: page.length, messages: page };
  };
}

/** Multi-page, multi-group fixture used by the capability pin below. Its
 * exact total makes dropped pages, duplicated pages, and emitted-count
 * substitution observable at the shared terminal boundary. */
export const GROUPME_HIGH_VOLUME_DRIVER: ConnectorDriver = {
  coveredStreams: ["groups", "group_messages", "direct_messages", "direct_chat_messages"],
  run: () =>
    driveGroupMe({
      "/v3/groups": GROUPME_HIGH_VOLUME_GROUPS,
      "/v3/chats": [],
      "/v3/groups/group-1/messages": highVolumeMessagesRoute(groupMessagesForHighVolumeFixture("group-1")),
      "/v3/groups/group-2/messages": highVolumeMessagesRoute(groupMessagesForHighVolumeFixture("group-2")),
    }),
};

/** Not registered in `CONNECTOR_DRIVERS`: `attachments` is `required: false`
 *  in groupme.json, so it never appears in `allRequiredStreamPairs()` — its
 *  proof lives entirely in the dedicated capability-pin tests below, the
 *  same pattern `AMAZON_ZERO_RESULT_DRIVER`/`REDDIT_MALFORMED_DRIVER` use for
 *  claims the aggregate gate's required-stream loop cannot itself express. */
export const GROUPME_ATTACHMENTS_SHORTFALL_DRIVER: ConnectorDriver = {
  coveredStreams: ["attachments"],
  run: () => driveGroupMe(GROUPME_NORMAL_ROUTES),
};

export const GROUPME_ATTACHMENTS_WITHHELD_DRIVER: ConnectorDriver = {
  coveredStreams: ["attachments"],
  run: () =>
    driveGroupMe({
      "/v3/groups": [GROUPME_GROUP],
      "/v3/chats": [GROUPME_CHAT],
      "/v3/groups/group-1/messages": { status: 500, body: { error: "server error" } },
      "/v3/direct_messages": { count: 1, direct_messages: [groupMessageWithAttachment("dmsg-1")] },
    }),
};

// ─── YNAB: ynabCollect via its sanctioned `request` DI seam ────────────────
//
// The only registered `singleton_presence` driver. `ynabCollect`'s second
// parameter is an injectable `request` function (the sole seam, matching
// `ynab()`'s own signature) — production wires the real governed `ynab()`;
// this driver passes a synchronous fake instead, so the run never touches
// `httpGovernor`/`fetch` and never trips `ynabPacingProfile()`'s real
// per-request pacing floor. This is YNAB's own dedicated test seam (see
// connectors/ynab/collect-terminal-coverage.test.ts), not a bypass invented
// for this gate.

const YNAB_BUDGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const YNAB_BUDGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const YNAB_ACCOUNT = "11111111-1111-4111-8111-111111111111";

function ynabAccount(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: "Checking",
    type: "checking",
    on_budget: true,
    closed: false,
    balance: 100_000,
    cleared_balance: 100_000,
    uncleared_balance: 0,
    deleted: false,
    ...overrides,
  };
}

/**
 * Drives `ynabCollect` with the given fake `request`, keyed by path suffix,
 * mirroring connectors/ynab/collect-terminal-coverage.test.ts's own
 * `fakeRequest`. Shared by both capability-pin scenarios below — only the
 * fake `request` differs:
 *   - nonzero: one budget with one account -> real `enumeration_boundary`.
 *   - zero-budget: `ynabCollect` never iterates a budget, so `account_stats`
 *     (a per-budget-derived stream) never stages a coverage claim at all.
 */
async function driveYnabAccountStats(request: <T>(path: string) => Promise<T>): Promise<DriverResult> {
  const { ynabCollect } = await import("../ynab/index.ts");
  const { validateRecord } = await import("../ynab/schemas.ts");

  return runDirectImportDriver(validateRecord, async (harness) => {
    await ynabCollect(
      {
        ...baseCollectContextStubs(harness),
        credentials: { YNAB_PERSONAL_ACCESS_TOKEN: "coverage-conformance" },
        requested: new Map([
          ["accounts", { name: "accounts" }],
          ["account_stats", { name: "account_stats" }],
        ]),
        scope: { streams: [{ name: "accounts" }, { name: "account_stats" }] },
        state: {},
      },
      request
    );
  });
}

function fakeYnabRequestWithOneAccount<T>(path: string): Promise<T> {
  if (path === "/budgets") {
    return Promise.resolve({ data: { budgets: [{ id: YNAB_BUDGET, name: "Fixture Budget" }] } } as T);
  }
  if (path === `/budgets/${YNAB_BUDGET}/accounts`) {
    return Promise.resolve({ data: { accounts: [ynabAccount(YNAB_ACCOUNT)], server_knowledge: 100 } } as T);
  }
  return Promise.reject(new Error(`ynab_http_404 [endpoint ${path}]: not_found`));
}

function fakeYnabRequestWithZeroBudgets<T>(path: string): Promise<T> {
  return path === "/budgets"
    ? Promise.resolve({ data: { budgets: [] } } as T)
    : Promise.reject(new Error(`ynab_http_404 [endpoint ${path}]: not_found`));
}

export const YNAB_ACCOUNT_STATS_ZERO_BUDGETS_DRIVER: ConnectorDriver = {
  coveredStreams: ["account_stats"],
  run: () => driveYnabAccountStats(fakeYnabRequestWithZeroBudgets),
};

/**
 * Two budgets, one malformed account: budget A's account is schema-valid,
 * budget B's account has a non-UUID `id` — `accountStatsRecord`'s `id`
 * (`{account_id}:{observed_on}`, see connectors/ynab/schemas.ts's
 * `accountStatsSchema`) fails the same regex, so `validateRecord` rejects it
 * and `accountStatsCovered` in index.ts's real `collectAccountsAndStats`
 * loop is never incremented for it. This is production's own per-account
 * accounting, not a synthetic envelope: `account_stats` reads
 * considered=2, covered=1 — the exact real YNAB two-budget
 * `singleton_presence` shortfall the coverage-oracle covered-count fix
 * exists to catch (see coverage-conformance.test.ts's aggregate-gate
 * mutation test).
 */
function fakeYnabRequestWithTwoBudgetsOneMalformedAccount<T>(path: string): Promise<T> {
  if (path === "/budgets") {
    return Promise.resolve({
      data: {
        budgets: [
          { id: YNAB_BUDGET, name: "Fixture Budget A" },
          { id: YNAB_BUDGET_B, name: "Fixture Budget B" },
        ],
      },
    } as T);
  }
  if (path === `/budgets/${YNAB_BUDGET}/accounts`) {
    return Promise.resolve({ data: { accounts: [ynabAccount(YNAB_ACCOUNT)], server_knowledge: 100 } } as T);
  }
  if (path === `/budgets/${YNAB_BUDGET_B}/accounts`) {
    return Promise.resolve({ data: { accounts: [ynabAccount("not-a-uuid")], server_knowledge: 100 } } as T);
  }
  return Promise.reject(new Error(`ynab_http_404 [endpoint ${path}]: not_found`));
}

export const YNAB_ACCOUNT_STATS_TWO_BUDGETS_ONE_MALFORMED_DRIVER: ConnectorDriver = {
  coveredStreams: ["account_stats"],
  run: () => driveYnabAccountStats(fakeYnabRequestWithTwoBudgetsOneMalformedAccount),
};

export interface ConnectorDriver {
  /** Manifest stream names this driver actually exercises. A driver may
   *  cover a subset of the connector's required streams; the gate reports
   *  the remainder unexercised. */
  coveredStreams: readonly string[];
  run: () => Promise<DriverResult>;
}

export const CONNECTOR_DRIVERS: Record<string, ConnectorDriver> = {
  amazon: { coveredStreams: ["orders"], run: driveAmazon },
  apple_contacts: {
    coveredStreams: ["address_books", "contacts", "contact_groups"],
    run: driveAppleContacts,
  },
  google_messages: { coveredStreams: ["messages"], run: driveGoogleMessages },
  groupme: GROUPME_ALL_STREAMS_DRIVER,
  jellyfin: { coveredStreams: ["libraries", "items"], run: driveJellyfin },
  reddit: {
    coveredStreams: ["submitted", "comments", "saved", "upvoted", "downvoted", "hidden"],
    run: driveReddit,
  },
  ynab: { coveredStreams: ["account_stats"], run: () => driveYnabAccountStats(fakeYnabRequestWithOneAccount) },
};

/**
 * Standalone drivers used only by their respective discriminating tests —
 * not registered in `CONNECTOR_DRIVERS` (the aggregate gate exercises each
 * connector once, via its normal nonzero fixture above).
 */
export const AMAZON_ZERO_RESULT_DRIVER: ConnectorDriver = {
  coveredStreams: ["orders"],
  run: driveAmazonZeroResult,
};

/**
 * Every one of Reddit's 6 streams sees one considered, schema-invalid
 * record; proves the gate correctly fails these streams (unresolved_attempt)
 * rather than laundering a validation-rejected record into proven coverage.
 */
export const REDDIT_MALFORMED_DRIVER: ConnectorDriver = {
  coveredStreams: ["submitted", "comments", "saved", "upvoted", "downvoted", "hidden"],
  run: driveRedditMalformed,
};

// ─── Ratchet: the exact set of required proof-demanding streams this gate ──
// ─── currently cannot exercise, checked in so the gap cannot silently grow ──
//
// Every (connector, stream) pair a production-ready or real-unlisted
// connector declares as required with a proof-demanding coverage_strategy,
// that has no registered driver above (or whose driver does not cover it),
// MUST appear here. The conformance test fails on two independent kinds of
// drift:
//   1. a NEW unlisted gap — a stream became proof-required and unexercised
//      (a new connector shipped, or a manifest edit widened requiredness)
//      without a deliberate entry here;
//   2. a STALE listed entry — a driver now covers a stream still listed
//      here, so the list must shrink, not silently keep a now-exercised
//      stream "grandfathered" as unexercised forever.
// This is the mechanism that stops "no driver yet" from being a permanent,
// silent bypass: growing this list is a visible, reviewable diff, and
// shrinking it is enforced automatically the moment a driver exists.
export const KNOWN_UNEXERCISED_COVERAGE: ReadonlySet<string> = new Set([
  // Amazon: order_items (parent_detail_accounting) needs a browser detail-page
  // stub distinct from the orders driver above; not yet built.
  "amazon.order_items",
  // Apple Health / Apple Photos (REAL_UNLISTED_CONNECTORS): filesystem/export
  // snapshot-import receipts, no driver yet.
  "apple_health.records",
  "apple_health.workouts",
  "apple_photos.photos",
  // Chase (browser + auth-walled; no credential-free fixture yet).
  "chase.accounts",
  "chase.current_activity",
  "chase.transactions",
  "chase.statements",
  "chase.balances",
  // ChatGPT (browser-session-backed; no credential-free fixture yet).
  "chatgpt.conversations",
  "chatgpt.memories",
  "chatgpt.custom_gpts",
  "chatgpt.shared_conversations",
  "chatgpt.messages",
  "chatgpt.custom_instructions",
  // Local-device collectors — filesystem rollout scan, no comparable HTTP/
  // browser boundary this gate's driver shapes cover yet.
  "claude_code.sessions",
  "claude_code.messages",
  "claude_code.attachments",
  "claude_code.memory_notes",
  "claude_code.skills",
  "claude_code.slash_commands",
  "codex.sessions",
  "codex.messages",
  "codex.function_calls",
  "codex.rules",
  "codex.prompts",
  "codex.skills",
  "codex.coverage_diagnostics",
  // API connectors with no driver registered yet.
  "github.repositories",
  "github.starred",
  "github.issues",
  "github.pull_requests",
  "github.gists",
  "github.user",
  "github.user_stats",
  "gmail.messages",
  "gmail.threads",
  "gmail.labels",
  "gmail.attachments",
  "google_calendar.calendars",
  "google_calendar.events",
  "google_contacts.people",
  "google_contacts.contact_groups",
  "google_maps.timeline_points",
  "google_maps_data_portability.archive_jobs",
  // Google Takeout (REAL_UNLISTED_CONNECTORS): export-file snapshot-import
  // receipts, no driver yet.
  "google_takeout.location_history",
  "google_takeout.youtube_watch_history",
  "google_takeout.search_history",
  "google_takeout.photos",
  // Pocket is retained as a Development parser, but Mozilla shut down the
  // upstream API; no live driver can exercise a collection boundary.
  "pocket.items",
  "heb.orders",
  "heb.order_items",
  // iCal / iMessage (REAL_UNLISTED_CONNECTORS): file-based import receipts, no
  // driver yet.
  "ical.events",
  "imessage.messages",
  "notion.pages",
  "notion.databases",
  "oura.sleep",
  "oura.readiness",
  "oura.activity",
  "slack.channels",
  "slack.channel_memberships",
  "slack.channel_stats",
  "slack.workspace",
  "slack.users",
  "slack.messages",
  "slack.message_attachments",
  "slack.reactions",
  "slack.files",
  "slack.canvases",
  "spotify.playlists",
  "spotify.saved_tracks",
  "spotify.top_artists",
  "spotify.recently_played",
  "strava.activities",
  // Twitter archive (REAL_UNLISTED_CONNECTORS): zip-import snapshot receipts,
  // no driver yet.
  "twitter_archive.tweets",
  "twitter_archive.direct_messages",
  "usaa.accounts",
  "usaa.account_stats",
  "usaa.transactions",
  "usaa.statements",
  "usaa.inbox_messages",
  "usaa.credit_card_billing",
  "usaa.credit_card_billing_stats",
  "venmo.profile",
  "venmo.friends",
  "venmo.transactions",
  // WHOOP (Preview): the owner-visible browser connector has a real
  // integration suite, but no credential-free coverage driver yet.
  "whoop.profile",
  "whoop.cycles",
  "whoop.recoveries",
  "whoop.sleeps",
  "whoop.workouts",
  "whoop.body",
  // WhatsApp (REAL_UNLISTED_CONNECTORS is not it — production-ready — but no
  // driver yet): export-file based, no credential-free fixture built.
  "whatsapp.chats",
  "whatsapp.messages",
  "whatsapp.attachments",
  // YNAB: module-level paced HTTP governor (createConnectorHttpGovernor,
  // 20s floor interval) for every stream except account_stats, which this
  // gate drives through ynabCollect's own DI seam (see driveYnabAccountStats
  // above). YNAB's own dedicated per-stream suites (accounts.test.ts,
  // budgets-considered.test.ts, category-groups-checkpoint.test.ts,
  // scheduled-transactions-coverage.test.ts, collect-terminal-coverage.test.ts,
  // etc.) are the proof surface for the remaining streams.
  "ynab.budgets",
  "ynab.accounts",
  "ynab.category_groups",
  "ynab.categories",
  "ynab.payees",
  "ynab.payee_locations",
  "ynab.transactions",
  "ynab.scheduled_transactions",
  "ynab.months",
  "ynab.month_categories",
]);
