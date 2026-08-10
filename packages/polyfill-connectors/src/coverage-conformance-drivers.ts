// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-connector fixture drivers for `coverage-conformance.test.ts`.
 *
 * Each driver exercises a connector's REAL collection code — the same
 * `index.ts` entrypoint or exported orchestration function its own
 * integration test drives — against synthetic, credential-free fixtures
 * (a fake local HTTP/CardDAV server, a scripted fetch, or an in-memory page
 * stub). No connector source file is modified: every driver reaches the
 * connector only through an already-public surface (an exported function,
 * or the real stdin/stdout Collection Profile protocol via
 * `runConnectorProtocolSubprocess`).
 *
 * A driver returns `{ exercised: true, messages }` when it successfully ran
 * the connector to a real DONE (or the exported orchestration function
 * completed) and captured the emitted protocol messages. It returns
 * `{ exercised: false, reason }` when no cheap, deterministic, credential-free
 * fixture path exists — the gate reports that honestly rather than asserting
 * anything about a stream it never touched.
 *
 * Deliberately excluded: YNAB. Its module-level HTTP governor
 * (`createConnectorHttpGovernor` in connectors/ynab/index.ts) paces every
 * request — including requests made by directly calling an exported
 * per-stream collection function — through a real GCRA bucket with a
 * 20-second floor interval and no test-mode bypass. Driving it here would
 * make this shared gate either slow (tens of seconds per stream) or flaky
 * (a shared module-level governor instance across sequential in-process
 * calls), neither of which belongs in a fast, deterministic CI gate. YNAB's
 * own dedicated suites (e.g. scheduled-transactions-coverage.test.ts,
 * budgets-considered.test.ts) already prove/disprove DETAIL_COVERAGE
 * per-stream against the real production callback; this gate defers to them
 * and reports YNAB's required full_inventory streams as unexercised here
 * rather than re-running (or worse, crudely bypassing) that pacing.
 *
 * This module intentionally covers only the connectors this gate can
 * currently drive cheaply (a few seconds, no real network pacing) without
 * live credentials. Every other production-ready connector's required
 * full_inventory/checkpoint_window streams are reported `unexercised`, not
 * silently skipped and not assumed broken.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "./connector-runtime-protocol.ts";
import { makeRecordingEmit } from "./test-harness.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * A record `emitRecord()` rejected via schema validation — the direct-call
 * counterpart of a real runtime SKIP_RESULT. Drivers that call a connector's
 * exported function directly (Reddit, Amazon) use `makeRecordingEmit`, whose
 * `emitRecord` shape-check failures land in its own `.skipped` bookkeeping
 * array, NOT in the `messages`/`emit()` stream — the real runtime would emit
 * an actual SKIP_RESULT protocol message for the same failure, but
 * `makeRecordingEmit` (by design, for ordinary unit tests) never
 * synthesizes one. A driver MUST surface these here so
 * `deriveStreamEnvelope` sees the same "this stream had an unresolved
 * validation failure" fact the runtime's SKIP_RESULT would carry — omitting
 * this silently drops evidence and lets a stream with 100% invalid records
 * still read as `checkpoint_only`/`enumeration_boundary` proven, because the
 * shared oracle never saw the failure.
 */
export interface SkippedRecordFact {
  readonly stream: string;
}

export type DriverResult =
  | { exercised: true; messages: readonly EmittedMessage[]; skippedRecords?: readonly SkippedRecordFact[] }
  | { exercised: false; reason: string };

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
  emit: (msg: EmittedMessage) => Promise<void>,
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>
) {
  return {
    assist: () => Promise.reject(new Error("assist not implemented in coverage-conformance driver")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    // biome-ignore lint/suspicious/noExplicitAny: no real Playwright BrowserContext exists in this fixture; collectAllStreams never reads `context` (only `page`), so an empty stand-in is honest, not a disguised real value.
    context: {} as any,
    credentials: { REDDIT_USERNAME: "coverage-conformance" },
    detailGaps: [],
    emit,
    emitRecord,
    emittedAt: "2026-04-24T12:00:00.000Z",
    // biome-ignore lint/suspicious/noExplicitAny: no real Playwright Page exists in this fixture; only the one evaluate() call collectAllStreams's private redditFetch makes is implemented, matching Reddit's own createMockPageForFetch in integration.test.ts.
    page: createMockRedditPage(fetchPath) as any,
    progress: async () => undefined,
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map(REDDIT_REQUESTED_STREAMS.map((name) => [name, { name }])),
    scope: { streams: REDDIT_REQUESTED_STREAMS.map((name) => ({ name })) },
    sendInteraction: () => Promise.reject(new Error("sendInteraction not implemented in coverage-conformance driver")),
    state: {},
  };
}

async function driveReddit(): Promise<DriverResult> {
  const { collectAllStreams } = await import("../connectors/reddit/index.ts");
  const { validateRecord } = await import("../connectors/reddit/schemas.ts");

  const harness = makeRecordingEmit(validateRecord);
  const messages: EmittedMessage[] = [];
  const emit = (msg: EmittedMessage): Promise<void> => {
    messages.push(msg);
    return harness.emit(msg);
  };

  // submitted.json needs a t3 post; every other endpoint (comments, saved,
  // upvoted, downvoted, hidden) needs a t1 comment — see submittedRecord /
  // commentRecord / savedRecord / voteRecord in buildStreamTable's toRecord.
  const postListing = { data: { children: [validRedditPost()], after: null } };
  const commentListing = { data: { children: [validRedditComment()], after: null } };
  const fetchPath = (path: string) =>
    Promise.resolve({ status: 200, json: path.includes("/submitted.json") ? postListing : commentListing });

  await collectAllStreams(buildRedditCollectContext(fetchPath, emit, harness.emitRecord));

  return {
    exercised: true,
    messages,
    skippedRecords: harness.skipped.map((s) => ({ stream: s.stream })),
  };
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
  const { collectAllStreams } = await import("../connectors/reddit/index.ts");
  const { validateRecord } = await import("../connectors/reddit/schemas.ts");

  const harness = makeRecordingEmit(validateRecord);
  const messages: EmittedMessage[] = [];
  const emit = (msg: EmittedMessage): Promise<void> => {
    messages.push(msg);
    return harness.emit(msg);
  };

  const malformedPost = { kind: "t3" as const, data: { ...validRedditPost().data, name: "t3_has_underscore" } };
  const malformedComment = { kind: "t1" as const, data: { ...validRedditComment().data, name: "t1_has_underscore" } };
  const postListing = { data: { children: [malformedPost], after: null } };
  const commentListing = { data: { children: [malformedComment], after: null } };
  const fetchPath = (path: string) =>
    Promise.resolve({ status: 200, json: path.includes("/submitted.json") ? postListing : commentListing });

  await collectAllStreams(buildRedditCollectContext(fetchPath, emit, harness.emitRecord));

  return {
    exercised: true,
    messages,
    skippedRecords: harness.skipped.map((s) => ({ stream: s.stream })),
  };
}

// ─── Jellyfin: real subprocess entrypoint against a fake local HTTP server ──
//
// Jellyfin has no rate governor and no auth token exchange delay — the real
// entrypoint completes against a same-host fake HTTP server in ~1s, exactly
// as connectors/jellyfin/protocol-subprocess.test.ts already proves.

async function driveJellyfin(): Promise<DriverResult> {
  const { createServer } = await import("node:http");
  const { runConnectorProtocolSubprocess } = await import("./test-harness.ts");

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
  const { runConnectorProtocolSubprocess } = await import("./test-harness.ts");
  const { buildVCard, startFakeCardDavServer } = await import("../connectors/apple_contacts/test-carddav-server.ts");

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

// ─── Amazon: emitOrderAndItems/emitOrdersCoverage, no browser required ────
//
// No governor, no network: these are pure exported functions the connector's
// own collect() calls directly, matching connectors/amazon/integration.test.ts.

async function driveAmazon(): Promise<DriverResult> {
  const { emitOrderAndItems, emitOrdersCoverage, newOrdersCoverage } = await import("../connectors/amazon/index.ts");
  const { validateRecord } = await import("../connectors/amazon/schemas.ts");

  const harness = makeRecordingEmit(validateRecord);
  const messages: EmittedMessage[] = [];
  const emit = (msg: EmittedMessage): Promise<void> => {
    messages.push(msg);
    return harness.emit(msg);
  };

  const ordersCoverage = newOrdersCoverage();
  const deps = {
    capture: null,
    emit,
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

  return { exercised: true, messages, skippedRecords: harness.skipped.map((s) => ({ stream: s.stream })) };
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
  const { emitOrdersCoverage, newOrdersCoverage } = await import("../connectors/amazon/index.ts");
  const { validateRecord } = await import("../connectors/amazon/schemas.ts");

  const harness = makeRecordingEmit(validateRecord);
  const messages: EmittedMessage[] = [];
  const emit = (msg: EmittedMessage): Promise<void> => {
    messages.push(msg);
    return harness.emit(msg);
  };

  const ordersCoverage = newOrdersCoverage();
  const deps = {
    capture: null,
    emit,
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

  return { exercised: true, messages, skippedRecords: harness.skipped.map((s) => ({ stream: s.stream })) };
}

export interface ConnectorDriver {
  /** Manifest stream names this driver actually exercises. A driver may
   *  cover a subset of the connector's required full_inventory/
   *  checkpoint_window streams; the gate reports the remainder unexercised. */
  coveredStreams: readonly string[];
  run: () => Promise<DriverResult>;
}

export const CONNECTOR_DRIVERS: Record<string, ConnectorDriver> = {
  amazon: { coveredStreams: ["orders"], run: driveAmazon },
  apple_contacts: {
    coveredStreams: ["address_books", "contacts", "contact_groups"],
    run: driveAppleContacts,
  },
  jellyfin: { coveredStreams: ["libraries", "items"], run: driveJellyfin },
  reddit: {
    coveredStreams: ["submitted", "comments", "saved", "upvoted", "downvoted", "hidden"],
    run: driveReddit,
  },
};

/**
 * A second, standalone driver used only by the zero-result discriminating
 * test — not registered in CONNECTOR_DRIVERS (the aggregate gate exercises
 * each connector once, via its normal nonzero fixture).
 */
export const AMAZON_ZERO_RESULT_DRIVER: ConnectorDriver = {
  coveredStreams: ["orders"],
  run: driveAmazonZeroResult,
};

/**
 * A third, standalone driver used only by the mutation counterexample test
 * — not registered in CONNECTOR_DRIVERS. Every one of Reddit's 6 streams
 * sees one considered, schema-invalid record; proves the gate correctly
 * fails these streams (unresolved_attempt) rather than laundering a
 * validation-rejected record into proven coverage.
 */
export const REDDIT_MALFORMED_DRIVER: ConnectorDriver = {
  coveredStreams: ["submitted", "comments", "saved", "upvoted", "downvoted", "hidden"],
  run: driveRedditMalformed,
};

// ─── Ratchet: the exact set of required proof-demanding streams this gate ──
// ─── currently cannot exercise, checked in so the gap cannot silently grow ──
//
// Every (connector, stream) pair a production-ready or real-unlisted
// connector declares as required full_inventory/checkpoint_window, that has
// no registered driver above (or whose driver does not cover it), MUST
// appear here. The conformance test fails on two independent kinds of
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
  // Google Messages / Google Takeout (REAL_UNLISTED_CONNECTORS): export-file
  // snapshot-import receipts, no driver yet.
  "google_messages.messages",
  "google_takeout.location_history",
  "google_takeout.youtube_watch_history",
  "google_takeout.search_history",
  "google_takeout.photos",
  "groupme.groups",
  "groupme.group_messages",
  "groupme.direct_messages",
  "groupme.direct_chat_messages",
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
  // WhatsApp (REAL_UNLISTED_CONNECTORS is not it — production-ready — but no
  // driver yet): export-file based, no credential-free fixture built.
  "whatsapp.chats",
  "whatsapp.messages",
  "whatsapp.attachments",
  // YNAB: module-level paced HTTP governor (createConnectorHttpGovernor,
  // 20s floor interval) — see the module doc above for why this gate does
  // not drive it. YNAB's own dedicated per-stream suites
  // (accounts.test.ts, budgets-considered.test.ts,
  // category-groups-checkpoint.test.ts, scheduled-transactions-coverage.test.ts,
  // etc.) are the proof surface for these streams.
  "ynab.budgets",
  "ynab.accounts",
  "ynab.account_stats",
  "ynab.category_groups",
  "ynab.categories",
  "ynab.payees",
  "ynab.payee_locations",
  "ynab.transactions",
  "ynab.scheduled_transactions",
  "ynab.months",
  "ynab.month_categories",
]);
