// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runConnector } from "../runtime/index.ts";
import { parsePendingConsentRequestUri, registerConnector } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { ingestRecord } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import {
  admitOwnerRunConnection,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";
import {
  TEST_INTROSPECTION_SERVER_OPTS,
  TEST_RS_INTROSPECTION_CREDENTIALS,
} from "./helpers/introspection-test-credentials.ts";

type RuntimeConnectorManifest = NonNullable<Parameters<typeof runConnector>[0]["manifest"]>;

const TOP_LEVEL_REGEX_1 = /Reference trace ID: (trc_[A-Za-z0-9]+)/;
const TOP_LEVEL_REGEX_2 = /^warning: "pdpp trace show" is deprecated; use "pdpp ref trace show" instead\.$/m;
const TOP_LEVEL_REGEX_3 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_4 = /User code: ([A-Z0-9]+)/;
const TOP_LEVEL_REGEX_5 = /Verification URI:/;
const TOP_LEVEL_REGEX_6 = /User code: ([A-Z0-9]+)/;
const TOP_LEVEL_REGEX_7 = /Verification URI:/;
const TOP_LEVEL_REGEX_8 = /The resource owner denied the request/;
const TOP_LEVEL_REGEX_9 = /Request ID: req_/;
const TOP_LEVEL_REGEX_10 = /Reference trace ID: trc_/;
const TOP_LEVEL_REGEX_11 = /Registered client cli_longview is malformed or no longer valid/;
const TOP_LEVEL_REGEX_12 = /Request ID: req_/;
const TOP_LEVEL_REGEX_13 = /Reference trace ID: trc_/;
const TOP_LEVEL_REGEX_14 = /denied the request/;
const TOP_LEVEL_REGEX_15 = /malformed or no longer valid/;
const TOP_LEVEL_REGEX_16 = /Invalid initial access token/;
const TOP_LEVEL_REGEX_17 = /Request ID: (req_[A-Za-z0-9]+)/;
const TOP_LEVEL_REGEX_18 = /redirect_uris must be a valid absolute URI/;
const TOP_LEVEL_REGEX_19 = /Request ID: (req_[A-Za-z0-9]+)/;
const TOP_LEVEL_REGEX_20 = /Reference trace ID: (trc_[A-Za-z0-9]+)/;
const TOP_LEVEL_REGEX_21 = /redirect_uris must be a valid absolute URI/;
const TOP_LEVEL_REGEX_22 = /Unsupported token_endpoint_auth_method: client_secret_basic/;
const TOP_LEVEL_REGEX_23 = /Unsupported application_type/i;
const TOP_LEVEL_REGEX_24 = /Unsupported grant_types/i;
const TOP_LEVEL_REGEX_25 = /Unsupported response_types/i;
const TOP_LEVEL_REGEX_26 = /Unsupported client metadata fields: jwks_uri, scope/;
const TOP_LEVEL_REGEX_27 = /redirect_uris must be a valid absolute URI/;
const TOP_LEVEL_REGEX_28 = /client_uri must be a valid absolute URI/;
const TOP_LEVEL_REGEX_29 = /manifest\.storage_binding must include only connector_id/;
const TOP_LEVEL_REGEX_30 = /connector manifests must not include storage_binding/;
const TOP_LEVEL_REGEX_31 = /request\.storage_binding must include only connector_id/;
const TOP_LEVEL_REGEX_32 = /request\.source_binding\.id must match request\.storage_binding\.connector_id/;
const TOP_LEVEL_REGEX_33 = /grant\.source must include only kind and id/;
const TOP_LEVEL_REGEX_34 = /grant\.grant_storage_binding must include only connector_id/;
const TOP_LEVEL_REGEX_35 = /grant\.source\.id must match grant\.grant_storage_binding\.connector_id/;
const TOP_LEVEL_REGEX_36 = /Registered client .* malformed or no longer valid/;
const TOP_LEVEL_REGEX_37 = /Request ID: req_/;
const TOP_LEVEL_REGEX_38 = /Reference trace ID: trc_/;
const TOP_LEVEL_REGEX_39 = /malformed or no longer valid/;
const TOP_LEVEL_REGEX_40 = /Unknown client_id/;
const TOP_LEVEL_REGEX_42 = /Access Denied/;
const TOP_LEVEL_REGEX_43 = /Access Denied/;
const TOP_LEVEL_REGEX_44 = /Unsupported request fields: redirect_uri, response_type/;
const TOP_LEVEL_REGEX_45 = /Selection request is invalid: \/streams\/0 must NOT be valid/;
const TOP_LEVEL_REGEX_46 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_47 = /Request ID: (req_[A-Za-z0-9]+)/;
const TOP_LEVEL_REGEX_48 = /Reference trace ID: (trc_[A-Za-z0-9]+)/;
const TOP_LEVEL_REGEX_49 = /Invalid initial access token/;
const TOP_LEVEL_REGEX_50 = /Source kind does not match the retained declaration/;
const TOP_LEVEL_REGEX_51 = /Unknown source/;
const TOP_LEVEL_REGEX_52 = /Selection request is invalid: .*additional properties.*source\/id must match format "uri"/s;
const TOP_LEVEL_REGEX_53 = /Registered client:/;
const TOP_LEVEL_REGEX_54 = /User code: ([A-Z0-9]+)/;
const TOP_LEVEL_REGEX_55 = /is not scoped to stream saved_tracks/;
const TOP_LEVEL_REGEX_56 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_57 = /Request ID: (req_[A-Za-z0-9]+)/;
const TOP_LEVEL_REGEX_58 = /Reference trace ID: (trc_[A-Za-z0-9]+)/;
const TOP_LEVEL_REGEX_59 = /view and fields are mutually exclusive/;
const TOP_LEVEL_REGEX_60 = /view and fields are mutually exclusive/;
const TOP_LEVEL_REGEX_61 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_62 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_63 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_64 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_65 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_66 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_67 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_68 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_69 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_70 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_71 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_72 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_73 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_74 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_CLIENT_FILTER_UNSUPPORTED =
  /filter\[\.\.\.\] is not supported for client-token reads in PDPP v0\.1/;
const TOP_LEVEL_REGEX_INTROSPECTION_FAILED = /Token introspection failed closed/;
const TOP_LEVEL_REGEX_INVALID_TOKEN = /Invalid or expired token/;
const TOP_LEVEL_REGEX_77 = /Record not found/;
const TOP_LEVEL_REGEX_78 = /Record not found/;
const TOP_LEVEL_REGEX_82 = /Record not found/;
const TOP_LEVEL_REGEX_83 = /Record not found/;
const TOP_LEVEL_REGEX_84 = /invalid INTERACTION.kind/;
const TOP_LEVEL_REGEX_85 = /invalid INTERACTION\.schema/;
const TOP_LEVEL_REGEX_86 = /invalid PROGRESS\.total/;
const TOP_LEVEL_REGEX_87 = /PROGRESS for undeclared stream/;
const TOP_LEVEL_REGEX_88 = /SKIP_RESULT for undeclared stream/;
const TOP_LEVEL_REGEX_89 = /Connector emitted invalid JSONL while waiting for INTERACTION_RESPONSE:/;
const TOP_LEVEL_REGEX_90 = /State persistence failed for other_items: 500/;
const TOP_LEVEL_REGEX_91 = /Unknown connector: missing_spotify_connector/;
const TOP_LEVEL_REGEX_92 = /Unknown connector: missing_spotify_connector/;
const TOP_LEVEL_REGEX_93 = /view and fields are mutually exclusive/;
const TOP_LEVEL_REGEX_94 = /Request ID: req_/;
const TOP_LEVEL_REGEX_95 = /Reference trace ID: trc_/;
const TOP_LEVEL_REGEX_96 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_97 = /Request ID: req_/;
const TOP_LEVEL_REGEX_98 = /Reference trace ID: trc_/;
const TOP_LEVEL_REGEX_99 = /Grant has been revoked/;
const TOP_LEVEL_REGEX_100 = /Request ID: req_/;
const TOP_LEVEL_REGEX_101 = /Reference trace ID: trc_/;
const TOP_LEVEL_REGEX_102 = /Grant has expired/;
const TOP_LEVEL_REGEX_103 = /Request ID: req_/;
const TOP_LEVEL_REGEX_104 = /Reference trace ID: trc_/;
const TOP_LEVEL_REGEX_105 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_106 = /Grant has been revoked/;
const TOP_LEVEL_REGEX_107 = /Grant has expired/;
const TOP_LEVEL_REGEX_108 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_109 = /Grant has been revoked/;
const TOP_LEVEL_REGEX_110 = /Grant has expired/;
const TOP_LEVEL_REGEX_111 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_112 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_113 = /Grant is malformed or no longer valid/;
const TOP_LEVEL_REGEX_114 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_115 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_116 = /view and fields are mutually exclusive/;
const TOP_LEVEL_REGEX_117 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_118 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_119 = /view and fields are mutually exclusive/;
const TOP_LEVEL_REGEX_120 = /Unknown source: missing_spotify_connector/;
const TOP_LEVEL_REGEX_121 = /Request ID: req_/;
const TOP_LEVEL_REGEX_122 = /Reference trace ID: trc_qry_/;
const TOP_LEVEL_REGEX_123 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_124 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_125 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_126 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_127 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_128 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_129 = /Stream 'not_a_stream' not found/;
const TOP_LEVEL_REGEX_130 = /Request ID: req_/;
const TOP_LEVEL_REGEX_131 = /Reference trace ID: trc_qry_/;
const TOP_LEVEL_REGEX_132 = /Request ID: (req_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_133 = /Reference trace ID: (trc_[A-Za-z0-9_]+)/;
const TOP_LEVEL_REGEX_134 = /Stream 'not_a_stream' not found/;
const TOP_LEVEL_REGEX_135 = /connector_id must be a single non-empty string for polyfill owner access/;
const TOP_LEVEL_REGEX_136 = /request\.source_binding must include only kind and id/;
const TOP_LEVEL_REGEX_137 =
  /Missing introspection caller credentials: set PDPP_RS_INTROSPECTION_CLIENT_ID and PDPP_RS_INTROSPECTION_CLIENT_SECRET/;
const CLI_GRANT_FIXTURE_OWNER_SUBJECTS = ["cli_owner", "u1", "employee_1"] as const;

const execFile = promisify(execFileCallback);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const CLI_PATH = join(REFERENCE_IMPL_DIR, "cli/index.ts");
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

type TestServer = Awaited<ReturnType<typeof startServer>>;

interface CloseableHttpServer {
  close: (cb: (err?: Error) => void) => void;
  closeAllConnections?: () => void;
}

// Manifest shape varies per fixture file (manifests/spotify.json,
// manifests/northstar-hr.json) — only `connector_id` is load-bearing for
// callers of withHarness/withNativeHarness.
interface TestManifest {
  readonly connector_id: string;
  readonly name?: string;
  readonly provider_id?: string;
  readonly source_declaration?: {
    readonly protocol_version: string;
    readonly streams: readonly Record<string, unknown>[];
  };
  readonly storage_binding?: { readonly connector_id: string };
  readonly version?: string;
  readonly [key: string]: unknown;
}

interface HarnessContext {
  readonly asUrl: string;
  readonly rsUrl: string;
  readonly spotifyManifest: TestManifest;
}

interface NativeHarnessContext {
  readonly asUrl: string;
  readonly nativeManifest: TestManifest;
  readonly rsUrl: string;
}

interface JsonResponse<T> {
  readonly body: T;
  readonly status: number;
}

// Every JSON body this suite reads narrows to one of a handful of shapes
// (PAR/consent/token/device envelopes, connector/grant/run detail
// projections) — modeled here once rather than per call site.
// `[key: string]: unknown` keeps the door open for fields individual tests
// read that aren't part of the shared contract.
interface GenericJsonBody {
  readonly access_token?: string;
  readonly connector_id?: string;
  readonly device_code?: string;
  readonly grant_id?: string;
  readonly records?: readonly Record<string, unknown>[];
  readonly request_uri?: string;
  readonly state?: Record<string, unknown> | null;
  readonly user_code?: string;
  readonly [key: string]: unknown;
}

// Spine/audit-trail event — mirrors RefSpineEventsPageEnvelope's `data`
// (operations/ref-spine-events-page/index.ts), which is intentionally
// `Record<string, unknown>` since events are heterogeneous. Only the
// fields this suite reads at the top level are modeled; `data` narrows
// further per event kind via `asRecord()`.
interface SpineEvent {
  readonly client_id?: string;
  readonly data?: Record<string, unknown>;
  readonly event_type: string;
  readonly object_id?: string;
  readonly object_type?: string;
  readonly request_id?: string;
  readonly stream_id?: string;
  readonly trace_id?: string;
  readonly [key: string]: unknown;
}

// `pdpp <cmd> --format json` stdout — a different envelope shape per
// subcommand (trace/timeline listings carry `data: SpineEvent[]`, others
// carry scalar fields like `active`/`grant_id`). Typing `data` as
// `readonly SpineEvent[]` covers every `(X.json.data || []).find(...)`
// call site in this suite; the catch-all index signature covers the
// remaining ~50 scalar fields individual tests read.
interface CliJsonBody {
  readonly client_id?: string;
  readonly data?: readonly SpineEvent[];
  readonly reference_trace_id?: string;
  readonly request_id?: string;
  readonly [key: string]: unknown;
}

// RS record-listing page (`GET /v1/streams/:stream/records`). `data` carries
// the connector-authored record body — heterogeneous by design.
interface RsRecord {
  readonly data?: Record<string, unknown>;
  readonly id?: string;
  readonly [key: string]: unknown;
}

interface RsRecordsPage {
  readonly data?: readonly RsRecord[];
  readonly records?: readonly RsRecord[];
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object", "expected an object payload");
  return value as Record<string, unknown>;
}

// `http.createServer(...).address()` is `string | net.AddressInfo | null` —
// `null` only before `listen()` resolves and `string` only for a Unix
// socket path, neither of which this suite's `listen(0, ...)` usage
// produces (always a TCP ephemeral port).
function serverPort(server: { address: () => { port: number } | string | null }): number {
  const address = server.address();
  assert.ok(address && typeof address === "object", "expected an AddressInfo from a TCP listener");
  return address.port;
}

// The `err` thrown by a rejected `runConnector()` call is a plain `Error`
// with ad-hoc properties bolted on at the throw site (e.g.
// `err.failure_reason = failureReason;` in runtime/index.ts) — untyped by
// construction, same category as SpineEvent.
interface RuntimeRunConnectorError extends Error {
  readonly checkpoint_summary?: Record<string, unknown> | null;
  readonly client_id?: string;
  readonly data?: Record<string, unknown>;
  readonly failure_reason?: string;
  readonly object_id?: string;
  readonly object_type?: string;
  readonly run_id?: string | null;
  readonly terminal_reason?: string | null;
}

function asRuntimeError(err: unknown): RuntimeRunConnectorError {
  assert.ok(err instanceof Error, "runConnector rejection must be an Error");
  return err as RuntimeRunConnectorError;
}

// `run_id` is `string | null` on both RuntimeRunConnectorResult and the
// ad-hoc RuntimeRunConnectorError, but every call site here fetches the
// run's own timeline/detail right after starting/rejecting it — a real
// invariant that the id is present by then, not a loosened type.
function requireRunId(source: { run_id?: string | null } | undefined): string {
  assert.ok(source?.run_id, "expected run_id to be present for CLI lookup");
  return source.run_id;
}

// A successful PAR initiation (status 201) always returns a request_uri —
// GenericJsonBody types it optional since not every JSON response carries
// one, but this suite only reads it off startGrantRequest()'s own body.
function requireRequestUri(body: { request_uri?: string }): string {
  assert.ok(body.request_uri, "expected request_uri from a successful PAR initiation");
  return body.request_uri;
}

// Params accepted by startGrantRequest/approveGrant — a subset of the real
// PAR authorization_details shape, loose because individual tests vary
// which optional fields (retention, provider_id vs connector_id, etc.)
// they set.
interface GrantRequestParams {
  readonly access_mode: string;
  readonly client_display?: { readonly name: string };
  readonly client_id: string;
  readonly connector_id?: string;
  readonly provider_id?: string;
  readonly purpose_code: string;
  readonly purpose_description: string;
  readonly retention?: unknown;
  readonly source?: Record<string, unknown>;
  readonly streams: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

// approveGrant()'s return is the real /consent/approve response body — see
// the ConsentStore.approveGrant() return type in server/routes/as-consent.ts
// (`{ grant: { grant_id, ... }, token, package?, package_id? }`). `token`
// is genuinely required on a successful approval.
interface ApprovedGrant {
  readonly grant: {
    readonly grant_id: string;
    readonly source?: Record<string, unknown>;
    readonly client?: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
  readonly package?: boolean;
  readonly package_id?: string;
  readonly token: string;
  readonly [key: string]: unknown;
}

// Registering the URL-shaped spotify manifest stores the catalog row,
// connector_instances, and records under the canonical connector key
// (Decision 1). The owner read/mutation/state routes canonicalize the
// connector id at the boundary, so error messages and trace source
// descriptors carry this canonical key. Raw-SQL fixtures that target those
// rows by connector_id must also use the canonical key.
const SPOTIFY_CONNECTOR_KEY_RAW = canonicalConnectorKey("https://registry.pdpp.dev/connectors/spotify");
assert.ok(SPOTIFY_CONNECTOR_KEY_RAW, "expected a canonical key for the well-formed spotify registry URL");
const SPOTIFY_CONNECTOR_KEY = SPOTIFY_CONNECTOR_KEY_RAW;

async function closeServer(server: TestServer) {
  // Force-close keep-alive connections to prevent hanging.
  // Clear fallback timers when close callbacks win so the harness does not
  // retain stray timer handles after an otherwise clean shutdown.
  //
  // `server.asServer`/`rsServer` are plain `http.Server` instances at runtime
  // (server/index.js calls a minimal app's own `.listen()`, no http2 anywhere
  // in this codebase) — checkJs's structural inference over that untyped call
  // guesses an unrelated overload that happens to omit closeAllConnections.
  // CloseableHttpServer models the real runtime shape.
  (server.asServer as CloseableHttpServer).closeAllConnections?.();
  (server.rsServer as CloseableHttpServer).closeAllConnections?.();

  const closeWithTimeout = (srv: CloseableHttpServer) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);

      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });

  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function closeHttpServer(server: CloseableHttpServer) {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson<T = GenericJsonBody>(url: string, opts: RequestInit = {}): Promise<JsonResponse<T>> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function withHarness(fn: (ctx: HarnessContext) => Promise<void>) {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  ) as TestManifest;

  try {
    await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await seedCliGrantInstances(spotifyManifest.connector_id, "Spotify");

    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function withNativeHarness(fn: (ctx: NativeHarnessContext) => Promise<void>) {
  const nativeManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/northstar-hr.json"), "utf8")
  ) as TestManifest;
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    nativeManifest,
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    await fn({ asUrl, nativeManifest, rsUrl });
  } finally {
    await closeServer(server);
  }
}

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-cli-db-"));
  return {
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
    dbPath: join(dir, "pdpp.sqlite"),
  };
}

function startGrantRequest(asUrl: string, params: GrantRequestParams) {
  return fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          retention: params.retention,
          source:
            params.source ||
            (params.provider_id
              ? { id: params.provider_id, kind: "provider_native" }
              : { id: sourceIdForConnectorId(params.connector_id), kind: "connector" }),
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_display: params.client_display,
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function approveGrantRequest(
  asUrl: string,
  requestUri: string,
  subjectId: string,
  extra: Record<string, unknown> = {}
) {
  return (async () => {
    const review = await fetchJson<Record<string, unknown>>(`${asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId, ...extra }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const reviewRevision = review.body.approval_review_revision;
    assert.equal(typeof reviewRevision, "string", "consent review must return approval_review_revision");
    return fetchJson<ApprovedGrant>(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ approval_review_revision: reviewRevision, request_uri: requestUri }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
  })();
}

async function denyGrantRequest(asUrl: string, requestUri: string) {
  const resp = await fetch(`${asUrl}/consent/deny`, {
    body: JSON.stringify({ request_uri: requestUri }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return {
    body: await resp.text(),
    headers: Object.fromEntries(resp.headers.entries()),
    status: resp.status,
  };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(device.user_code, "expected user_code from device authorization");
  assert.ok(device.device_code, "expected device_code from device authorization");

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  assert.ok(tokenBody.access_token, "expected access_token from token exchange");
  return tokenBody.access_token;
}

function updateRegisteredClientRow(clientId: string, updates: Record<string, unknown>) {
  const setParts: string[] = [];
  const binds: unknown[] = [];
  for (const key of ["metadata_json", "token_endpoint_auth_method"]) {
    if (Object.hasOwn(updates, key)) {
      setParts.push(`${key} = ?`);
      binds.push(updates[key]);
    }
  }
  assert.ok(binds.length, "expected registered client row updates");

  getDb()
    .prepare(`UPDATE oauth_clients SET ${setParts.join(", ")} WHERE client_id = ?`)
    .run(...binds, clientId);
}

function mutatePendingConsentRequest(requestUri: string, mutate: (request: Record<string, unknown>) => void) {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should decode to a pending device code");

  const rows = getDb()
    .prepare(`
    SELECT params_json
    FROM pending_consents
    WHERE device_code = ?
  `)
    .all(deviceCode) as { params_json: string }[];
  assert.equal(rows.length, 1);
  const [firstRow] = rows;
  assert.ok(firstRow, "expected one pending_consents row");

  const request = JSON.parse(firstRow.params_json) as Record<string, unknown>;
  mutate(request);

  getDb()
    .prepare(`
    UPDATE pending_consents
    SET params_json = ?
    WHERE device_code = ?
  `)
    .run(JSON.stringify(request), deviceCode);
}

interface PendingConsentTraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

function readPendingConsentTraceContext(requestUri: string): Promise<PendingConsentTraceContext> {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should decode to a pending device code");

  const rows = getDb()
    .prepare(`
    SELECT request_id, trace_id, scenario_id
    FROM pending_consents
    WHERE device_code = ?
  `)
    .all(deviceCode) as PendingConsentTraceContext[];
  assert.equal(rows.length, 1);
  const [firstRow] = rows;
  assert.ok(firstRow, "expected one pending_consents row");
  return Promise.resolve(firstRow);
}

// Real ingest (`resolveOwnerConnectorNamespace` in server/index.ts) resolves
// the acting owner subject from the REQUEST'S bearer token
// (`getOwnerTokenSubjectId(req)`), independent of `runConnector`'s own
// `ownerSubjectId` option. Direct calls use owner tokens minted by
// `issueOwnerToken(asUrl, "cli_owner")`. Most omit `connectorInstanceId`, so
// this admission callback materializes/resolves that subject's default-account
// binding through the real store. Run-fence scenarios may materialize the same
// binding first and pass its exact id explicitly. This mirrors the production
// wiring in server/index.ts's
// `createController({ admitRunConnection: ... })` and the identical fixture
// already applied in event-spine.test.ts/collection-profile.test.ts.
function fakeAdmitRunConnection(
  ownerSubjectIdDefault = "cli_owner"
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || ownerSubjectIdDefault;
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

async function materializeCliRunConnection(connectorId: string, ownerSubjectId = "cli_owner"): Promise<string> {
  const canonicalConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
  const namespace = await admitOwnerRunConnection({
    connectorId: canonicalConnectorId,
    connectorInstanceStore: createRequestConnectorInstanceStore(),
    ownerSubjectId,
  });
  return namespace.connectorInstanceId;
}

function sourceIdForConnectorId(connectorId: string | undefined): string | undefined {
  if (connectorId === undefined || connectorId.includes("://")) {
    return connectorId;
  }
  return `https://registry.pdpp.dev/connectors/${connectorId}`;
}

async function seedDefaultGrantInstance(
  connectorId: string,
  ownerSubjectId: string,
  displayName: string
): Promise<void> {
  const store = createRequestConnectorInstanceStore();
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const connectorInstanceId = makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorKey);
  if (await store.get(connectorInstanceId)) {
    return;
  }
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: connectorKey,
    connectorInstanceId,
    createdAt: now,
    displayName,
    ownerSubjectId,
    sourceBinding: { fixture: "cli-grant-omission-default-account" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function seedCliGrantInstances(connectorId: string, displayName: string): Promise<void> {
  await Promise.all(
    CLI_GRANT_FIXTURE_OWNER_SUBJECTS.map((ownerSubjectId) =>
      seedDefaultGrantInstance(connectorId, ownerSubjectId, displayName)
    )
  );
}

function seedSpotify(rsUrl: string, manifest: TestManifest, ownerToken: string, ownerSubjectId = "cli_owner") {
  const connectorPath = join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts");
  return runConnector({
    admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId: admittedOwnerSubjectId }) => {
      await Promise.resolve();
      const exactId = makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId);
      assert.ok(connectorInstanceId === null || connectorInstanceId === exactId);
      assert.equal(admittedOwnerSubjectId, ownerSubjectId);
      return { connectorId, connectorInstanceId: exactId, ownerSubjectId };
    },
    collectionMode: "full_refresh",
    connectorId: manifest.connector_id,
    connectorPath,
    manifest: manifest as RuntimeConnectorManifest,
    ownerSubjectId,
    ownerToken,
    rsUrl,
    state: null,
  });
}

async function seedNorthstar(nativeManifest: TestManifest, ownerSubjectId = "cli_owner") {
  const records = [
    {
      data: {
        currency: "USD",
        employee_id: "emp_123",
        employer: "Northstar HR",
        gross_pay: 5400,
        issued_at: "2026-04-16T12:00:00Z",
        net_pay: 3912,
        pay_period_end: "2026-04-15",
        pay_period_start: "2026-04-01",
        statement_id: "ps_2026_04_15",
      },
      emitted_at: "2026-04-16T12:00:00Z",
      key: "ps_2026_04_15",
      stream: "pay_statements",
    },
    {
      data: {
        currency: "USD",
        employee_id: "emp_123",
        employer: "Northstar HR",
        grant_id: "eq_2026_01_01",
        grant_type: "RSU",
        granted_at: "2026-01-01T00:00:00Z",
        quantity: 1200,
        strike_price: 0,
        vesting_end_date: "2030-01-01",
        vesting_start_date: "2026-01-01",
      },
      emitted_at: "2026-01-01T00:00:00Z",
      key: "eq_2026_01_01",
      stream: "equity_grants",
    },
    {
      data: {
        coverage_level: "employee_plus_family",
        currency: "USD",
        effective_date: "2026-01-01",
        employee_cost_monthly: 280,
        employee_id: "emp_123",
        employer: "Northstar HR",
        enrollment_id: "ben_medical_2026",
        plan_name: "Northstar PPO",
      },
      emitted_at: "2026-01-01T00:00:00Z",
      key: "ben_medical_2026",
      stream: "benefits_enrollments",
    },
  ];

  const storageBinding = nativeManifest.storage_binding as { connector_id: string };
  assert.ok(nativeManifest.name, "native manifest includes name");
  assert.ok(nativeManifest.source_declaration, "native manifest includes source_declaration");
  assert.ok(nativeManifest.version, "native manifest includes version");
  await registerConnector(
    {
      connector_id: storageBinding.connector_id,
      display_name: nativeManifest.name,
      protocol_version: nativeManifest.source_declaration.protocol_version,
      source_declaration: nativeManifest.source_declaration,
      streams: nativeManifest.source_declaration.streams,
      version: nativeManifest.version,
    },
    { backfillRetrievalIndexes: false }
  );

  const connectorInstanceId = makeDefaultAccountConnectorInstanceId(ownerSubjectId, storageBinding.connector_id);
  const now = new Date().toISOString();
  await createRequestConnectorInstanceStore().upsert({
    connectorId: storageBinding.connector_id,
    connectorInstanceId,
    createdAt: now,
    displayName: "Northstar HR",
    ownerSubjectId,
    sourceBinding: { fixture: "cli-native-provider" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  for await (const record of records) {
    await ingestRecord(
      { connector_id: storageBinding.connector_id, connector_instance_id: connectorInstanceId },
      record
    );
  }
}

function issueNorthstarClientGrant(asUrl: string, nativeManifest: TestManifest, subjectId = "cli_owner") {
  return approveGrant(asUrl, subjectId, {
    access_mode: "continuous",
    client_id: "longview",
    purpose_code: "https://pdpp.dev/purpose/financial_planning",
    purpose_description: "Support compensation planning and verification",
    source: { id: nativeManifest.provider_id, kind: "provider_native" },
    streams: [{ name: "pay_statements" }],
  });
}

async function approveGrant(asUrl: string, subjectId: string, params: GrantRequestParams): Promise<ApprovedGrant> {
  if (params.connector_id) {
    await seedDefaultGrantInstance(params.connector_id, subjectId, "Grant fixture");
  }
  const { body: initiate } = await startGrantRequest(asUrl, params);
  assert.ok(initiate.request_uri, "expected request_uri from PAR");

  const { body: approved } = await approveGrantRequest(asUrl, initiate.request_uri, subjectId);

  return approved;
}

interface MalformedPolyfillClientContext {
  readonly approved: ApprovedGrant;
  readonly asUrl: string;
  readonly missingConnectorId: string;
  readonly rsUrl: string;
  readonly visibleRecord: Record<string, unknown>;
}

// Shared by the two 'auth-gate ... stay inspectable' tests below, each of
// which builds its own scenario table (grant_invalid/grant_revoked/
// grant_expired) with a `prepare()` step that mutates DB/server state
// before the CLI is invoked.
interface AuthGatePrepareContext {
  readonly approved: ApprovedGrant;
  readonly asUrl: string;
  readonly dbPath: string;
  readonly nativeManifest: TestManifest;
  readonly server: TestServer;
}
interface AuthGateScenario {
  readonly expectedMessage: RegExp;
  readonly name: string;
  readonly prepare: (ctx: AuthGatePrepareContext) => Promise<TestServer>;
}

async function withMalformedPolyfillClientGrant(fn: (ctx: MalformedPolyfillClientContext) => Promise<void>) {
  const { dbPath, cleanup } = createTempDbPath();
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  ) as TestManifest;
  let server = await startServer({
    asPort: 0,
    dbPath,
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
    await seedSpotify(rsUrl, spotifyManifest, ownerToken);
    const ownerRecordListResp = await fetchJson<RsRecordsPage>(
      `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const visibleRecord = ownerRecordListResp.body.data?.[0];
    assert.ok(visibleRecord, "expected an owner-visible top_artists record before corrupting the grant binding");

    const approved = await approveGrant(asUrl, "cli_owner", {
      access_mode: "continuous",
      client_id: "concert_recommendation_app",
      purpose_code: "https://pdpp.dev/purpose/concert_recommendation",
      purpose_description: "Recommend concerts and nearby live events",
      source: { id: spotifyManifest.connector_id, kind: "connector" },
      streams: [{ name: "top_artists" }],
    });

    const missingConnectorId = "missing_spotify_connector";
    const remappedGrant = JSON.parse(JSON.stringify(approved.grant));
    remappedGrant.source = {
      id: missingConnectorId,
      kind: "connector",
    };

    getDb()
      .prepare(`
      UPDATE grants
      SET grant_json = ?,
          storage_binding_json = ?
      WHERE grant_id = ?
    `)
      .run(
        JSON.stringify(remappedGrant),
        JSON.stringify({ connector_id: missingConnectorId }),
        approved.grant.grant_id
      );

    await closeServer(server);
    server = await startServer({
      asPort: server.asPort,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: server.rsPort,
      ...TEST_INTROSPECTION_SERVER_OPTS,
    });

    const reRegisterResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reRegisterResp.status, 201);

    await fn({ approved, asUrl, missingConnectorId, rsUrl, visibleRecord });
  } finally {
    await closeServer(server);
    cleanup();
  }
}

function assertMalformedPolyfillClientArtifacts({
  events,
  requestId,
  traceId,
  streamId = null,
  queryShape,
  requestedRecordId = null,
  missingConnectorId,
  label,
  stderr = "",
}: {
  events: readonly SpineEvent[] | undefined;
  requestId: string;
  traceId: string;
  streamId?: string | null | undefined;
  queryShape: unknown;
  requestedRecordId?: string | null | undefined;
  missingConnectorId: string;
  label: string;
  stderr?: string | undefined;
}) {
  const queryReceived = (events || []).find(
    (event) => event.event_type === "query.received" && event.object_id === requestId
  );
  assert.ok(queryReceived, `artifacts should include query.received for malformed polyfill client ${label}`);
  assert.equal(queryReceived.trace_id, traceId);
  const queryReceivedData = asRecord(queryReceived.data);
  assert.equal(queryReceivedData.query_shape, queryShape);
  assert.equal(
    queryReceivedData.source,
    undefined,
    `malformed source '${missingConnectorId}' must not be trusted for ${label}`
  );
  if (streamId) {
    assert.equal(queryReceived.stream_id, streamId);
  }
  if (requestedRecordId) {
    assert.equal(queryReceivedData.requested_record_id, requestedRecordId);
  }

  const rejectedEvent = (events || []).find(
    (event) => event.event_type === "query.rejected" && event.object_id === requestId
  );
  assert.ok(rejectedEvent, `artifacts should include query.rejected for malformed polyfill client ${label}`);
  assert.equal(rejectedEvent.trace_id, traceId);
  const rejectedEventData = asRecord(rejectedEvent.data);
  assert.equal(rejectedEventData.query_shape, queryShape);
  assert.equal(
    rejectedEventData.source,
    undefined,
    `malformed source '${missingConnectorId}' must not be trusted for ${label}`
  );
  const rejectedEventError = asRecord(rejectedEventData.error);
  assert.equal(rejectedEventError.code, "grant_invalid");
  assert.match(String(rejectedEventError.message ?? ""), TOP_LEVEL_REGEX_3);
  if (streamId) {
    assert.equal(rejectedEvent.stream_id, streamId);
  }

  const servedEvent = (events || []).find(
    (event) => event.event_type === "disclosure.served" && event.object_id === requestId
  );
  assert.equal(servedEvent, undefined, `malformed polyfill client ${label} should not produce disclosure.served`);
  assert.equal(stderr, "");
}

// Strip the one-line "warning: \"pdpp <group> <sub>\" is deprecated; use
// \"pdpp ref <group> <sub>\" instead." emitted by the legacy operator
// aliases (cli/index.js:126). The aliases route to the same handlers as
// the canonical `pdpp ref ...` forms, so the warning is operationally
// invisible to test expectations that assert `stderr === ''`. Coverage
// of the deprecation behavior itself lives in the dedicated legacy-alias
// test below.
const LEGACY_ALIAS_DEPRECATION_RE = /^warning: "pdpp [^"]+" is deprecated; use "[^"]+" instead\.\n/gm;
function scrubLegacyAliasWarning(stderr: string): string {
  return (stderr || "").replace(LEGACY_ALIAS_DEPRECATION_RE, "");
}

interface ExecFileError extends Error {
  readonly code?: number | string | null;
  readonly stderr?: string;
  readonly stdout?: string;
}

async function runCli(args: readonly string[], env: Record<string, string> = {}) {
  const { stdout, stderr } = await execFile(process.execPath, [CLI_PATH, ...args], {
    cwd: REFERENCE_IMPL_DIR,
    env: {
      ...process.env,
      AS_URL: "",
      PDPP_AS_URL: "",
      PDPP_RS_INTROSPECTION_CLIENT_ID: TEST_RS_INTROSPECTION_CREDENTIALS.clientId,
      PDPP_RS_INTROSPECTION_CLIENT_SECRET: TEST_RS_INTROSPECTION_CREDENTIALS.clientSecret,
      PDPP_RS_URL: "",
      RS_URL: "",
      ...env,
    },
  });

  let json: CliJsonBody | null = null;
  if (stdout) {
    try {
      json = JSON.parse(stdout) as CliJsonBody;
    } catch {
      json = null;
    }
  }

  return {
    json,
    stderr: scrubLegacyAliasWarning(stderr),
    stdout,
  };
}

async function runCliExpectFailure(args: readonly string[], env: Record<string, string> = {}) {
  try {
    await execFile(process.execPath, [CLI_PATH, ...args], {
      cwd: REFERENCE_IMPL_DIR,
      env: {
        ...process.env,
        AS_URL: "",
        PDPP_AS_URL: "",
        PDPP_RS_INTROSPECTION_CLIENT_ID: TEST_RS_INTROSPECTION_CREDENTIALS.clientId,
        PDPP_RS_INTROSPECTION_CLIENT_SECRET: TEST_RS_INTROSPECTION_CREDENTIALS.clientSecret,
        PDPP_RS_URL: "",
        RS_URL: "",
        ...env,
      },
    });
    assert.fail("Expected CLI command to fail");
  } catch (err) {
    const error = err as ExecFileError;
    return {
      code: error.code,
      stderr: scrubLegacyAliasWarning(error.stderr || ""),
      stdout: error.stdout || "",
    };
  }
}

function waitForRegex(getText: () => string, regex: RegExp, timeoutMs = 5000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  const wait = async (): Promise<RegExpMatchArray> => {
    const match = getText().match(regex);
    if (match) {
      return match;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${regex}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    return wait();
  };
  return wait();
}

test("PDPP CLI smoke", async (t) => {
  await t.test("auth introspect returns owner token metadata", async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const result = await runCli(["auth", "introspect", "--rs-url", rsUrl, "--token", ownerToken, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.active, true);
      assert.equal(result.json.pdpp_token_kind, "owner");
      assert.equal(result.json.subject_id, "cli_owner");
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "auth introspect exposes native client authorization details without storage-binding leakage",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);
        const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

        const result = await runCli([
          "auth",
          "introspect",
          "--rs-url",
          rsUrl,
          "--token",
          approved.token,
          "--format",
          "json",
        ]);
        assert.ok(result.json, "expected CLI --format json output to parse");

        assert.equal(result.json.active, true);
        assert.equal(result.json.pdpp_token_kind, "client");
        assert.equal(result.json.grant_id, approved.grant.grant_id);
        assert.equal(result.json.client_id, asRecord(approved.grant.client).client_id);
        assert.equal(result.json.subject_id, "cli_owner");
        assert.ok(typeof result.json.trace_id === "string" && result.json.trace_id.startsWith("trc_"));
        assert.ok(typeof result.json.scenario_id === "string" && result.json.scenario_id.startsWith("scn_"));
        const resultAuthorizationDetails = asRecord(
          (result.json.authorization_details as readonly unknown[] | undefined)?.[0]
        );
        const resultGrantSource = asRecord(resultAuthorizationDetails.source);
        assert.equal(resultGrantSource.kind, "provider_native");
        assert.equal(resultGrantSource.id, nativeManifest.provider_id);
        assert.equal("grant_storage_binding" in resultAuthorizationDetails, false);
        assert.equal(result.stderr, "");

        const recordsResponse = await fetch(`${rsUrl}/v1/streams/pay_statements/records`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(recordsResponse.status, 200, "issued native grant reads the serving binding");
        const recordsBody = (await recordsResponse.json()) as { data?: unknown[] };
        assert.ok(recordsBody.data?.length, "native serving binding returns the seeded pay statement");
      });
    }
  );

  await t.test("auth introspect requires caller credentials from the environment", async () => {
    const result = await runCliExpectFailure(
      ["auth", "introspect", "--rs-url", "http://localhost:1", "--token", "token"],
      {
        PDPP_RS_INTROSPECTION_CLIENT_ID: "",
        PDPP_RS_INTROSPECTION_CLIENT_SECRET: "",
      }
    );

    assert.equal(result.code, 2);
    assert.match(result.stderr, TOP_LEVEL_REGEX_137);
  });

  await t.test("auth introspect preserves grant_invalid client context", async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const nativeManifest = JSON.parse(
      readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/northstar-hr.json"), "utf8")
    );
    let server = await startServer({
      asPort: 0,
      dbPath,
      nativeManifest,
      quiet: true,
      rsPort: 0,
      ...TEST_INTROSPECTION_SERVER_OPTS,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      getDb()
        .prepare(`
        UPDATE grants
        SET storage_binding_json = NULL
        WHERE grant_id = ?
      `)
        .run(approved.grant.grant_id);

      await closeServer(server);
      server = await startServer({
        asPort: server.asPort,
        dbPath,
        nativeManifest,
        quiet: true,
        rsPort: server.rsPort,
        ...TEST_INTROSPECTION_SERVER_OPTS,
      });

      const result = await runCli([
        "auth",
        "introspect",
        "--rs-url",
        rsUrl,
        "--token",
        approved.token,
        "--format",
        "json",
      ]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.active, false);
      assert.equal(result.json.inactive_reason, "grant_invalid");
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.equal(result.json.client_id, asRecord(approved.grant.client).client_id);
      assert.equal(result.json.subject_id, "cli_owner");
      assert.ok(typeof result.json.trace_id === "string" && result.json.trace_id.startsWith("trc_"));
      assert.ok(typeof result.json.scenario_id === "string" && result.json.scenario_id.startsWith("scn_"));
      assert.equal(result.stderr, "");
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test("auth introspect preserves grant_revoked client context", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        headers: {
          Authorization: `Bearer ${approved.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      const result = await runCli([
        "auth",
        "introspect",
        "--rs-url",
        rsUrl,
        "--token",
        approved.token,
        "--format",
        "json",
      ]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.active, false);
      assert.equal(result.json.inactive_reason, "grant_revoked");
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.equal(result.json.client_id, asRecord(approved.grant.client).client_id);
      assert.equal(result.json.subject_id, "cli_owner");
      assert.ok(typeof result.json.trace_id === "string" && result.json.trace_id.startsWith("trc_"));
      assert.ok(typeof result.json.scenario_id === "string" && result.json.scenario_id.startsWith("scn_"));
      assert.equal(result.stderr, "");
    });
  });

  await t.test("auth introspect preserves grant_expired client context", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      getDb()
        .prepare(`
        UPDATE tokens
        SET expires_at = ?
        WHERE token_id = ?
      `)
        .run(new Date(Date.now() - 60_000).toISOString(), approved.token);

      const result = await runCli([
        "auth",
        "introspect",
        "--rs-url",
        rsUrl,
        "--token",
        approved.token,
        "--format",
        "json",
      ]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.active, false);
      assert.equal(result.json.inactive_reason, "grant_expired");
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.equal(result.json.client_id, asRecord(approved.grant.client).client_id);
      assert.equal(result.json.subject_id, "cli_owner");
      assert.ok(typeof result.json.trace_id === "string" && result.json.trace_id.startsWith("trc_"));
      assert.ok(typeof result.json.scenario_id === "string" && result.json.scenario_id.startsWith("scn_"));
      assert.equal(result.stderr, "");
    });
  });

  await t.test("auth login completes a real owner device flow", async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const proc = spawn(
        process.execPath,
        [
          CLI_PATH,
          "auth",
          "login",
          "--rs-url",
          rsUrl,
          "--client-id",
          "cli_longview",
          "--timeout-seconds",
          "15",
          "--format",
          "json",
        ],
        {
          cwd: REFERENCE_IMPL_DIR,
          env: {
            ...process.env,
            AS_URL: "",
            PDPP_AS_URL: "",
            PDPP_RS_INTROSPECTION_CLIENT_ID: TEST_RS_INTROSPECTION_CREDENTIALS.clientId,
            PDPP_RS_INTROSPECTION_CLIENT_SECRET: TEST_RS_INTROSPECTION_CREDENTIALS.clientSecret,
            PDPP_RS_URL: "",
            RS_URL: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      const codeMatch = await waitForRegex(() => stderr, TOP_LEVEL_REGEX_4);
      const [, userCode] = codeMatch;
      assert.ok(userCode, "expected a captured user code group");

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        body: new URLSearchParams({
          subject_id: "cli_owner",
          user_code: userCode,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(approveResp.status, 200);

      const exitCode = await new Promise((resolve, reject) => {
        proc.on("error", reject);
        proc.on("close", resolve);
      });

      assert.equal(exitCode, 0, stderr);
      const loginResult = JSON.parse(stdout);
      assert.equal(loginResult.token_type, "Bearer");
      assert.ok(loginResult.access_token);

      const introspection = await runCli([
        "auth",
        "introspect",
        "--as-url",
        asUrl,
        "--token",
        loginResult.access_token,
        "--format",
        "json",
      ]);
      assert.ok(introspection.json, "expected CLI --format json output to parse");
      assert.equal(introspection.json.active, true);
      assert.equal(introspection.json.pdpp_token_kind, "owner");
      assert.equal(introspection.json.subject_id, "cli_owner");
      assert.ok(loginResult.request_id?.startsWith("req_"));
      assert.ok(loginResult.reference_trace_id?.startsWith("trc_"));
      assert.match(stderr, TOP_LEVEL_REGEX_5);
    });
  });

  await t.test("auth login fails honestly when the owner denies the device flow", async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const proc = spawn(
        process.execPath,
        [
          CLI_PATH,
          "auth",
          "login",
          "--rs-url",
          rsUrl,
          "--client-id",
          "cli_longview",
          "--timeout-seconds",
          "15",
          "--format",
          "json",
        ],
        {
          cwd: REFERENCE_IMPL_DIR,
          env: { ...process.env, AS_URL: "", PDPP_AS_URL: "", PDPP_RS_URL: "", RS_URL: "" },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      const codeMatch = await waitForRegex(() => stderr, TOP_LEVEL_REGEX_6);
      const [, userCode] = codeMatch;
      assert.ok(userCode, "expected a captured user code group");

      const denyResp = await fetch(`${asUrl}/device/deny`, {
        body: new URLSearchParams({
          subject_id: "cli_owner",
          user_code: userCode,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(denyResp.status, 200);

      const exitCode = await new Promise((resolve, reject) => {
        proc.on("error", reject);
        proc.on("close", resolve);
      });

      assert.notEqual(exitCode, 0);
      assert.equal(stdout, "");
      assert.match(stderr, TOP_LEVEL_REGEX_7);
      assert.match(stderr, TOP_LEVEL_REGEX_8);
      assert.match(stderr, TOP_LEVEL_REGEX_9);
      assert.match(stderr, TOP_LEVEL_REGEX_10);
    });
  });

  await t.test("auth login fails honestly when the owner device client row is malformed", async () => {
    await withHarness(async ({ rsUrl }) => {
      await updateRegisteredClientRow("cli_longview", {
        metadata_json: "{",
      });

      const result = await runCliExpectFailure([
        "auth",
        "login",
        "--rs-url",
        rsUrl,
        "--client-id",
        "cli_longview",
        "--timeout-seconds",
        "15",
        "--format",
        "json",
      ]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_11);
      assert.match(result.stderr, TOP_LEVEL_REGEX_12);
      assert.match(result.stderr, TOP_LEVEL_REGEX_13);
    });
  });

  await t.test("trace show keeps owner device artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(deviceResp.status, 200);
      const requestId = deviceResp.headers.get("Request-Id");
      const traceId = deviceResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId, "expected Request-Id header");
      assert.ok(traceId, "expected PDPP-Reference-Trace-Id header");
      assert.ok(requestId.startsWith("req_"));
      assert.ok(traceId.startsWith("trc_"));
      const device = (await deviceResp.json()) as GenericJsonBody;
      assert.ok(device.user_code, "expected user_code from device authorization");
      assert.ok(device.device_code, "expected device_code from device authorization");

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        body: new URLSearchParams({
          subject_id: "cli_owner",
          user_code: device.user_code,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(approveResp.status, 200);

      const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: "cli_longview",
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(exchangeResp.status, 200);

      const result = await runCli(["trace", "show", traceId, "--rs-url", rsUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, traceId);

      const requestSubmitted = (result.json.data || []).find(
        (event) => event.event_type === "request.submitted" && event.data?.issuance_path === "owner_device_flow"
      );
      assert.ok(requestSubmitted, "trace show should include owner-device request.submitted");
      assert.equal(requestSubmitted.request_id, requestId);
      assert.equal(requestSubmitted.client_id, "cli_longview");
      // Public _ref redacts bearer-equivalent device_code / user_code on
      // owner_device_auth (harden-reference-auth-surfaces §7).
      assert.equal(requestSubmitted.object_id, "<redacted-device-code>");
      assert.equal(requestSubmitted.data?.user_code, "<redacted-bearer>");

      const approved = (result.json.data || []).find(
        (event) => event.event_type === "consent.approved" && event.object_type === "owner_device_auth"
      );
      assert.ok(approved, "trace show should include owner-device consent.approved");
      assert.equal(approved.request_id, requestId);
      assert.equal(approved.client_id, "cli_longview");
      assert.equal(approved.object_id, "<redacted-device-code>");
      assert.equal(approved.data?.user_code, "<redacted-bearer>");

      const tokenIssued = (result.json.data || []).find(
        (event) => event.event_type === "token.issued" && event.data?.issuance_path === "owner_device_flow"
      );
      assert.ok(tokenIssued, "trace show should include owner-device token.issued");
      assert.equal(tokenIssued.request_id, requestId);
      assert.equal(tokenIssued.client_id, "cli_longview");
      assert.equal(tokenIssued.data?.user_code, "<redacted-bearer>");
      assert.equal(result.stderr, "");
    });
  });

  await t.test("trace show keeps denied owner device artifacts inspectable", async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(deviceResp.status, 200);
      const requestId = deviceResp.headers.get("Request-Id");
      const traceId = deviceResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId, "expected Request-Id header");
      assert.ok(traceId, "expected PDPP-Reference-Trace-Id header");
      assert.ok(requestId.startsWith("req_"));
      assert.ok(traceId.startsWith("trc_"));
      const device = (await deviceResp.json()) as GenericJsonBody;
      assert.ok(device.user_code, "expected user_code from device authorization");
      assert.ok(device.device_code, "expected device_code from device authorization");

      const denyResp = await fetch(`${asUrl}/device/deny`, {
        body: new URLSearchParams({
          subject_id: "cli_owner",
          user_code: device.user_code,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(denyResp.status, 200);

      const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: "cli_longview",
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(exchangeResp.status, 400);

      const result = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find(
        (event) => event.event_type === "request.rejected" && event.request_id === requestId
      );
      assert.ok(rejected, "trace show should include request.rejected for owner-device denial");
      assert.equal(rejected.client_id, "cli_longview");
      assert.equal(rejected.object_id, "<redacted-device-code>");
      assert.equal(rejected.data?.issuance_path, "owner_device_flow");
      assert.equal(rejected.data?.user_code, "<redacted-bearer>");
      assert.equal(asRecord(rejected.data?.error).code, "access_denied");
      assert.match(String(asRecord(rejected.data?.error).message ?? ""), TOP_LEVEL_REGEX_14);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("trace show keeps rejected owner device start artifacts inspectable", async () => {
    await withHarness(async ({ asUrl }) => {
      await updateRegisteredClientRow("cli_longview", {
        metadata_json: "{",
      });

      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(deviceResp.status, 400);
      const requestId = deviceResp.headers.get("Request-Id");
      const traceId = deviceResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId, "expected Request-Id header");
      assert.ok(traceId, "expected PDPP-Reference-Trace-Id header");
      assert.ok(requestId.startsWith("req_"));
      assert.ok(traceId.startsWith("trc_"));

      const result = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find(
        (event) => event.event_type === "request.rejected" && event.request_id === requestId
      );
      assert.ok(rejected, "trace show should include request.rejected for owner-device start failures");
      assert.equal(rejected.client_id, "cli_longview");
      assert.equal(rejected.data?.issuance_path, "owner_device_flow");
      assert.equal(asRecord(rejected.data?.error).code, "invalid_client");
      assert.match(String(asRecord(rejected.data?.error).message ?? ""), TOP_LEVEL_REGEX_15);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("provider show summarizes discovery metadata from the RS", async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const result = await runCli(["provider", "show", "--rs-url", rsUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "provider_metadata");
      assert.equal(result.json.resource_server, rsUrl);
      assert.equal(result.json.authorization_server, asUrl);
      assert.deepEqual(result.json.authorization_servers_advertised, [asUrl]);
      assert.equal(result.json.authorization_server_advertised, true);
      assert.equal(result.json.resource_name, "PDPP Reference Provider Resource Server");
      assert.equal(result.json.pdpp_self_export_supported, true);
      assert.equal(result.json.device_authorization_supported, true);
      assert.equal(result.json.pushed_authorization_request_supported, true);
      assert.equal(result.json.pushed_authorization_request_endpoint, `${asUrl}/oauth/par`);
      assert.equal(result.json.registration_endpoint, `${asUrl}/oauth/register`);
      assert.equal(result.json.authorization_endpoint, `${asUrl}/oauth/authorize`);
      assert.deepEqual(result.json.response_types_supported, ["code"]);
      assert.deepEqual(result.json.code_challenge_methods_supported, ["S256"]);
      assert.deepEqual(result.json.token_endpoint_auth_methods_supported, ["none"]);
      const providerConnectCapabilities = result.json.pdpp_provider_connect_capabilities;
      assert.ok(Array.isArray(providerConnectCapabilities));
      assert.ok(providerConnectCapabilities.includes("owner_self_export"));
      assert.ok(providerConnectCapabilities.includes("third_party_client_connect"));
      assert.deepEqual(result.json.pdpp_registration_modes_supported, [
        "dynamic",
        "pre_registered_public",
        "client_id_metadata_document",
      ]);
      assert.equal(result.json.client_id_metadata_document_supported, true);
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "provider register creates a public dynamic client registration without an initial access token",
    async () => {
      await withHarness(async ({ asUrl, rsUrl }) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-"));
        const requestPath = join(tmpDir, "client.json");
        writeFileSync(
          requestPath,
          JSON.stringify(
            {
              client_name: "Dynamic Longview",
              client_uri: "https://longview.example",
              policy_uri: "https://longview.example/privacy",
              redirect_uris: ["https://longview.example/callback"],
              token_endpoint_auth_method: "none",
              tos_uri: "https://longview.example/terms",
            },
            null,
            2
          )
        );

        const result = await runCli(["provider", "register", requestPath, "--rs-url", rsUrl, "--format", "json"]);
        assert.ok(result.json, "expected CLI --format json output to parse");

        assert.ok(typeof result.json.client_id === "string" && result.json.client_id.startsWith("cli_"));
        assert.equal(result.json.client_name, "Dynamic Longview");
        assert.equal(result.json.token_endpoint_auth_method, "none");
        assert.deepEqual(result.json.redirect_uris, ["https://longview.example/callback"]);
        assert.ok(typeof result.json.request_id === "string" && result.json.request_id.startsWith("req_"));
        assert.ok(
          typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.startsWith("trc_")
        );

        const trace = await runCli([
          "trace",
          "show",
          result.json.reference_trace_id,
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(trace.json, "expected CLI --format json output to parse");
        const registeredEvent = (trace.json.data || []).find((event) => event.event_type === "client.registered");
        assert.ok(registeredEvent, "trace show should include client.registered after provider register");
        assert.equal(registeredEvent.request_id, result.json.request_id);
        assert.equal(registeredEvent.trace_id, result.json.reference_trace_id);
        assert.equal(registeredEvent.object_id, result.json.client_id);
        assert.equal(registeredEvent.data?.client_name, "Dynamic Longview");
        assert.equal(registeredEvent.data?.registration_access, "public");
        assert.equal(result.stderr, "");
      });
    }
  );

  await t.test(
    "provider register failures preserve correlation ids and stay inspectable through trace show",
    async () => {
      await withHarness(async ({ asUrl, rsUrl }) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-invalid-token-"));
        const requestPath = join(tmpDir, "client.json");
        writeFileSync(
          requestPath,
          JSON.stringify(
            {
              client_name: "Rejected Client",
              token_endpoint_auth_method: "none",
            },
            null,
            2
          )
        );

        const result = await runCliExpectFailure([
          "provider",
          "register",
          requestPath,
          "--rs-url",
          rsUrl,
          "--initial-access-token",
          "wrong-token",
          "--format",
          "json",
        ]);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, TOP_LEVEL_REGEX_16);
        const requestId = result.stderr.match(TOP_LEVEL_REGEX_17)?.[1] || null;
        const traceId = result.stderr.match(TOP_LEVEL_REGEX_1)?.[1] || null;
        assert.ok(requestId, "provider register failure should surface a request id on stderr");
        assert.ok(traceId, "provider register failure should surface a reference trace id on stderr");

        const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(trace.json, "expected CLI --format json output to parse");
        const rejectedEvent = (trace.json.data || []).find((event) => event.event_type === "client.register_rejected");
        assert.ok(rejectedEvent, "trace show should include client.register_rejected for provider register failures");
        assert.equal(rejectedEvent.request_id, requestId);
        assert.equal(rejectedEvent.trace_id, traceId);
        assert.equal(rejectedEvent.data?.requested_client_name, "Rejected Client");
        assert.equal(rejectedEvent.data?.requested_token_endpoint_auth_method, "none");
        assert.equal(asRecord(rejectedEvent.data?.error).code, "invalid_client");
      });
    }
  );

  await t.test(
    "provider register malformed URI failures preserve correlation ids and stay inspectable through trace show",
    async () => {
      await withHarness(async ({ asUrl, rsUrl }) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-invalid-uri-trace-"));
        try {
          const requestPath = join(tmpDir, "client.json");
          writeFileSync(
            requestPath,
            JSON.stringify(
              {
                client_name: "Rejected URI Client",
                redirect_uris: ["not a uri"],
                token_endpoint_auth_method: "none",
              },
              null,
              2
            )
          );

          const result = await runCliExpectFailure([
            "provider",
            "register",
            requestPath,
            "--rs-url",
            rsUrl,
            "--initial-access-token",
            TEST_DCR_INITIAL_ACCESS_TOKEN,
            "--format",
            "json",
          ]);

          assert.notEqual(result.code, 0);
          assert.match(result.stderr, TOP_LEVEL_REGEX_18);
          const requestId = result.stderr.match(TOP_LEVEL_REGEX_19)?.[1] || null;
          const traceId = result.stderr.match(TOP_LEVEL_REGEX_20)?.[1] || null;
          assert.ok(requestId, "malformed URI registration failure should surface a request id on stderr");
          assert.ok(traceId, "malformed URI registration failure should surface a reference trace id on stderr");

          const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
          assert.ok(trace.json, "expected CLI --format json output to parse");
          const rejectedEvent = (trace.json.data || []).find(
            (event) => event.event_type === "client.register_rejected"
          );
          assert.ok(
            rejectedEvent,
            "trace show should include client.register_rejected for malformed URI registration failures"
          );
          assert.equal(rejectedEvent.request_id, requestId);
          assert.equal(rejectedEvent.trace_id, traceId);
          assert.equal(rejectedEvent.data?.requested_client_name, "Rejected URI Client");
          assert.equal(rejectedEvent.data?.requested_token_endpoint_auth_method, "none");
          assert.equal(asRecord(rejectedEvent.data?.error).code, "invalid_client_metadata");
          assert.match(String(asRecord(rejectedEvent.data?.error).message ?? ""), TOP_LEVEL_REGEX_21);
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test("provider register fails honestly for unsupported token_endpoint_auth_method values", async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-unsupported-auth-method-"));
      const requestPath = join(tmpDir, "client.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            client_name: "Too Broad Longview",
            token_endpoint_auth_method: "client_secret_basic",
          },
          null,
          2
        )
      );

      const result = await runCliExpectFailure([
        "provider",
        "register",
        requestPath,
        "--rs-url",
        rsUrl,
        "--initial-access-token",
        TEST_DCR_INITIAL_ACCESS_TOKEN,
        "--format",
        "json",
      ]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_22);
    });
  });

  await t.test(
    "provider register fails honestly for unsupported launch-profile metadata like application_type",
    async () => {
      await withHarness(async ({ rsUrl }) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-unsupported-profile-metadata-"));
        const requestPath = join(tmpDir, "client.json");
        writeFileSync(
          requestPath,
          JSON.stringify(
            {
              application_type: "browser",
              client_name: "Native Longview",
              token_endpoint_auth_method: "none",
            },
            null,
            2
          )
        );

        const result = await runCliExpectFailure([
          "provider",
          "register",
          requestPath,
          "--rs-url",
          rsUrl,
          "--initial-access-token",
          TEST_DCR_INITIAL_ACCESS_TOKEN,
          "--format",
          "json",
        ]);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, TOP_LEVEL_REGEX_23);
      });
    }
  );

  await t.test(
    "provider register fails honestly for unsupported launch-profile grant_types and response_types metadata",
    async () => {
      await withHarness(async ({ rsUrl }) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-unsupported-flow-metadata-"));
        try {
          const unsupportedGrantTypesPath = join(tmpDir, "unsupported-grant-types.json");
          writeFileSync(
            unsupportedGrantTypesPath,
            JSON.stringify(
              {
                client_name: "Grant Types Longview",
                grant_types: ["client_credentials"],
                token_endpoint_auth_method: "none",
              },
              null,
              2
            )
          );

          const unsupportedGrantTypesResult = await runCliExpectFailure([
            "provider",
            "register",
            unsupportedGrantTypesPath,
            "--rs-url",
            rsUrl,
            "--initial-access-token",
            TEST_DCR_INITIAL_ACCESS_TOKEN,
            "--format",
            "json",
          ]);

          assert.notEqual(unsupportedGrantTypesResult.code, 0);
          assert.match(unsupportedGrantTypesResult.stderr, TOP_LEVEL_REGEX_24);

          const unsupportedResponseTypesPath = join(tmpDir, "unsupported-response-types.json");
          writeFileSync(
            unsupportedResponseTypesPath,
            JSON.stringify(
              {
                client_name: "Response Types Longview",
                response_types: ["token"],
                token_endpoint_auth_method: "none",
              },
              null,
              2
            )
          );

          const unsupportedResponseTypesResult = await runCliExpectFailure([
            "provider",
            "register",
            unsupportedResponseTypesPath,
            "--rs-url",
            rsUrl,
            "--initial-access-token",
            TEST_DCR_INITIAL_ACCESS_TOKEN,
            "--format",
            "json",
          ]);

          assert.notEqual(unsupportedResponseTypesResult.code, 0);
          assert.match(unsupportedResponseTypesResult.stderr, TOP_LEVEL_REGEX_25);
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test("provider register fails honestly for unsupported client metadata extension fields", async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-unsupported-metadata-"));
      const requestPath = join(tmpDir, "client.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            client_name: "Extension Longview",
            jwks_uri: "https://client.example/jwks.json",
            scope: "openid profile",
            token_endpoint_auth_method: "none",
          },
          null,
          2
        )
      );

      const result = await runCliExpectFailure([
        "provider",
        "register",
        requestPath,
        "--rs-url",
        rsUrl,
        "--initial-access-token",
        TEST_DCR_INITIAL_ACCESS_TOKEN,
        "--format",
        "json",
      ]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_26);
    });
  });

  await t.test("provider register fails honestly for malformed URI metadata fields", async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-invalid-uri-metadata-"));
      try {
        const invalidRedirectUrisPath = join(tmpDir, "invalid-redirect-uris.json");
        writeFileSync(
          invalidRedirectUrisPath,
          JSON.stringify(
            {
              client_name: "Broken Redirect Client",
              redirect_uris: ["not a uri"],
              token_endpoint_auth_method: "none",
            },
            null,
            2
          )
        );

        const invalidRedirectUrisResult = await runCliExpectFailure([
          "provider",
          "register",
          invalidRedirectUrisPath,
          "--rs-url",
          rsUrl,
          "--initial-access-token",
          TEST_DCR_INITIAL_ACCESS_TOKEN,
          "--format",
          "json",
        ]);

        assert.notEqual(invalidRedirectUrisResult.code, 0);
        assert.match(invalidRedirectUrisResult.stderr, TOP_LEVEL_REGEX_27);

        const invalidClientUriPath = join(tmpDir, "invalid-client-uri.json");
        writeFileSync(
          invalidClientUriPath,
          JSON.stringify(
            {
              client_name: "Broken Client URI",
              client_uri: "still not a uri",
              token_endpoint_auth_method: "none",
            },
            null,
            2
          )
        );

        const invalidClientUriResult = await runCliExpectFailure([
          "provider",
          "register",
          invalidClientUriPath,
          "--rs-url",
          rsUrl,
          "--initial-access-token",
          TEST_DCR_INITIAL_ACCESS_TOKEN,
          "--format",
          "json",
        ]);

        assert.notEqual(invalidClientUriResult.code, 0);
        assert.match(invalidClientUriResult.stderr, TOP_LEVEL_REGEX_28);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("inspect manifest handles native provider manifests and normalizes primary_key display", async () => {
    const manifestPath = join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/northstar-hr.json");
    const result = await runCli(["inspect", "manifest", manifestPath, "--format", "json"]);
    assert.ok(result.json, "expected CLI --format json output to parse");

    assert.ok(Array.isArray(result.json));
    const payStatements = result.json.find((stream) => stream.stream === "pay_statements");
    assert.equal(payStatements.source_kind, "provider_native");
    assert.equal(payStatements.source_id, "https://northstar.example/pdpp");
    assert.equal(payStatements.primary_key, "statement_id");
    assert.equal(result.stderr, "");
  });

  await t.test("inspect manifest rejects malformed native storage_binding instead of masking it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-manifest-invalid-native-storage-"));
    const manifestPath = join(tmpDir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          name: "Northstar HR",
          provider_id: "northstar_hr",
          storage_binding: {
            connector_id: "northstar_hr_native",
            debug_context: "should_not_be_accepted",
          },
          streams: [
            {
              name: "pay_statements",
              primary_key: "statement_id",
              schema: {
                properties: {
                  statement_id: { type: "string" },
                },
                type: "object",
              },
              semantics: "urn:pdpp:stream:pay_statements",
            },
          ],
          version: "0.1.0",
        },
        null,
        2
      )
    );

    const result = await runCliExpectFailure(["inspect", "manifest", manifestPath, "--format", "json"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, TOP_LEVEL_REGEX_29);
  });

  await t.test("inspect manifest rejects connector manifests that include native-only storage_binding", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-manifest-connector-storage-binding-"));
    const manifestPath = join(tmpDir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          connector_id: "https://registry.pdpp.dev/connectors/spotify",
          display_name: "Spotify",
          storage_binding: {
            connector_id: "spotify_native_storage",
          },
          streams: [
            {
              name: "top_artists",
              primary_key: "id",
              schema: {
                properties: {
                  id: { type: "string" },
                },
                type: "object",
              },
              semantics: "mutable_state",
            },
          ],
          version: "1.0.0",
        },
        null,
        2
      )
    );

    const result = await runCliExpectFailure(["inspect", "manifest", manifestPath, "--format", "json"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, TOP_LEVEL_REGEX_30);
  });

  await t.test("inspect request renders the current normalized request shape", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-request-"));
    const requestPath = join(tmpDir, "normalized-request.json");
    writeFileSync(
      requestPath,
      JSON.stringify(
        {
          client: {
            client_display: { name: "Longview" },
            client_id: "longview",
          },
          request_kind: "pdpp_selection_request",
          request_version: "reference.v1",
          selection: {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/financial_planning",
            streams: [{ name: "pay_statements" }, { name: "equity_grants" }],
            type: "https://pdpp.dev/data-access",
          },
          source_binding: { id: "northstar_hr", kind: "provider_native" },
          storage_binding: {
            connector_id: "northstar_hr_native",
          },
        },
        null,
        2
      )
    );

    const result = await runCli(["inspect", "request", requestPath, "--format", "json"]);
    assert.ok(result.json, "expected CLI --format json output to parse");

    assert.equal(result.json.client_display, "Longview");
    assert.equal(result.json.purpose_code, "https://pdpp.dev/purpose/financial_planning");
    assert.equal(result.json.access_mode, "continuous");
    assert.equal(result.json.source_kind, "provider_native");
    assert.equal(result.json.source_id, "northstar_hr");
    assert.equal(result.json.streams, "pay_statements, equity_grants");
    assert.equal(result.stderr, "");
  });

  await t.test("inspect request rejects malformed source_binding instead of masking it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-request-invalid-"));
    const requestPath = join(tmpDir, "malformed-request.json");
    writeFileSync(
      requestPath,
      JSON.stringify(
        {
          client: {
            client_display: { name: "Longview" },
            client_id: "longview",
          },
          request_kind: "pdpp_selection_request",
          request_version: "reference.v1",
          selection: {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/financial_planning",
            streams: [{ name: "pay_statements" }],
            type: "https://pdpp.dev/data-access",
          },
          source_binding: {
            connector_id: "northstar_hr_native",
          },
          storage_binding: {
            connector_id: "northstar_hr_native",
          },
        },
        null,
        2
      )
    );

    const result = await runCliExpectFailure(["inspect", "request", requestPath, "--format", "json"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, TOP_LEVEL_REGEX_136);
  });

  await t.test("inspect request rejects malformed storage_binding instead of masking it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-request-invalid-storage-"));
    const requestPath = join(tmpDir, "malformed-request.json");
    writeFileSync(
      requestPath,
      JSON.stringify(
        {
          client: {
            client_display: { name: "Longview" },
            client_id: "longview",
          },
          request_kind: "pdpp_selection_request",
          request_version: "reference.v1",
          selection: {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/financial_planning",
            streams: [{ name: "pay_statements" }],
            type: "https://pdpp.dev/data-access",
          },
          source_binding: { id: "northstar_hr_native", kind: "connector" },
          storage_binding: {
            connector_id: "northstar_hr_native",
            debug_context: "should_not_be_accepted",
          },
        },
        null,
        2
      )
    );

    const result = await runCliExpectFailure(["inspect", "request", requestPath, "--format", "json"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, TOP_LEVEL_REGEX_31);
  });

  await t.test("inspect request rejects connector and storage binding mismatches instead of masking them", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-request-mismatched-storage-"));
    const requestPath = join(tmpDir, "mismatched-request.json");
    writeFileSync(
      requestPath,
      JSON.stringify(
        {
          client: {
            client_display: { name: "Longview" },
            client_id: "longview",
          },
          request_kind: "pdpp_selection_request",
          request_version: "reference.v1",
          selection: {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/financial_planning",
            streams: [{ name: "pay_statements" }],
            type: "https://pdpp.dev/data-access",
          },
          source_binding: { id: "northstar_hr_native", kind: "connector" },
          storage_binding: {
            connector_id: "other_storage_connector",
          },
        },
        null,
        2
      )
    );

    const result = await runCliExpectFailure(["inspect", "request", requestPath, "--format", "json"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, TOP_LEVEL_REGEX_32);
  });

  await t.test("inspect grant renders current grant source and client display fields", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-grant-"));
    const grantPath = join(tmpDir, "grant.json");
    writeFileSync(
      grantPath,
      JSON.stringify(
        {
          access_mode: "continuous",
          client: {
            client_display: { name: "Longview" },
            client_id: "longview",
          },
          expires_at: null,
          grant_id: "grt_test",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          source: { id: "northstar_hr", kind: "provider_native" },
          streams: [{ name: "pay_statements" }, { name: "equity_grants" }],
          subject: { id: "employee_1" },
        },
        null,
        2
      )
    );

    const result = await runCli(["inspect", "grant", grantPath, "--format", "json"]);
    assert.ok(result.json, "expected CLI --format json output to parse");

    assert.equal(result.json.grant_id, "grt_test");
    assert.equal(result.json.client_id, "longview");
    assert.equal(result.json.client_display, "Longview");
    assert.equal(result.json.subject_id, "employee_1");
    assert.equal(result.json.access_mode, "continuous");
    assert.equal(result.json.purpose_code, "https://pdpp.dev/purpose/financial_planning");
    assert.equal(result.json.source_kind, "provider_native");
    assert.equal(result.json.source_id, "northstar_hr");
    assert.equal(result.json.streams, "pay_statements, equity_grants");
    assert.equal(result.stderr, "");
  });

  await t.test("inspect grant rejects malformed source instead of masking it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-grant-invalid-"));
    const grantPath = join(tmpDir, "malformed-grant.json");
    writeFileSync(
      grantPath,
      JSON.stringify(
        {
          access_mode: "continuous",
          client: {
            client_display: { name: "Longview" },
            client_id: "longview",
          },
          expires_at: null,
          grant_id: "grt_test",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          source: {
            connector_id: "northstar_hr_native",
          },
          streams: [{ name: "pay_statements" }],
          subject: { id: "employee_1" },
        },
        null,
        2
      )
    );

    const result = await runCliExpectFailure(["inspect", "grant", grantPath, "--format", "json"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, TOP_LEVEL_REGEX_33);
  });

  await t.test("inspect grant rejects malformed optional grant_storage_binding instead of masking it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-grant-invalid-storage-"));
    const grantPath = join(tmpDir, "malformed-grant.json");
    writeFileSync(
      grantPath,
      JSON.stringify(
        {
          access_mode: "continuous",
          client: {
            client_display: { name: "Longview" },
            client_id: "longview",
          },
          expires_at: null,
          grant_id: "grt_test",
          grant_storage_binding: {
            connector_id: "northstar_hr_native",
            debug_context: "should_not_be_accepted",
          },
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          source: { id: "northstar_hr_native", kind: "connector" },
          streams: [{ name: "pay_statements" }],
          subject: { id: "employee_1" },
        },
        null,
        2
      )
    );

    const result = await runCliExpectFailure(["inspect", "grant", grantPath, "--format", "json"]);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, TOP_LEVEL_REGEX_34);
  });

  await t.test(
    "inspect grant rejects connector and grant_storage_binding mismatches instead of masking them",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-grant-mismatched-storage-"));
      const grantPath = join(tmpDir, "mismatched-grant.json");
      writeFileSync(
        grantPath,
        JSON.stringify(
          {
            access_mode: "continuous",
            client: {
              client_display: { name: "Longview" },
              client_id: "longview",
            },
            expires_at: null,
            grant_id: "grt_test",
            grant_storage_binding: {
              connector_id: "other_storage_connector",
            },
            purpose_code: "https://pdpp.dev/purpose/financial_planning",
            source: { id: "northstar_hr_native", kind: "connector" },
            streams: [{ name: "pay_statements" }],
            subject: { id: "employee_1" },
          },
          null,
          2
        )
      );

      const result = await runCliExpectFailure(["inspect", "grant", grantPath, "--format", "json"]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_35);
    }
  );

  await t.test("grant start accepts a dynamically registered client", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-dcr-grant-"));
      const registrationPath = join(tmpDir, "client.json");
      writeFileSync(
        registrationPath,
        JSON.stringify(
          {
            client_name: "Dynamic Longview",
            client_uri: "https://longview.example",
            policy_uri: "https://longview.example/privacy",
            token_endpoint_auth_method: "none",
            tos_uri: "https://longview.example/terms",
          },
          null,
          2
        )
      );

      const registration = await runCli([
        "provider",
        "register",
        registrationPath,
        "--rs-url",
        rsUrl,
        "--initial-access-token",
        TEST_DCR_INITIAL_ACCESS_TOKEN,
        "--format",
        "json",
      ]);
      assert.ok(registration.json, "expected CLI --format json output to parse");

      const requestPath = join(tmpDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            authorization_details: [
              {
                access_mode: "single_use",
                purpose_code: "https://pdpp.dev/purpose/compensation_planning",
                purpose_description: "Compare pay, equity, and benefits data",
                source: { id: spotifyManifest.connector_id, kind: "connector" },
                streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_id: registration.json.client_id,
          },
          null,
          2
        )
      );

      const result = await runCli(["grant", "start", requestPath, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.ok(
        typeof result.json.request_uri === "string" && result.json.request_uri.startsWith("urn:pdpp:pending-consent:")
      );
      assert.ok(
        typeof result.json.authorization_url === "string" &&
          result.json.authorization_url.includes("/consent?request_uri=")
      );
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "grant start fails honestly when the registered client row is malformed before PAR staging",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-dcr-grant-invalid-"));
        const registrationPath = join(tmpDir, "client.json");
        writeFileSync(
          registrationPath,
          JSON.stringify(
            {
              client_name: "Dynamic Longview",
              token_endpoint_auth_method: "none",
            },
            null,
            2
          )
        );

        const registration = await runCli([
          "provider",
          "register",
          registrationPath,
          "--rs-url",
          rsUrl,
          "--initial-access-token",
          TEST_DCR_INITIAL_ACCESS_TOKEN,
          "--format",
          "json",
        ]);
        assert.ok(registration.json, "expected CLI --format json output to parse");

        assert.ok(registration.json.client_id, "expected client_id from provider register output");
        await updateRegisteredClientRow(registration.json.client_id, {
          metadata_json: "{",
        });

        const requestPath = join(tmpDir, "request.json");
        writeFileSync(
          requestPath,
          JSON.stringify(
            {
              authorization_details: [
                {
                  access_mode: "single_use",
                  purpose_code: "https://pdpp.dev/purpose/compensation_planning",
                  purpose_description: "Compare pay, equity, and benefits data",
                  source: { id: spotifyManifest.connector_id, kind: "connector" },
                  streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
                  type: "https://pdpp.dev/data-access",
                },
              ],
              client_id: registration.json.client_id,
            },
            null,
            2
          )
        );

        const result = await runCliExpectFailure([
          "grant",
          "start",
          requestPath,
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, TOP_LEVEL_REGEX_36);
        assert.match(result.stderr, TOP_LEVEL_REGEX_37);
        assert.match(result.stderr, TOP_LEVEL_REGEX_38);
      });
    }
  );

  await t.test("trace show keeps rejected provider-connect start artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-dcr-grant-trace-invalid-"));
      const registrationPath = join(tmpDir, "client.json");
      writeFileSync(
        registrationPath,
        JSON.stringify(
          {
            client_name: "Dynamic Longview",
            token_endpoint_auth_method: "none",
          },
          null,
          2
        )
      );

      const registration = await runCli([
        "provider",
        "register",
        registrationPath,
        "--rs-url",
        rsUrl,
        "--initial-access-token",
        TEST_DCR_INITIAL_ACCESS_TOKEN,
        "--format",
        "json",
      ]);
      assert.ok(registration.json, "expected CLI --format json output to parse");

      assert.ok(registration.json.client_id, "expected client_id from provider register output");
      await updateRegisteredClientRow(registration.json.client_id, {
        metadata_json: "{",
      });

      const rejectedResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "single_use",
              purpose_code: "https://pdpp.dev/purpose/compensation_planning",
              purpose_description: "Compare pay, equity, and benefits data",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: registration.json.client_id,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(rejectedResp.status, 400);
      const requestId = rejectedResp.headers.get("Request-Id");
      const traceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId, "expected Request-Id header");
      assert.ok(traceId, "expected PDPP-Reference-Trace-Id header");
      assert.ok(requestId.startsWith("req_"));
      assert.ok(traceId.startsWith("trc_"));

      const result = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find(
        (event) => event.event_type === "request.rejected" && event.request_id === requestId
      );
      assert.ok(rejected, "trace show should include request.rejected for provider-connect start failures");
      assert.equal(rejected.client_id, registration.json.client_id);
      assert.equal(asRecord(rejected.data?.error).code, "invalid_client");
      assert.match(String(asRecord(rejected.data?.error).message ?? ""), TOP_LEVEL_REGEX_39);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("trace show keeps consent-time deleted-client drift artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-consent-trace-deleted-client-"));
      const registrationPath = join(tmpDir, "client.json");
      writeFileSync(
        registrationPath,
        JSON.stringify(
          {
            client_name: "Transient Longview",
            token_endpoint_auth_method: "none",
          },
          null,
          2
        )
      );

      const registration = await runCli([
        "provider",
        "register",
        registrationPath,
        "--rs-url",
        rsUrl,
        "--initial-access-token",
        TEST_DCR_INITIAL_ACCESS_TOKEN,
        "--format",
        "json",
      ]);
      assert.ok(registration.json, "expected CLI --format json output to parse");

      assert.ok(typeof registration.json.client_id === "string", "expected client_id from provider register output");
      const initiate = await startGrantRequest(asUrl, {
        access_mode: "single_use",
        client_id: registration.json.client_id,
        purpose_code: "https://pdpp.dev/purpose/compensation_planning",
        purpose_description: "Compare pay, equity, and benefits data",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
      });
      assert.equal(initiate.status, 201);

      getDb().prepare("DELETE FROM oauth_clients WHERE client_id = ?").run(registration.json.client_id);

      const consentResp = await fetch(
        `${asUrl}/consent?request_uri=${encodeURIComponent(requireRequestUri(initiate.body))}`
      );
      assert.equal(consentResp.status, 400);
      const requestId = consentResp.headers.get("Request-Id");
      const traceId = consentResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId, "expected Request-Id header");
      assert.ok(traceId, "expected PDPP-Reference-Trace-Id header");
      assert.ok(requestId.startsWith("req_"));
      assert.ok(traceId.startsWith("trc_"));

      const result = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, traceId);

      const rejected = (result.json.data || []).find(
        (event) => event.event_type === "request.rejected" && event.request_id === requestId
      );
      assert.ok(rejected, "trace show should include request.rejected for consent-time deleted-client drift");
      assert.equal(rejected.object_type, "pending_consent");
      assert.equal(rejected.client_id, registration.json.client_id);
      assert.equal(asRecord(rejected.data?.source).kind, "connector");
      assert.equal(asRecord(rejected.data?.source).id, spotifyManifest.connector_id);
      assert.equal(asRecord(rejected.data?.error).code, "invalid_client");
      assert.match(String(asRecord(rejected.data?.error).message ?? ""), TOP_LEVEL_REGEX_40);
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "trace show keeps approval artifacts on the original staged trace when persisted pending trace-context drifts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken, "u1");

        const initiate = await startGrantRequest(asUrl, {
          access_mode: "single_use",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/compensation_planning",
          purpose_description: "Compare pay, equity, and benefits data",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
        });
        assert.equal(initiate.status, 201);
        const stagedTrace = await readPendingConsentTraceContext(requireRequestUri(initiate.body));
        const stagedRequestId = stagedTrace.request_id;
        const stagedTraceId = stagedTrace.trace_id;
        assert.ok(stagedRequestId, "expected stagedRequestId to be present");
        assert.ok(stagedRequestId.startsWith("req_"));
        assert.ok(stagedTraceId, "expected stagedTraceId to be present");
        assert.ok(stagedTraceId.startsWith("trc_"));

        await mutatePendingConsentRequest(requireRequestUri(initiate.body), (request) => {
          request.trace_context = {
            debug_context: "should_not_escape",
            request_id: "req_forged_pending",
            scenario_id: "scn_forged_pending",
            trace_id: "trc_forged_pending",
          };
        });

        const approveResp = await approveGrantRequest(asUrl, requireRequestUri(initiate.body), "u1");
        assert.equal(approveResp.status, 200);

        const result = await runCli(["trace", "show", stagedTraceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(result.json, "expected CLI --format json output to parse");

        assert.equal(result.json.object, "trace");
        assert.equal(result.json.trace_id, stagedTraceId);

        const approved = (result.json.data || []).find(
          (event) => event.event_type === "consent.approved" && event.request_id === stagedRequestId
        );
        assert.ok(approved, "trace show should keep consent.approved on the original staged trace");
        assert.equal(asRecord(approved.data?.source).kind, "connector");
        assert.equal(asRecord(approved.data?.source).id, spotifyManifest.connector_id);

        const grantIssued = (result.json.data || []).find(
          (event) => event.event_type === "grant.issued" && event.request_id === stagedRequestId
        );
        assert.ok(grantIssued, "trace show should keep grant.issued on the original staged trace");
        assert.equal(asRecord(grantIssued.data?.source).kind, "connector");
        assert.equal(asRecord(grantIssued.data?.source).id, spotifyManifest.connector_id);

        const tokenIssued = (result.json.data || []).find(
          (event) => event.event_type === "token.issued" && event.request_id === stagedRequestId
        );
        assert.ok(tokenIssued, "trace show should keep token.issued on the original staged trace");
        assert.equal(asRecord(tokenIssued.data?.source).kind, "connector");
        assert.equal(asRecord(tokenIssued.data?.source).id, spotifyManifest.connector_id);
        assert.equal(tokenIssued.data?.issuance_path, "grant_approval");
        assert.equal(result.stderr, "");
      });
    }
  );

  await t.test("trace show keeps native consent approval artifacts inspectable without connector leakage", async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        access_mode: "single_use",
        client_id: "longview",
        purpose_code: "https://pdpp.dev/purpose/financial_planning",
        purpose_description: "Support compensation planning and verification",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(requireRequestUri(initiate.body));
      const stagedRequestId = stagedTrace.request_id;
      const stagedTraceId = stagedTrace.trace_id;
      assert.ok(stagedRequestId, "expected stagedRequestId to be present");
      assert.ok(stagedRequestId.startsWith("req_"));
      assert.ok(stagedTraceId, "expected stagedTraceId to be present");
      assert.ok(stagedTraceId.startsWith("trc_"));

      const approveResp = await approveGrantRequest(asUrl, requireRequestUri(initiate.body), "employee_1");
      assert.equal(approveResp.status, 200);

      const result = await runCli(["trace", "show", stagedTraceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, stagedTraceId);

      const approved = (result.json.data || []).find(
        (event) => event.event_type === "consent.approved" && event.request_id === stagedRequestId
      );
      assert.ok(approved, "trace show should keep consent.approved on the original staged native trace");
      assert.equal(asRecord(approved.data?.source).kind, "provider_native");
      assert.equal(asRecord(approved.data?.source).id, nativeManifest.provider_id);
      assert.ok(!("connector_id" in (approved.data || {})));
      assert.ok(!("storage_connector_id" in (approved.data || {})));

      const grantIssued = (result.json.data || []).find(
        (event) => event.event_type === "grant.issued" && event.request_id === stagedRequestId
      );
      assert.ok(grantIssued, "trace show should keep grant.issued on the original staged native trace");
      assert.equal(asRecord(grantIssued.data?.source).kind, "provider_native");
      assert.equal(asRecord(grantIssued.data?.source).id, nativeManifest.provider_id);
      assert.ok(!("connector_id" in (grantIssued.data || {})));
      assert.ok(!("storage_connector_id" in (grantIssued.data || {})));

      const tokenIssued = (result.json.data || []).find(
        (event) => event.event_type === "token.issued" && event.request_id === stagedRequestId
      );
      assert.ok(tokenIssued, "trace show should keep token.issued on the original staged native trace");
      assert.equal(asRecord(tokenIssued.data?.source).kind, "provider_native");
      assert.equal(asRecord(tokenIssued.data?.source).id, nativeManifest.provider_id);
      assert.equal(tokenIssued.data?.issuance_path, "grant_approval");
      assert.ok(!("connector_id" in (tokenIssued.data || {})));
      assert.ok(!("storage_connector_id" in (tokenIssued.data || {})));
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "trace show keeps request rejection on the original staged trace when persisted pending bindings drift out of contract",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "single_use",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          purpose_description: "Compare pay, equity, and benefits data",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
        });
        assert.equal(initiate.status, 201);
        const stagedTrace = await readPendingConsentTraceContext(requireRequestUri(initiate.body));
        const stagedRequestId = stagedTrace.request_id;
        const stagedTraceId = stagedTrace.trace_id;

        await mutatePendingConsentRequest(requireRequestUri(initiate.body), (request) => {
          request.trace_context = {
            debug_context: "should_not_escape",
            request_id: "req_forged_pending",
            scenario_id: "scn_forged_pending",
            trace_id: "trc_forged_pending",
          };
          request.source_binding = {
            ...asRecord(request.source_binding),
            debug_context: "should_not_escape",
          };
          request.storage_binding = {
            ...asRecord(request.storage_binding),
            debug_context: "should_not_escape",
          };
        });

        const reviewResp = await fetchJson(`${asUrl}/consent/review`, {
          body: JSON.stringify({ request_uri: requireRequestUri(initiate.body), subject_id: "u1" }),
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(reviewResp.status, 400);

        const result = await runCli(["trace", "show", stagedTraceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(result.json, "expected CLI --format json output to parse");

        assert.equal(result.json.object, "trace");
        assert.equal(result.json.trace_id, stagedTraceId);

        const rejected = (result.json.data || []).find(
          (event) => event.event_type === "request.rejected" && event.request_id === stagedRequestId
        );
        assert.ok(rejected, "trace show should keep request.rejected on the original staged trace");
        assert.equal(asRecord(rejected.data?.source).kind, "connector");
        assert.equal(asRecord(rejected.data?.source).id, spotifyManifest.connector_id);
        assert.equal(result.stderr, "");
      });
    }
  );

  await t.test(
    "trace show keeps malformed pending source-binding rejection artifacts truthful instead of reconstructing connector source",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "single_use",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          purpose_description: "Compare pay, equity, and benefits data",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
        });
        assert.equal(initiate.status, 201);
        const stagedTrace = await readPendingConsentTraceContext(requireRequestUri(initiate.body));
        const stagedRequestId = stagedTrace.request_id;
        const stagedTraceId = stagedTrace.trace_id;

        await mutatePendingConsentRequest(requireRequestUri(initiate.body), (request) => {
          request.source_binding = {
            id: asRecord(request.source_binding).id,
          };
        });

        const reviewResp = await fetchJson(`${asUrl}/consent/review`, {
          body: JSON.stringify({ request_uri: requireRequestUri(initiate.body), subject_id: "u1" }),
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(reviewResp.status, 400);

        const result = await runCli(["trace", "show", stagedTraceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(result.json, "expected CLI --format json output to parse");

        assert.equal(result.json.object, "trace");
        assert.equal(result.json.trace_id, stagedTraceId);

        const rejected = (result.json.data || []).find(
          (event) => event.event_type === "request.rejected" && event.request_id === stagedRequestId
        );
        assert.ok(rejected, "trace show should keep request.rejected on the original staged trace");
        assert.equal(rejected.data?.source, null);
        assert.equal(result.stderr, "");
      });
    }
  );

  await t.test("trace show keeps retained native authorization stable across manifest label drift", async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.dev/purpose/financial_planning",
        purpose_description: "Support compensation planning and verification",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(requireRequestUri(initiate.body));

      await mutatePendingConsentRequest(requireRequestUri(initiate.body), (request) => {
        request.manifest_version = "999.0.0";
      });

      const consentResp = await fetch(
        `${asUrl}/consent?request_uri=${encodeURIComponent(requireRequestUri(initiate.body))}`
      );
      assert.equal(consentResp.status, 200);

      const approval = await approveGrantRequest(asUrl, requireRequestUri(initiate.body), "employee_1");
      assert.equal(approval.status, 200);

      const result = await runCli(["trace", "show", stagedTrace.trace_id, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, stagedTrace.trace_id);

      const approved = (result.json.data || []).find(
        (event) => event.event_type === "consent.approved" && event.request_id === stagedTrace.request_id
      );
      assert.ok(approved, "trace show should include consent.approved from the retained native declaration");
      assert.equal(approved.object_type, "pending_consent");
      assert.equal(approved.client_id, "longview");
      assert.equal(asRecord(approved.data?.source).kind, "provider_native");
      assert.equal(asRecord(approved.data?.source).id, nativeManifest.provider_id);
      assert.equal(
        (result.json.data || []).find(
          (event) => event.event_type === "request.rejected" && event.request_id === stagedTrace.request_id
        ),
        undefined
      );
      assert.equal(result.stderr, "");
    });
  });

  await t.test("trace show keeps consent-denied provider-connect traces inspectable", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        access_mode: "single_use",
        client_id: "longview",
        purpose_code: "https://pdpp.dev/purpose/compensation_planning",
        purpose_description: "Compare pay, equity, and benefits data",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
      });
      assert.equal(initiate.status, 201);
      const stagedTrace = await readPendingConsentTraceContext(requireRequestUri(initiate.body));
      const requestId = stagedTrace.request_id;
      const traceId = stagedTrace.trace_id;
      assert.ok(requestId, "expected Request-Id header");
      assert.ok(traceId, "expected PDPP-Reference-Trace-Id header");
      assert.ok(requestId.startsWith("req_"));
      assert.ok(traceId.startsWith("trc_"));

      const denyResp = await denyGrantRequest(asUrl, requireRequestUri(initiate.body));
      assert.equal(denyResp.status, 200);
      assert.equal(denyResp.headers["request-id"], requestId);
      assert.equal(denyResp.headers["pdpp-reference-trace-id"], traceId);
      assert.match(denyResp.body, TOP_LEVEL_REGEX_42);

      const result = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, traceId);

      const denied = (result.json.data || []).find(
        (event) => event.event_type === "consent.denied" && event.request_id === requestId
      );
      assert.ok(denied, "trace show should include consent.denied for staged provider-connect denial");
      assert.equal(denied.client_id, "longview");
      assert.equal(denied.object_type, "pending_consent");
      assert.equal(denied.status, "denied");
      assert.equal(asRecord(denied.data?.source).kind, "connector");
      assert.equal(asRecord(denied.data?.source).id, spotifyManifest.connector_id);
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "trace show keeps consent-denied native provider-connect traces inspectable without connector leakage",
    async () => {
      await withNativeHarness(async ({ asUrl, nativeManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });
        assert.equal(initiate.status, 201);
        const stagedTrace = await readPendingConsentTraceContext(requireRequestUri(initiate.body));
        const requestId = stagedTrace.request_id;
        const traceId = stagedTrace.trace_id;
        assert.ok(requestId, "expected Request-Id header");
        assert.ok(traceId, "expected PDPP-Reference-Trace-Id header");
        assert.ok(requestId.startsWith("req_"));
        assert.ok(traceId.startsWith("trc_"));

        const denyResp = await denyGrantRequest(asUrl, requireRequestUri(initiate.body));
        assert.equal(denyResp.status, 200);
        assert.equal(denyResp.headers["request-id"], requestId);
        assert.equal(denyResp.headers["pdpp-reference-trace-id"], traceId);
        assert.match(denyResp.body, TOP_LEVEL_REGEX_43);

        const result = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(result.json, "expected CLI --format json output to parse");

        assert.equal(result.json.object, "trace");
        assert.equal(result.json.trace_id, traceId);

        const denied = (result.json.data || []).find(
          (event) => event.event_type === "consent.denied" && event.request_id === requestId
        );
        assert.ok(denied, "trace show should include consent.denied for staged native provider-connect denial");
        assert.equal(denied.client_id, "longview");
        assert.equal(denied.object_type, "pending_consent");
        assert.equal(denied.status, "denied");
        assert.equal(asRecord(denied.data?.source).kind, "provider_native");
        assert.equal(asRecord(denied.data?.source).id, nativeManifest.provider_id);
        assert.ok(!("connector_id" in (denied.data || {})));
        assert.ok(!("storage_connector_id" in (denied.data || {})));
        assert.equal(result.stderr, "");
      });
    }
  );

  await t.test("grant start stages a PDPP request through /oauth/par", async () => {
    await withHarness(async ({ rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-grant-"));
      const requestPath = join(tmpDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            authorization_details: [
              {
                access_mode: "single_use",
                purpose_code: "https://pdpp.dev/purpose/compensation_planning",
                purpose_description: "Compare pay, equity, and benefits data",
                source: { id: spotifyManifest.connector_id, kind: "connector" },
                streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_display: { name: "Longview", verified: true },
            client_id: "cli_longview",
          },
          null,
          2
        )
      );

      const result = await runCli(["grant", "start", requestPath, "--rs-url", rsUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.ok(
        typeof result.json.request_uri === "string" && result.json.request_uri.startsWith("urn:pdpp:pending-consent:")
      );
      assert.ok(
        typeof result.json.authorization_url === "string" &&
          result.json.authorization_url.includes("/consent?request_uri=")
      );
      assert.equal(typeof result.json.expires_in, "number");
      assert.ok(typeof result.json.request_id === "string" && result.json.request_id.startsWith("req_"));
      assert.ok(
        typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.startsWith("trc_")
      );

      const trace = await runCli([
        "trace",
        "show",
        result.json.reference_trace_id,
        "--rs-url",
        rsUrl,
        "--format",
        "json",
      ]);
      assert.ok(trace.json, "expected CLI --format json output to parse");
      const submittedEvent = (trace.json.data || []).find((event) => event.event_type === "request.submitted");
      assert.ok(submittedEvent, "trace show should include request.submitted after CLI grant start");
      assert.equal(submittedEvent.request_id, result.json.request_id);
      assert.equal(submittedEvent.trace_id, result.json.reference_trace_id);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("grant start can discover the AS from PDPP_RS_URL", async () => {
    await withHarness(async ({ rsUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-grant-env-rs-"));
      const requestPath = join(tmpDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            authorization_details: [
              {
                access_mode: "single_use",
                purpose_code: "https://pdpp.dev/purpose/compensation_planning",
                purpose_description: "Compare pay, equity, and benefits data",
                source: { id: spotifyManifest.connector_id, kind: "connector" },
                streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_display: { name: "Longview", verified: true },
            client_id: "cli_longview",
          },
          null,
          2
        )
      );

      const result = await runCli(["grant", "start", requestPath, "--format", "json"], { PDPP_RS_URL: rsUrl });
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.ok(
        typeof result.json.request_uri === "string" && result.json.request_uri.startsWith("urn:pdpp:pending-consent:")
      );
      assert.ok(
        typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.startsWith("trc_")
      );

      const trace = await runCli(["trace", "show", result.json.reference_trace_id, "--format", "json"], {
        PDPP_RS_URL: rsUrl,
      });
      assert.ok(trace.json, "expected CLI --format json output to parse");
      const submittedEvent = (trace.json.data || []).find((event) => event.event_type === "request.submitted");
      assert.ok(submittedEvent, "trace show should still inspect grant-start traces when only PDPP_RS_URL is set");
      assert.equal(submittedEvent.trace_id, result.json.reference_trace_id);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("grant start stages a native-provider PDPP request through /oauth/par", async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-native-grant-"));
      const requestPath = join(tmpDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            authorization_details: [
              {
                access_mode: "single_use",
                purpose_code: "https://pdpp.dev/purpose/financial_planning",
                purpose_description: "Compare pay, equity, and benefits data",
                source: { id: nativeManifest.provider_id, kind: "provider_native" },
                streams: [{ name: "pay_statements", view: "summary" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_display: { name: "Longview", verified: true },
            client_id: "cli_longview",
          },
          null,
          2
        )
      );

      const result = await runCli(["grant", "start", requestPath, "--as-url", asUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.ok(
        typeof result.json.request_uri === "string" && result.json.request_uri.startsWith("urn:pdpp:pending-consent:")
      );
      assert.ok(
        typeof result.json.authorization_url === "string" &&
          result.json.authorization_url.includes("/consent?request_uri=")
      );
      assert.equal(typeof result.json.expires_in, "number");
      assert.equal(result.stderr, "");
    });
  });

  await t.test("grant start fails honestly for unsupported broader OAuth request fields", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-grant-unsupported-request-fields-"));
      const requestPath = join(tmpDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            authorization_details: [
              {
                access_mode: "single_use",
                purpose_code: "https://pdpp.dev/purpose/compensation_planning",
                purpose_description: "Compare pay, equity, and benefits data",
                source: { id: spotifyManifest.connector_id, kind: "connector" },
                streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_id: "cli_longview",
            redirect_uri: "https://client.example/callback",
            response_type: "code",
          },
          null,
          2
        )
      );

      const result = await runCliExpectFailure(["grant", "start", requestPath, "--as-url", asUrl, "--format", "json"]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_44);
    });
  });

  await t.test("grant start fails honestly for contradictory stream selections", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-grant-contradictory-stream-selection-"));
      const requestPath = join(tmpDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            authorization_details: [
              {
                access_mode: "single_use",
                purpose_code: "https://pdpp.dev/purpose/compensation_planning",
                purpose_description: "Compare pay, equity, and benefits data",
                source: { id: spotifyManifest.connector_id, kind: "connector" },
                streams: [{ fields: ["id", "name"], name: "saved_tracks", view: "basic" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_id: "cli_longview",
          },
          null,
          2
        )
      );

      const result = await runCliExpectFailure(["grant", "start", requestPath, "--as-url", asUrl, "--format", "json"]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_45);
    });
  });

  await t.test("grant revoke surfaces correlation metadata in CLI output and timeline artifacts", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

      const result = await runCli(["grant", "revoke", approved.grant.grant_id, "--rs-url", rsUrl, "--format", "json"], {
        PDPP_CLIENT_TOKEN: approved.token,
        PDPP_OWNER_TOKEN: "definitely-invalid-owner-token",
      });
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.revoked, true);
      assert.ok(typeof result.json.request_id === "string" && result.json.request_id.startsWith("req_"));
      assert.ok(
        typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.startsWith("trc_")
      );

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--rs-url",
        rsUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");
      const revokedEvent = (timeline.json.data || []).find((event) => event.event_type === "grant.revoked");
      assert.ok(revokedEvent, "grant timeline should include grant.revoked after CLI revocation");
      assert.equal(revokedEvent.request_id, result.json.request_id);
      assert.equal(revokedEvent.trace_id, result.json.reference_trace_id);
    });
  });

  await t.test(
    "grant revoke failures surface correlation ids and stay inspectable through timeline and trace readers",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken, "u1");
        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
        malformedGrant.source = {
          ...malformedGrant.source,
          debug_context: "should_not_escape",
          storage_connector_id: "leaky_storage_connector",
        };

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?,
            storage_binding_json = ?
        WHERE grant_id = ?
      `)
          .run(
            JSON.stringify(malformedGrant),
            JSON.stringify({
              debug_context: "should_not_escape",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
            }),
            approved.grant.grant_id
          );

        const result = await runCliExpectFailure(
          ["grant", "revoke", approved.grant.grant_id, "--as-url", asUrl, "--format", "json"],
          {
            PDPP_CLIENT_TOKEN: approved.token,
            PDPP_OWNER_TOKEN: "definitely-invalid-owner-token",
          }
        );

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, TOP_LEVEL_REGEX_46);
        const requestId = result.stderr.match(TOP_LEVEL_REGEX_47)?.[1] || null;
        const traceId = result.stderr.match(TOP_LEVEL_REGEX_48)?.[1] || null;
        assert.ok(requestId, "grant revoke failure should surface a request id on stderr");
        assert.ok(traceId, "grant revoke failure should surface a reference trace id on stderr");

        const timeline = await runCli([
          "grant",
          "timeline",
          approved.grant.grant_id,
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");
        const rejectedFromTimeline = (timeline.json.data || []).find(
          (event) => event.event_type === "grant.revoke_rejected" && event.object_id === approved.grant.grant_id
        );
        assert.ok(
          rejectedFromTimeline,
          "grant timeline should include grant.revoke_rejected for malformed grant revocation"
        );
        assert.equal(rejectedFromTimeline.request_id, requestId);
        assert.equal(rejectedFromTimeline.trace_id, traceId);
        assert.equal(asRecord(rejectedFromTimeline.data?.error).code, "grant_invalid");

        const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(trace.json, "expected CLI --format json output to parse");
        const rejectedFromTrace = (trace.json.data || []).find(
          (event) => event.event_type === "grant.revoke_rejected" && event.object_id === approved.grant.grant_id
        );
        assert.ok(rejectedFromTrace, "trace show should include grant.revoke_rejected for malformed grant revocation");
        assert.equal(rejectedFromTrace.request_id, requestId);
        assert.equal(rejectedFromTrace.trace_id, traceId);
        assert.equal(asRecord(rejectedFromTrace.data?.error).code, "grant_invalid");
      });
    }
  );

  await t.test("removed helper routes stay removed", async () => {
    await withHarness(async ({ asUrl }) => {
      const ownerTokenResp = await fetch(`${asUrl}/owner-token`, {
        body: JSON.stringify({ subject_id: "u1" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(ownerTokenResp.status, 404);

      const helperTokenResp = await fetch(`${asUrl}/grants/grt_fake/tokens`, {
        method: "POST",
      });
      assert.equal(helperTokenResp.status, 404);
    });
  });

  await t.test("provider register rejects an invalid initial access token", async () => {
    await withHarness(async ({ rsUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-register-fail-"));
      const requestPath = join(tmpDir, "client.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            client_name: "Rejected Client",
            token_endpoint_auth_method: "none",
          },
          null,
          2
        )
      );

      const result = await runCliExpectFailure([
        "provider",
        "register",
        requestPath,
        "--rs-url",
        rsUrl,
        "--initial-access-token",
        "wrong-token",
        "--format",
        "json",
      ]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_49);
    });
  });

  await t.test("grant start rejects the wrong Source kind without falling back to connector storage", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-bad-grant-"));
      const requestPath = join(tmpDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            authorization_details: [
              {
                access_mode: "single_use",
                purpose_code: "https://pdpp.dev/purpose/financial_planning",
                purpose_description: "Compare pay, equity, and benefits data",
                source: { id: spotifyManifest.connector_id, kind: "provider_native" },
                streams: [{ fields: ["gross_pay", "net_pay"], name: "pay_statements" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_display: { name: "Longview", verified: true },
            client_id: "cli_longview",
          },
          null,
          2
        )
      );

      const result = await runCliExpectFailure(["grant", "start", requestPath, "--as-url", asUrl, "--format", "json"]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_50);
    });
  });

  await t.test("grant start fails honestly when a native provider request names an unknown provider_id", async () => {
    await withNativeHarness(async ({ asUrl }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-native-provider-id-mismatch-"));
      const requestPath = join(tmpDir, "request.json");
      writeFileSync(
        requestPath,
        JSON.stringify(
          {
            authorization_details: [
              {
                access_mode: "single_use",
                purpose_code: "https://pdpp.dev/purpose/financial_planning",
                purpose_description: "Compare pay, equity, and benefits data",
                source: { id: "https://unknown.example/pdpp", kind: "provider_native" },
                streams: [{ fields: ["gross_pay", "net_pay"], name: "pay_statements" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_display: { name: "Longview", verified: true },
            client_id: "cli_longview",
          },
          null,
          2
        )
      );

      const result = await runCliExpectFailure(["grant", "start", requestPath, "--as-url", asUrl, "--format", "json"]);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_51);
    });
  });

  await t.test(
    "grant start fails honestly when a native provider request mixes a legacy source scalar with a source object",
    async () => {
      await withNativeHarness(async ({ asUrl }) => {
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-native-binding-conflict-"));
        const requestPath = join(tmpDir, "request.json");
        writeFileSync(
          requestPath,
          JSON.stringify(
            {
              authorization_details: [
                {
                  access_mode: "single_use",
                  connector_id: "spotify",
                  purpose_code: "https://pdpp.dev/purpose/financial_planning",
                  purpose_description: "Compare pay, equity, and benefits data",
                  source: {
                    id: "northstar_hr",
                    kind: "provider_native",
                  },
                  streams: [{ fields: ["gross_pay", "net_pay"], name: "pay_statements" }],
                  type: "https://pdpp.dev/data-access",
                },
              ],
              client_display: { name: "Longview", verified: true },
              client_id: "cli_longview",
            },
            null,
            2
          )
        );

        const result = await runCliExpectFailure([
          "grant",
          "start",
          requestPath,
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, TOP_LEVEL_REGEX_52);
      });
    }
  );

  await t.test("provider show exposes native provider naming from RS metadata", async () => {
    await withNativeHarness(async ({ rsUrl }) => {
      const result = await runCli(["provider", "show", "--rs-url", rsUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "provider_metadata");
      assert.equal(result.json.resource_name, "Northstar HR Resource Server");
      assert.equal(result.stderr, "");
    });
  });

  await t.test("agent bootstrap uses the reference-local DCR default without an explicit token", async () => {
    const server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
      ...TEST_INTROSPECTION_SERVER_OPTS,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const cacheRoot = mkdtempSync(join(tmpdir(), "pdpp-agent-bootstrap-"));

    try {
      const result = await runCli([
        "agent",
        "bootstrap",
        "--as-url",
        asUrl,
        "--rs-url",
        rsUrl,
        "--cache-root",
        cacheRoot,
        "--format",
        "json",
      ]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.bootstrapped, true);
      assert.equal(result.json.as_url, asUrl);
      assert.equal(result.json.rs_url, rsUrl);
      assert.equal(typeof result.json.client_id, "string");
      assert.match(result.stderr, TOP_LEVEL_REGEX_53);
    } finally {
      rmSync(cacheRoot, { force: true, recursive: true });
      await closeServer(server);
    }
  });

  await t.test("discovery-based login can immediately export owner data", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const bootstrapOwnerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, bootstrapOwnerToken);

      const proc = spawn(
        process.execPath,
        [
          CLI_PATH,
          "auth",
          "login",
          "--rs-url",
          rsUrl,
          "--client-id",
          "cli_longview",
          "--timeout-seconds",
          "15",
          "--format",
          "json",
        ],
        {
          cwd: REFERENCE_IMPL_DIR,
          env: { ...process.env, AS_URL: "", PDPP_AS_URL: "", PDPP_RS_URL: "", RS_URL: "" },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      const codeMatch = await waitForRegex(() => stderr, TOP_LEVEL_REGEX_54);
      const [, userCode] = codeMatch;
      assert.ok(userCode, "expected a captured user code group");

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        body: new URLSearchParams({
          subject_id: "cli_owner",
          user_code: userCode,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(approveResp.status, 200);

      const exitCode = await new Promise((resolve, reject) => {
        proc.on("error", reject);
        proc.on("close", resolve);
      });

      assert.equal(exitCode, 0, stderr);
      const loginResult = JSON.parse(stdout);
      assert.ok(loginResult.access_token);

      const exportResult = await runCli(
        [
          "owner",
          "export",
          "top_artists",
          "--connector-id",
          spotifyManifest.connector_id,
          "--rs-url",
          rsUrl,
          "--format",
          "jsonl",
        ],
        { PDPP_OWNER_TOKEN: loginResult.access_token }
      );

      const lines = exportResult.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(lines.length > 0);
      assert.ok(lines.some((row) => row.data?.name === "Radiohead"));
      assert.equal(exportResult.stderr, "");
    });
  });

  await t.test("grant timeline returns the reference timeline for an issued grant", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);
      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "single_use",
        client_display: { name: "Concert Recommendation App" },
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Recommend concerts based on listening history",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const result = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--rs-url",
        rsUrl,
        "--format",
        "json",
      ]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "grant_timeline");
      assert.equal(result.json.grant_id, approved.grant.grant_id);
      assert.ok(Array.isArray(result.json.data));
      assert.ok(result.json.data.some((event) => event.event_type === "grant.issued"));
      assert.ok(result.json.data.some((event) => event.event_type === "token.issued"));
      assert.equal(result.stderr, "");
    });
  });

  await t.test("grant timeline keeps grant-scoped state artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);
      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "continuous",
        client_display: { name: "Concert Recommendation App" },
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Maintain grant-scoped state through the CLI timeline reader",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists" }],
      });

      const updateResp = await fetch(
        // Grant-scoped state writes resolve the grant's storage binding, which
        // is persisted under the canonical connector key (Decision 1). The PUT
        // route compares that binding against the path connector id verbatim,
        // so the path must carry the canonical key to stay in scope.
        `${rsUrl}/v1/state/${encodeURIComponent(SPOTIFY_CONNECTOR_KEY)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          body: JSON.stringify({ state: { top_artists: { cursor: "cli_grant_timeline_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(updateResp.status, 200);
      const updateRequestId = updateResp.headers.get("Request-Id");
      assert.ok(updateRequestId, "expected updateRequestId to be present");
      assert.ok(updateRequestId.startsWith("req_"));

      const updateTimeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(updateTimeline.json, "expected CLI --format json output to parse");
      const stateRequested = (updateTimeline.json.data || []).find(
        (event) => event.event_type === "state.requested" && event.object_id === updateRequestId
      );
      assert.ok(stateRequested, "grant timeline should include state.requested for grant-scoped writes");
      assert.equal(stateRequested.data?.state_scope, "grant");
      assert.equal(stateRequested.data?.operation, "write");
      assert.deepEqual(stateRequested.data?.requested_streams, ["top_artists"]);

      const stateUpdated = (updateTimeline.json.data || []).find(
        (event) => event.event_type === "state.updated" && event.object_id === updateRequestId
      );
      assert.ok(stateUpdated, "grant timeline should include state.updated for grant-scoped writes");
      assert.deepEqual(stateUpdated.data?.persisted_streams, ["top_artists"]);

      const rejectedResp = await fetch(
        // Canonical connector key keeps the path in grant scope so the rejection
        // is driven by the out-of-grant stream, not a connector-id mismatch.
        `${rsUrl}/v1/state/${encodeURIComponent(SPOTIFY_CONNECTOR_KEY)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          body: JSON.stringify({ state: { saved_tracks: { cursor: "outside_grant" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      assert.ok(rejectedRequestId, "expected rejectedRequestId to be present");
      assert.ok(rejectedRequestId.startsWith("req_"));

      const rejectedTimeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(rejectedTimeline.json, "expected CLI --format json output to parse");
      const stateRejected = (rejectedTimeline.json.data || []).find(
        (event) => event.event_type === "state.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(stateRejected, "grant timeline should include state.rejected for grant-scoped write failures");
      assert.equal(stateRejected.data?.state_scope, "grant");
      assert.equal(stateRejected.data?.operation, "write");
      assert.equal(asRecord(stateRejected.data?.error).code, "invalid_request");
      assert.match(String(asRecord(stateRejected.data?.error).message ?? ""), TOP_LEVEL_REGEX_55);
    });
  });

  await t.test("grant timeline keeps native revocation artifacts inspectable without connector leakage", async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest, "cli_owner");

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        headers: {
          Authorization: `Bearer ${approved.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(revokeResp.status, 200);

      const result = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "grant_timeline");
      assert.equal(result.json.grant_id, approved.grant.grant_id);

      const revokedEvent = (result.json.data || []).find((event) => event.event_type === "grant.revoked");
      assert.ok(revokedEvent, "grant timeline should include grant.revoked after native revocation");
      assert.equal(asRecord(revokedEvent.data?.source).kind, "provider_native");
      assert.equal(asRecord(revokedEvent.data?.source).id, nativeManifest.provider_id);
      assert.ok(!("connector_id" in (revokedEvent.data || {})), "native revoked event should not expose connector_id");
      assert.ok(
        !("storage_connector_id" in (revokedEvent.data || {})),
        "native revoked event should not expose storage connector ids"
      );
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "grant timeline keeps malformed native revocation rejections provider-first when source identity is still valid",
    async () => {
      await withNativeHarness(async ({ asUrl, nativeManifest }) => {
        const approved = await issueNorthstarClientGrant(asUrl, nativeManifest, "cli_owner");

        getDb()
          .prepare(`
        UPDATE grants
        SET storage_binding_json = ?
        WHERE grant_id = ?
      `)
          .run(
            JSON.stringify({
              connector_id: asRecord(nativeManifest.storage_binding).connector_id,
              debug_context: "should_not_escape",
            }),
            approved.grant.grant_id
          );

        const result = await runCliExpectFailure(
          ["grant", "revoke", approved.grant.grant_id, "--as-url", asUrl, "--format", "json"],
          {
            PDPP_CLIENT_TOKEN: approved.token,
            PDPP_OWNER_TOKEN: "definitely-invalid-owner-token",
          }
        );

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, TOP_LEVEL_REGEX_56);
        const requestId = result.stderr.match(TOP_LEVEL_REGEX_57)?.[1] || null;
        const traceId = result.stderr.match(TOP_LEVEL_REGEX_58)?.[1] || null;
        assert.ok(requestId, "grant revoke failure should surface a request id on stderr");
        assert.ok(traceId, "grant revoke failure should surface a reference trace id on stderr");

        const timeline = await runCli([
          "grant",
          "timeline",
          approved.grant.grant_id,
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");
        const rejectedEvent = (timeline.json.data || []).find(
          (event) => event.event_type === "grant.revoke_rejected" && event.object_id === approved.grant.grant_id
        );
        assert.ok(rejectedEvent, "grant timeline should include grant.revoke_rejected for malformed native revocation");
        assert.equal(rejectedEvent.request_id, requestId);
        assert.equal(rejectedEvent.trace_id, traceId);
        assert.equal(asRecord(rejectedEvent.data?.source).kind, "provider_native");
        assert.equal(asRecord(rejectedEvent.data?.source).id, nativeManifest.provider_id);
        assert.ok(
          !("connector_id" in (rejectedEvent.data || {})),
          "native revoke rejection should not expose connector_id"
        );
        assert.ok(
          !("storage_connector_id" in (rejectedEvent.data || {})),
          "native revoke rejection should not expose storage connector ids"
        );
        assert.equal(asRecord(rejectedEvent.data?.error).code, "grant_invalid");
      });
    }
  );

  await t.test("grant timeline keeps native issuance artifacts inspectable without connector leakage", async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const approved = await issueNorthstarClientGrant(asUrl, nativeManifest, "cli_owner");

      const result = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "grant_timeline");
      assert.equal(result.json.grant_id, approved.grant.grant_id);

      const grantIssued = (result.json.data || []).find((event) => event.event_type === "grant.issued");
      assert.ok(grantIssued, "grant timeline should include grant.issued for native approval");
      assert.equal(asRecord(grantIssued.data?.source).kind, "provider_native");
      assert.equal(asRecord(grantIssued.data?.source).id, nativeManifest.provider_id);
      assert.ok(
        !("connector_id" in (grantIssued.data || {})),
        "native grant-issued event should not expose connector_id"
      );
      assert.ok(
        !("storage_connector_id" in (grantIssued.data || {})),
        "native grant-issued event should not expose storage connector ids"
      );

      const tokenIssued = (result.json.data || []).find((event) => event.event_type === "token.issued");
      assert.ok(tokenIssued, "grant timeline should include token.issued for native approval");
      assert.equal(asRecord(tokenIssued.data?.source).kind, "provider_native");
      assert.equal(asRecord(tokenIssued.data?.source).id, nativeManifest.provider_id);
      assert.equal(tokenIssued.data?.issuance_path, "grant_approval");
      assert.ok(
        !("connector_id" in (tokenIssued.data || {})),
        "native token-issued event should not expose connector_id"
      );
      assert.ok(
        !("storage_connector_id" in (tokenIssued.data || {})),
        "native token-issued event should not expose storage connector ids"
      );
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "grant timeline keeps rejected native client query artifacts inspectable without connector leakage",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);

        const approved = await approveGrant(asUrl, "employee_1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        const rejectedResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records?view=summary&fields=id`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 400);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId, "expected rejectedRequestId to be present");
        assert.ok(rejectedRequestId.startsWith("req_"));
        assert.ok(rejectedTraceId, "expected rejectedTraceId to be present");
        assert.ok(rejectedTraceId.startsWith("trc_"));
        const rejectedBody = asRecord(await rejectedResp.json());
        assert.equal(asRecord(rejectedBody.error).code, "invalid_request");
        assert.match(String(asRecord(rejectedBody.error).message ?? ""), TOP_LEVEL_REGEX_59);

        const timeline = await runCli([
          "grant",
          "timeline",
          approved.grant.grant_id,
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const queryReceived = (timeline.json.data || []).find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(queryReceived, "grant timeline should include query.received for rejected native client reads");
        assert.equal(queryReceived.trace_id, rejectedTraceId);
        assert.equal(queryReceived.stream_id, "pay_statements");
        assert.equal(queryReceived.data?.query_shape, "record_list");
        assert.equal(asRecord(queryReceived.data?.source).kind, "provider_native");
        assert.equal(asRecord(queryReceived.data?.source).id, nativeManifest.provider_id);
        assert.ok(!("connector_id" in (queryReceived.data || {})));
        assert.ok(!("storage_connector_id" in (queryReceived.data || {})));

        const rejectedEvent = (timeline.json.data || []).find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, "grant timeline should include query.rejected for rejected native client reads");
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "pay_statements");
        assert.equal(rejectedEvent.data?.query_shape, "record_list");
        assert.equal(asRecord(rejectedEvent.data?.source).kind, "provider_native");
        assert.equal(asRecord(rejectedEvent.data?.source).id, nativeManifest.provider_id);
        assert.ok(!("connector_id" in (rejectedEvent.data || {})));
        assert.ok(!("storage_connector_id" in (rejectedEvent.data || {})));
        assert.equal(asRecord(rejectedEvent.data?.error).code, "invalid_request");
        assert.match(String(asRecord(rejectedEvent.data?.error).message ?? ""), TOP_LEVEL_REGEX_60);
        assert.equal(timeline.stderr, "");
      });
    }
  );

  await t.test("grant timeline keeps malformed polyfill client stream-list artifacts inspectable", async () => {
    await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, missingConnectorId }) => {
      const result = await runCliExpectFailure(["query", "streams", "--rs-url", rsUrl], {
        PDPP_CLIENT_TOKEN: approved.token,
      });

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_61);
      const requestId = result.stderr.match(TOP_LEVEL_REGEX_62)?.[1];
      const traceId = result.stderr.match(TOP_LEVEL_REGEX_63)?.[1];
      assert.ok(requestId, "malformed polyfill client stream-list read should surface a request id on stderr");
      assert.ok(traceId, "malformed polyfill client stream-list read should surface a reference trace id on stderr");

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      assertMalformedPolyfillClientArtifacts({
        events: timeline.json.data,
        label: "stream-list reads",
        missingConnectorId,
        queryShape: "stream_list",
        requestId,
        stderr: timeline.stderr,
        traceId,
      });
    });
  });

  await t.test("grant timeline keeps malformed polyfill client stream-metadata artifacts inspectable", async () => {
    await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, missingConnectorId }) => {
      const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 403);
      const requestId = rejectedResp.headers.get("Request-Id");
      const traceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId, "malformed polyfill client stream-metadata read should surface a request id");
      assert.ok(traceId, "malformed polyfill client stream-metadata read should surface a reference trace id");
      assert.ok(requestId.startsWith("req_"));
      assert.ok(traceId.startsWith("trc_"));
      const rejectedBody = asRecord(await rejectedResp.json());
      assert.equal(asRecord(rejectedBody.error).code, "grant_invalid");
      assert.match(String(asRecord(rejectedBody.error).message ?? ""), TOP_LEVEL_REGEX_64);

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      assertMalformedPolyfillClientArtifacts({
        events: timeline.json.data,
        label: "stream-metadata reads",
        missingConnectorId,
        queryShape: "stream_metadata",
        requestId,
        stderr: timeline.stderr,
        streamId: "top_artists",
        traceId,
      });
    });
  });

  await t.test("grant timeline keeps malformed polyfill client record-list artifacts inspectable", async () => {
    await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, missingConnectorId }) => {
      const result = await runCliExpectFailure(
        ["query", "records", "top_artists", "--rs-url", rsUrl, "--format", "json"],
        { PDPP_CLIENT_TOKEN: approved.token }
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_65);
      const requestId = result.stderr.match(TOP_LEVEL_REGEX_66)?.[1];
      const traceId = result.stderr.match(TOP_LEVEL_REGEX_67)?.[1];
      assert.ok(requestId, "malformed polyfill client record-list read should surface a request id on stderr");
      assert.ok(traceId, "malformed polyfill client record-list read should surface a reference trace id on stderr");

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      assertMalformedPolyfillClientArtifacts({
        events: timeline.json.data,
        label: "record-list reads",
        missingConnectorId,
        queryShape: "record_list",
        requestId,
        stderr: timeline.stderr,
        streamId: "top_artists",
        traceId,
      });
    });
  });

  await t.test("grant timeline keeps malformed polyfill client record-detail artifacts inspectable", async () => {
    await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, visibleRecord, missingConnectorId }) => {
      const result = await runCliExpectFailure(
        ["query", "get", "top_artists", String(visibleRecord.id), "--rs-url", rsUrl],
        { PDPP_CLIENT_TOKEN: approved.token }
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_68);
      const requestId = result.stderr.match(TOP_LEVEL_REGEX_69)?.[1];
      const traceId = result.stderr.match(TOP_LEVEL_REGEX_70)?.[1];
      assert.ok(requestId, "malformed polyfill client record-detail read should surface a request id on stderr");
      assert.ok(traceId, "malformed polyfill client record-detail read should surface a reference trace id on stderr");

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      assertMalformedPolyfillClientArtifacts({
        events: timeline.json.data,
        label: "record-detail reads",
        missingConnectorId,
        queryShape: "record_detail",
        requestedRecordId: String(visibleRecord.id),
        requestId,
        stderr: timeline.stderr,
        streamId: "top_artists",
        traceId,
      });
    });
  });

  await t.test("trace show keeps malformed polyfill client query artifacts inspectable", async () => {
    interface QueryTriggerResult {
      readonly requestId?: string | null;
      readonly stderr: string;
      readonly traceId?: string | null;
    }
    type QueryTriggerContext = Pick<MalformedPolyfillClientContext, "rsUrl" | "approved" | "visibleRecord">;
    interface QueryScenario {
      readonly label: string;
      readonly queryShape: string;
      readonly requestedRecordId?: (ctx: Pick<MalformedPolyfillClientContext, "visibleRecord">) => string;
      readonly streamId?: string;
      readonly trigger: (ctx: QueryTriggerContext) => Promise<QueryTriggerResult>;
    }
    const scenarios: readonly QueryScenario[] = [
      {
        label: "stream-list reads",
        queryShape: "stream_list",
        trigger: ({ rsUrl, approved }) =>
          runCliExpectFailure(["query", "streams", "--rs-url", rsUrl], { PDPP_CLIENT_TOKEN: approved.token }),
      },
      {
        label: "stream-metadata reads",
        queryShape: "stream_metadata",
        streamId: "top_artists",
        trigger: async ({ rsUrl, approved }) => {
          const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists`, {
            headers: { Authorization: `Bearer ${approved.token}` },
          });
          assert.equal(rejectedResp.status, 403);
          const rejectedBody = asRecord(await rejectedResp.json());
          const rejectedError = asRecord(rejectedBody.error);
          assert.equal(rejectedError.code, "grant_invalid");
          assert.match(String(rejectedError.message ?? ""), TOP_LEVEL_REGEX_71);
          return {
            requestId: rejectedResp.headers.get("Request-Id"),
            stderr: "",
            traceId: rejectedResp.headers.get("PDPP-Reference-Trace-Id"),
          };
        },
      },
      {
        label: "record-list reads",
        queryShape: "record_list",
        streamId: "top_artists",
        trigger: ({ rsUrl, approved }) =>
          runCliExpectFailure(["query", "records", "top_artists", "--rs-url", rsUrl, "--format", "json"], {
            PDPP_CLIENT_TOKEN: approved.token,
          }),
      },
      {
        label: "record-detail reads",
        queryShape: "record_detail",
        requestedRecordId: ({ visibleRecord }) => String(visibleRecord.id),
        streamId: "top_artists",
        trigger: ({ rsUrl, approved, visibleRecord }) =>
          runCliExpectFailure(["query", "get", "top_artists", String(visibleRecord.id), "--rs-url", rsUrl], {
            PDPP_CLIENT_TOKEN: approved.token,
          }),
      },
    ];

    for await (const scenario of scenarios) {
      await withMalformedPolyfillClientGrant(async ({ asUrl, rsUrl, approved, visibleRecord, missingConnectorId }) => {
        const failure = await scenario.trigger({ approved, rsUrl, visibleRecord });
        assert.match(failure.stderr || "Grant is malformed or no longer valid", TOP_LEVEL_REGEX_72);
        const requestId = failure.requestId || failure.stderr?.match(TOP_LEVEL_REGEX_73)?.[1];
        const traceId = failure.traceId || failure.stderr?.match(TOP_LEVEL_REGEX_74)?.[1];
        assert.ok(requestId, `malformed polyfill client ${scenario.label} should surface a request id`);
        assert.ok(traceId, `malformed polyfill client ${scenario.label} should surface a reference trace id`);

        const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(trace.json, "expected CLI --format json output to parse");

        assertMalformedPolyfillClientArtifacts({
          events: trace.json.data,
          label: scenario.label,
          missingConnectorId,
          queryShape: scenario.queryShape,
          requestedRecordId:
            typeof scenario.requestedRecordId === "function" ? scenario.requestedRecordId({ visibleRecord }) : null,
          requestId,
          stderr: trace.stderr,
          streamId: scenario.streamId,
          traceId,
        });
      });
    }
  });

  await t.test("grant timeline keeps rejected field-limited changes_since filter artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "continuous",
        client_display: { name: "Concert Recommendation App" },
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time using the basic top-artist subset",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [
          {
            fields: ["id", "name", "genres"],
            name: "top_artists",
          },
        ],
      });

      const changesSince = Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64");
      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(changesSince)}&filter[popularity][eq]=96`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId, "expected rejectedRequestId to be present");
      assert.ok(rejectedRequestId.startsWith("req_"));
      assert.ok(rejectedTraceId, "expected rejectedTraceId to be present");
      assert.ok(rejectedTraceId.startsWith("trc_"));
      const rejectedBody = asRecord(await rejectedResp.json());
      assert.equal(asRecord(rejectedBody.error).code, "invalid_request");
      assert.match(String(asRecord(rejectedBody.error).message ?? ""), TOP_LEVEL_REGEX_CLIENT_FILTER_UNSUPPORTED);

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      const queryReceived = (timeline.json.data || []).find(
        (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceived, "grant timeline should include query.received for rejected changes_since filter reads");
      assert.equal(queryReceived.trace_id, rejectedTraceId);
      assert.equal(queryReceived.stream_id, "top_artists");
      assert.equal(queryReceived.data?.query_shape, "record_list");
      assert.equal(queryReceived.data?.has_changes_since, true);
      assert.equal(asRecord(queryReceived.data?.source).kind, "connector");
      assert.equal(asRecord(queryReceived.data?.source).id, spotifyManifest.connector_id);

      const rejectedEvent = (timeline.json.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, "grant timeline should include query.rejected for rejected changes_since filter reads");
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, "top_artists");
      assert.equal(rejectedEvent.data?.query_shape, "record_list");
      assert.equal(rejectedEvent.data?.has_changes_since, true);
      assert.equal(asRecord(rejectedEvent.data?.source).kind, "connector");
      assert.equal(asRecord(rejectedEvent.data?.source).id, spotifyManifest.connector_id);
      assert.equal(asRecord(rejectedEvent.data?.error).code, "invalid_request");
      assert.match(
        String(asRecord(rejectedEvent.data?.error).message ?? ""),
        TOP_LEVEL_REGEX_CLIENT_FILTER_UNSUPPORTED
      );

      const servedEvent = (timeline.json.data || []).find(
        (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, "rejected changes_since filter reads should not produce disclosure.served");
      assert.equal(timeline.stderr, "");
    });
  });

  await t.test("grant timeline keeps rejected record-detail resource boundaries inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "single_use",
        client_display: { name: "Concert Recommendation App" },
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Recommend concerts using a chosen artist subset",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [
          {
            name: "top_artists",
            resources: ["spotify:artist:0C0XlULifJtAgn6ZNCW2eu", "spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ"],
          },
        ],
      });

      const rejectedId = "spotify:artist:6eUKZXaKkcviH0Ku9w2n3V";
      const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(rejectedId)}`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId, "expected rejectedRequestId to be present");
      assert.ok(rejectedRequestId.startsWith("req_"));
      assert.ok(rejectedTraceId, "expected rejectedTraceId to be present");
      assert.ok(rejectedTraceId.startsWith("trc_"));
      const rejectedBody = asRecord(await rejectedResp.json());
      assert.equal(asRecord(rejectedBody.error).code, "not_found");
      assert.match(String(asRecord(rejectedBody.error).message ?? ""), TOP_LEVEL_REGEX_77);

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      const queryReceived = (timeline.json.data || []).find(
        (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceived, "grant timeline should include query.received for rejected record-detail reads");
      assert.equal(queryReceived.trace_id, rejectedTraceId);
      assert.equal(queryReceived.stream_id, "top_artists");
      assert.equal(queryReceived.data?.query_shape, "record_detail");
      assert.equal(queryReceived.data?.requested_record_id, rejectedId);
      assert.equal(asRecord(queryReceived.data?.source).kind, "connector");
      assert.equal(asRecord(queryReceived.data?.source).id, spotifyManifest.connector_id);

      const rejectedEvent = (timeline.json.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, "grant timeline should include query.rejected for rejected record-detail reads");
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, "top_artists");
      assert.equal(rejectedEvent.data?.query_shape, "record_detail");
      assert.equal(rejectedEvent.data?.requested_record_id, rejectedId);
      assert.equal(asRecord(rejectedEvent.data?.source).kind, "connector");
      assert.equal(asRecord(rejectedEvent.data?.source).id, spotifyManifest.connector_id);
      assert.equal(asRecord(rejectedEvent.data?.error).code, "not_found");
      assert.match(String(asRecord(rejectedEvent.data?.error).message ?? ""), TOP_LEVEL_REGEX_78);

      const servedEvent = (timeline.json.data || []).find(
        (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, "rejected record-detail reads should not produce disclosure.served");
      assert.equal(timeline.stderr, "");
    });
  });

  await t.test(
    "grant timeline keeps rejected stream-boundary client reads inspectable across metadata, record-list, and record-detail routes",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const ownerListResp = await fetchJson<RsRecordsPage>(
          `${rsUrl}/v1/streams/saved_tracks/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        const hiddenRecord = ownerListResp.body.data?.[0];
        assert.ok(hiddenRecord, "expected an owner-visible saved_tracks record outside the client grant");
        assert.ok(hiddenRecord.id, "expected the hidden saved_tracks record to carry an id");

        await approveGrant(asUrl, "cli_owner", {
          access_mode: "single_use",
          client_display: { name: "Concert Recommendation App" },
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "Recommend concerts using top artists only",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        const scenarios = [
          {
            expectedBodyMessage: TOP_LEVEL_REGEX_INTROSPECTION_FAILED,
            expectedCode: "context.stream_not_allowed",
            expectedTimelineMessage: TOP_LEVEL_REGEX_INVALID_TOKEN,
            expectStatus: 401,
            label: "stream-metadata reads",
            queryShape: "stream_metadata",
            streamId: "recently_played",
            trigger: (token: string) =>
              fetch(`${rsUrl}/v1/streams/recently_played`, {
                headers: { Authorization: `Bearer ${token}` },
              }),
          },
          {
            expectedBodyMessage: TOP_LEVEL_REGEX_INTROSPECTION_FAILED,
            expectedCode: "context.stream_not_allowed",
            expectedTimelineMessage: TOP_LEVEL_REGEX_INVALID_TOKEN,
            expectStatus: 401,
            label: "record-list reads",
            queryShape: "record_list",
            streamId: "recently_played",
            trigger: (token: string) =>
              fetch(`${rsUrl}/v1/streams/recently_played/records?limit=1`, {
                headers: { Authorization: `Bearer ${token}` },
              }),
          },
          {
            expectedBodyMessage: TOP_LEVEL_REGEX_INTROSPECTION_FAILED,
            expectedCode: "context.stream_not_allowed",
            expectedTimelineMessage: TOP_LEVEL_REGEX_INVALID_TOKEN,
            expectStatus: 401,
            label: "record-detail reads",
            queryShape: "record_detail",
            requestedRecordId: hiddenRecord.id,
            streamId: "saved_tracks",
            trigger: (token: string) =>
              fetch(`${rsUrl}/v1/streams/saved_tracks/records/${encodeURIComponent(String(hiddenRecord.id))}`, {
                headers: { Authorization: `Bearer ${token}` },
              }),
          },
        ];

        for await (const scenario of scenarios) {
          const approved = await approveGrant(asUrl, "cli_owner", {
            access_mode: "continuous",
            client_display: { name: "Concert Recommendation App" },
            client_id: "concert_recommendation_app",
            purpose_code: "https://pdpp.dev/purpose/personalization",
            purpose_description: "Recommend concerts using top artists only",
            source: { id: spotifyManifest.connector_id, kind: "connector" },
            streams: [{ name: "top_artists", view: "basic" }],
          });
          const rejectedResp = await scenario.trigger(approved.token);
          const rejectedBody = asRecord(await rejectedResp.clone().json());
          assert.equal(rejectedResp.status, scenario.expectStatus, JSON.stringify({ body: rejectedBody, scenario }));
          const rejectedRequestId = rejectedResp.headers.get("Request-Id");
          const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
          assert.ok(rejectedRequestId, "expected rejectedRequestId to be present");
          assert.ok(rejectedRequestId.startsWith("req_"));
          assert.ok(rejectedTraceId, "expected rejectedTraceId to be present");
          assert.ok(rejectedTraceId.startsWith("trc_"));
          assert.equal(asRecord(rejectedBody.error).code, scenario.expectedCode);
          assert.match(String(asRecord(rejectedBody.error).message ?? ""), scenario.expectedBodyMessage);

          const timeline = await runCli([
            "grant",
            "timeline",
            approved.grant.grant_id,
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          const queryReceived = (timeline.json.data || []).find(
            (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
          );
          assert.ok(queryReceived, `grant timeline should include query.received for rejected ${scenario.label}`);
          assert.equal(queryReceived.trace_id, rejectedTraceId);
          assert.equal(queryReceived.stream_id, scenario.streamId);
          assert.equal(queryReceived.data?.query_shape, scenario.queryShape);
          assert.equal(queryReceived.data?.requested_record_id ?? null, scenario.requestedRecordId ?? null);
          if (scenario.expectStatus === 403) {
            assert.equal(asRecord(queryReceived.data?.source).kind, "connector");
            assert.equal(asRecord(queryReceived.data?.source).id, spotifyManifest.connector_id);
          } else {
            assert.equal(queryReceived.data?.source, undefined);
          }

          const rejectedEvent = (timeline.json.data || []).find(
            (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
          );
          assert.ok(rejectedEvent, `grant timeline should include query.rejected for rejected ${scenario.label}`);
          assert.equal(rejectedEvent.trace_id, rejectedTraceId);
          assert.equal(rejectedEvent.stream_id, scenario.streamId);
          assert.equal(rejectedEvent.data?.query_shape, scenario.queryShape);
          assert.equal(rejectedEvent.data?.requested_record_id ?? null, scenario.requestedRecordId ?? null);
          if (scenario.expectStatus === 403) {
            assert.equal(asRecord(rejectedEvent.data?.source).kind, "connector");
            assert.equal(asRecord(rejectedEvent.data?.source).id, spotifyManifest.connector_id);
          } else {
            assert.equal(rejectedEvent.data?.source, undefined);
          }
          assert.equal(asRecord(rejectedEvent.data?.error).code, scenario.expectedCode);
          assert.match(String(asRecord(rejectedEvent.data?.error).message ?? ""), scenario.expectedTimelineMessage);

          const servedEvent = (timeline.json.data || []).find(
            (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
          );
          assert.equal(servedEvent, undefined, `rejected ${scenario.label} should not produce disclosure.served`);
          assert.equal(timeline.stderr, "");
        }
      });
    }
  );

  await t.test("grant timeline keeps rejected record-detail time-range boundaries inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const since = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "single_use",
        client_display: { name: "Concert Recommendation App" },
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Recommend concerts from recent listening only",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [
          {
            name: "top_artists",
            time_range: { since },
          },
        ],
      });

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = (await ownerRecordsResp.json()) as RsRecordsPage;
      const ownerRecords = ownerRecordsBody.data || [];

      const clientRecordsResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=20`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(clientRecordsResp.status, 200);
      const clientRecordsBody = (await clientRecordsResp.json()) as RsRecordsPage;
      const clientRecords = clientRecordsBody.data || [];

      const visibleIds = new Set(clientRecords.map((record) => record.id));
      const hiddenRecord = ownerRecords.find((record) => !visibleIds.has(record.id));
      assert.ok(hiddenRecord, "expected at least one owner-visible record outside the grant time_range");
      assert.ok(hiddenRecord.id, "expected the hidden record to carry an id");

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(hiddenRecord.id)}`,
        {
          headers: { Authorization: `Bearer ${approved.token}` },
        }
      );
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId, "expected rejectedRequestId to be present");
      assert.ok(rejectedRequestId.startsWith("req_"));
      assert.ok(rejectedTraceId, "expected rejectedTraceId to be present");
      assert.ok(rejectedTraceId.startsWith("trc_"));
      const rejectedBody = asRecord(await rejectedResp.json());
      assert.equal(asRecord(rejectedBody.error).code, "not_found");
      assert.match(String(asRecord(rejectedBody.error).message ?? ""), TOP_LEVEL_REGEX_82);

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      const queryReceived = (timeline.json.data || []).find(
        (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
      );
      assert.ok(
        queryReceived,
        "grant timeline should include query.received for rejected time-range record-detail reads"
      );
      assert.equal(queryReceived.trace_id, rejectedTraceId);
      assert.equal(queryReceived.stream_id, "top_artists");
      assert.equal(queryReceived.data?.query_shape, "record_detail");
      assert.equal(queryReceived.data?.requested_record_id, hiddenRecord.id);
      assert.equal(asRecord(queryReceived.data?.source).kind, "connector");
      assert.equal(asRecord(queryReceived.data?.source).id, spotifyManifest.connector_id);

      const rejectedEvent = (timeline.json.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(
        rejectedEvent,
        "grant timeline should include query.rejected for rejected time-range record-detail reads"
      );
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.stream_id, "top_artists");
      assert.equal(rejectedEvent.data?.query_shape, "record_detail");
      assert.equal(rejectedEvent.data?.requested_record_id, hiddenRecord.id);
      assert.equal(asRecord(rejectedEvent.data?.source).kind, "connector");
      assert.equal(asRecord(rejectedEvent.data?.source).id, spotifyManifest.connector_id);
      assert.equal(asRecord(rejectedEvent.data?.error).code, "not_found");
      assert.match(String(asRecord(rejectedEvent.data?.error).message ?? ""), TOP_LEVEL_REGEX_83);

      const servedEvent = (timeline.json.data || []).find(
        (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
      );
      assert.equal(
        servedEvent,
        undefined,
        "rejected time-range record-detail reads should not produce disclosure.served"
      );
      assert.equal(timeline.stderr, "");
    });
  });

  await t.test("run timeline keeps successful checkpointed run artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const result = await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      assert.ok(result.run_id, "seed run should expose run_id");

      const timeline = await runCli(["run", "timeline", requireRunId(result), "--rs-url", rsUrl, "--format", "json"]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      assert.equal(timeline.json.object, "run_timeline");
      assert.equal(timeline.json.run_id, result.run_id);
      assert.ok(Array.isArray(timeline.json.data));

      const runStarted = (timeline.json.data || []).find((event) => event.event_type === "run.started");
      assert.ok(runStarted, "run timeline should include run.started");
      assert.equal(runStarted.data?.collection_mode, "full_refresh");
      assert.equal(runStarted.data?.state_commit_intent, "commit_on_success");
      assert.deepEqual(runStarted.data?.scope_streams, ["top_artists", "saved_tracks", "recently_played"]);

      const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_staged");
      assert.ok(stagedEvent, "run timeline should include run.state_staged");
      assert.equal(stagedEvent.data?.checkpoint_mode, "checkpointed_streaming");

      const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_advanced");
      assert.ok(advancedEvent, "run timeline should include run.state_advanced");

      const progressEvent = (timeline.json.data || []).find((event) => event.event_type === "run.progress_reported");
      assert.ok(progressEvent, "run timeline should include run.progress_reported");

      const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
      assert.ok(completedEvent, "run timeline should include run.completed");
      assert.equal(completedEvent.data?.checkpoint_commit_status, "committed");
      assert.equal(completedEvent.data?.buffered_records_dropped, 0);
      assert.equal(timeline.stderr, "");
    });
  });

  await t.test("run timeline can discover the AS from PDPP_RS_URL", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const result = await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const timeline = await runCli(["run", "timeline", requireRunId(result), "--format", "json"], {
        PDPP_RS_URL: rsUrl,
      });
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      assert.equal(timeline.json.object, "run_timeline");
      assert.equal(timeline.json.run_id, result.run_id);
      assert.ok((timeline.json.data || []).some((event) => event.event_type === "run.completed"));
      assert.equal(timeline.stderr, "");
    });
  });

  await t.test("run timeline keeps skipped-stream artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-skipped-stream-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
        console.log(JSON.stringify({
          type: 'SKIP_RESULT',
          stream: 'saved_tracks',
          reason: 'rate_limited',
          message: 'Platform returned 429',
        }));
        console.log(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }));
      `
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest as RuntimeConnectorManifest,
          ownerToken,
          rsUrl,
          state: null,
        });

        assert.ok(result.run_id, "skip-only run should expose run_id");

        const timeline = await runCli(["run", "timeline", requireRunId(result), "--as-url", asUrl, "--format", "json"]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        assert.equal(timeline.json.object, "run_timeline");
        assert.equal(timeline.json.run_id, result.run_id);

        const skippedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.stream_skipped");
        assert.ok(skippedEvent, "run timeline should include run.stream_skipped");
        assert.equal(skippedEvent.status, "skipped");
        assert.equal(skippedEvent.stream_id, "saved_tracks");
        assert.equal(asRecord(skippedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(skippedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(skippedEvent.data?.reason, "rate_limited");
        assert.equal(skippedEvent.data?.message, "Platform returned 429");

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
        assert.ok(completedEvent, "run timeline should still include run.completed");
        assert.equal(completedEvent.data?.checkpoint_commit_status, "committed");
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps interaction artifacts inspectable without leaking response secrets", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-interaction-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'cli_run_interaction',
      stream: 'saved_tracks',
      kind: 'credentials',
      message: 'Need a platform token',
      schema: {
        type: 'object',
        properties: {
          token: { type: 'string', format: 'password' },
        },
        required: ['token'],
      },
      timeout_seconds: 30,
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
      `,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest as RuntimeConnectorManifest,
          onInteraction: async (message: unknown) => ({
            data: { token: "super_secret_token" },
            request_id: (message as { request_id?: string }).request_id,
            status: "success",
            type: "INTERACTION_RESPONSE",
          }),
          ownerToken,
          rsUrl,
          state: null,
        });

        assert.ok(result.run_id, "interaction run should expose run_id");

        const timeline = await runCli(["run", "timeline", requireRunId(result), "--as-url", asUrl, "--format", "json"]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        assert.equal(timeline.json.object, "run_timeline");
        assert.equal(timeline.json.run_id, result.run_id);

        const interactionRequired = (timeline.json.data || []).find(
          (event) => event.event_type === "run.interaction_required"
        );
        assert.ok(interactionRequired, "run timeline should include run.interaction_required");
        assert.equal(asRecord(interactionRequired.data?.source).kind, "connector");
        assert.equal(asRecord(interactionRequired.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(interactionRequired.data?.kind, "credentials");
        assert.equal(interactionRequired.data?.stream, "saved_tracks");

        const interactionCompleted = (timeline.json.data || []).find(
          (event) => event.event_type === "run.interaction_completed"
        );
        assert.ok(interactionCompleted, "run timeline should include run.interaction_completed");
        assert.equal(interactionCompleted.data?.status, "success");
        assert.equal(interactionCompleted.data?.stream, "saved_tracks");

        const serializedTimeline = JSON.stringify(timeline.json);
        assert.ok(
          !serializedTimeline.includes("super_secret_token"),
          "run timeline should not persist interaction response secrets"
        );
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps interaction timeout artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-interaction-timeout-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'cli_run_interaction_timeout',
      stream: 'saved_tracks',
      kind: 'credentials',
      message: 'Need a platform token',
      schema: {
        type: 'object',
        properties: {
          token: { type: 'string', format: 'password' },
        },
        required: ['token'],
      },
      timeout_seconds: 0.05,
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
      `,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest as RuntimeConnectorManifest,
          onInteraction: async () => new Promise(() => undefined),
          ownerToken,
          rsUrl,
          state: null,
        });

        assert.ok(result.run_id, "timeout interaction run should expose run_id");

        const timeline = await runCli(["run", "timeline", requireRunId(result), "--as-url", asUrl, "--format", "json"]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const interactionCompleted = (timeline.json.data || []).find(
          (event) => event.event_type === "run.interaction_completed"
        );
        assert.ok(
          interactionCompleted,
          "run timeline should include run.interaction_completed for timed out interactions"
        );
        assert.equal(interactionCompleted.status, "timeout");
        assert.equal(interactionCompleted.data?.status, "timeout");
        assert.equal(interactionCompleted.data?.stream, "saved_tracks");
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps interaction cancelled artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-interaction-cancelled-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'cli_run_interaction_cancelled',
      stream: 'saved_tracks',
      kind: 'credentials',
      message: 'Need a platform token',
      schema: {
        type: 'object',
        properties: {
          token: { type: 'string', format: 'password' },
        },
        required: ['token'],
      },
      timeout_seconds: 300,
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
      `,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest as RuntimeConnectorManifest,
          onInteraction: () => Promise.reject(new Error("user aborted interaction")),
          ownerToken,
          rsUrl,
          state: null,
        });

        assert.ok(result.run_id, "cancelled interaction run should expose run_id");

        const timeline = await runCli(["run", "timeline", requireRunId(result), "--as-url", asUrl, "--format", "json"]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const interactionCompleted = (timeline.json.data || []).find(
          (event) => event.event_type === "run.interaction_completed"
        );
        assert.ok(
          interactionCompleted,
          "run timeline should include run.interaction_completed for cancelled interactions"
        );
        assert.equal(interactionCompleted.status, "cancelled");
        assert.equal(interactionCompleted.data?.status, "cancelled");
        assert.equal(interactionCompleted.data?.stream, "saved_tracks");
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps invalid interaction-handler response failures inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-interaction-invalid-response-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_invalid_response',
    stream: 'saved_tracks',
    kind: 'credentials',
    message: 'Need a platform token',
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string', format: 'password' },
      },
      required: ['token'],
    },
    timeout_seconds: 300,
  }) + '\\n');
});
      `,
        "utf8"
      );

      try {
        let rejected: RuntimeRunConnectorError | undefined;
        await assert.rejects(
          runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "full_refresh",
            connectorId: spotifyManifest.connector_id,
            connectorPath,
            manifest: spotifyManifest as RuntimeConnectorManifest,
            onInteraction: async (message: unknown) => ({
              request_id: (message as { request_id?: string }).request_id,
              status: "success",
              type: "NOT_INTERACTION_RESPONSE",
            }),
            ownerToken,
            rsUrl,
            state: null,
          }),
          (err) => {
            rejected = asRuntimeError(err);
            assert.equal(rejected.failure_reason, "interaction_handler_invalid_response");
            assert.ok(rejected.run_id, "invalid interaction handler response should expose run_id");
            return true;
          }
        );

        const timeline = await runCli([
          "run",
          "timeline",
          requireRunId(rejected),
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        assert.equal(timeline.json.object, "run_timeline");
        assert.equal(timeline.json.run_id, requireRunId(rejected));

        const interactionRequired = (timeline.json.data || []).find(
          (event) => event.event_type === "run.interaction_required"
        );
        assert.ok(
          interactionRequired,
          "run timeline should include run.interaction_required before invalid handler responses fail the run"
        );
        assert.equal(interactionRequired.data?.stream, "saved_tracks");

        const interactionCompleted = (timeline.json.data || []).find(
          (event) => event.event_type === "run.interaction_completed"
        );
        assert.equal(
          interactionCompleted,
          undefined,
          "invalid handler responses should fail before run.interaction_completed is recorded"
        );

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "run timeline should include run.failed for invalid handler responses");
        assert.equal(failedEvent.data?.reason, "interaction_handler_invalid_response");
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test(
    "run timeline keeps malformed INTERACTION envelope failures inspectable without interaction artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-interaction-invalid-envelope-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_invalid_envelope',
    kind: 'mystery',
    message: 'This should fail before entering the durable interaction timeline',
    schema: { type: 'object' },
    timeout_seconds: 300,
  }) + '\\n');
});
      `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              onInteraction: async () => ({
                data: {},
                request_id: "cli_run_interaction_invalid_envelope",
                status: "success",
                type: "INTERACTION_RESPONSE",
              }),
              ownerToken,
              rsUrl,
              state: null,
            }),
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              assert.match(rejected.message, TOP_LEVEL_REGEX_84);
              assert.ok(rejected.run_id, "malformed interaction envelope should expose run_id");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          assert.equal(timeline.json.object, "run_timeline");
          assert.equal(timeline.json.run_id, requireRunId(rejected));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.interaction_required"));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.interaction_completed"));

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for malformed interaction envelopes");
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.records_flushed, 0);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "run timeline keeps malformed INTERACTION schema failures inspectable without interaction artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-interaction-invalid-schema-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_invalid_schema',
    kind: 'manual_action',
    message: 'This should fail before entering the durable interaction timeline',
    schema: ['not-an-object'],
    timeout_seconds: 300,
  }) + '\\n');
});
      `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              onInteraction: async () => ({
                data: {},
                request_id: "cli_run_interaction_invalid_schema",
                status: "success",
                type: "INTERACTION_RESPONSE",
              }),
              ownerToken,
              rsUrl,
              state: null,
            }),
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              assert.match(rejected.message, TOP_LEVEL_REGEX_85);
              assert.ok(rejected.run_id, "malformed INTERACTION schema should expose run_id");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          assert.equal(timeline.json.object, "run_timeline");
          assert.equal(timeline.json.run_id, requireRunId(rejected));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.interaction_required"));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.interaction_completed"));

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for malformed INTERACTION schema values");
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.records_flushed, 0);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "run timeline keeps malformed PROGRESS envelope failures inspectable without progress artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-progress-invalid-envelope-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'top_artists',
    message: 42,
  }) + '\\n');
});
      `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken,
              rsUrl,
              state: null,
            }),
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              assert.ok(rejected.run_id, "malformed PROGRESS envelope should expose run_id");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          assert.equal(timeline.json.object, "run_timeline");
          assert.equal(timeline.json.run_id, requireRunId(rejected));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.progress_reported"));

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for malformed PROGRESS envelopes");
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.records_flushed, 0);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "run timeline keeps malformed PROGRESS total failures inspectable without progress artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-progress-invalid-total-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'top_artists',
    message: 'still malformed',
    count: 1,
    total: -3,
  }) + '\\n');
});
      `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken,
              rsUrl,
              state: null,
            }),
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              assert.match(rejected.message, TOP_LEVEL_REGEX_86);
              assert.ok(rejected.run_id, "malformed PROGRESS total should expose run_id");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          assert.equal(timeline.json.object, "run_timeline");
          assert.equal(timeline.json.run_id, requireRunId(rejected));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.progress_reported"));

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for malformed PROGRESS totals");
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.records_flushed, 0);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "run timeline keeps undeclared-stream PROGRESS failures inspectable without progress artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-progress-undeclared-stream-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'ghost_stream',
    message: 'wrong stream should fail',
  }) + '\\n');
});
      `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken,
              rsUrl,
              state: null,
            }),
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              assert.match(rejected.message, TOP_LEVEL_REGEX_87);
              assert.ok(rejected.run_id, "undeclared-stream PROGRESS failure should expose run_id");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          assert.equal(timeline.json.object, "run_timeline");
          assert.equal(timeline.json.run_id, requireRunId(rejected));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.progress_reported"));

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for undeclared-stream PROGRESS envelopes");
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.records_flushed, 0);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "run timeline keeps malformed SKIP_RESULT envelope failures inspectable without skip artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-skip-invalid-envelope-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'saved_tracks',
    reason: '',
    message: 'missing reason content should fail',
  }) + '\\n');
});
      `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken,
              rsUrl,
              state: null,
            }),
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              assert.ok(rejected.run_id, "malformed SKIP_RESULT envelope should expose run_id");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          assert.equal(timeline.json.object, "run_timeline");
          assert.equal(timeline.json.run_id, requireRunId(rejected));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.stream_skipped"));

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for malformed SKIP_RESULT envelopes");
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.records_flushed, 0);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "run timeline keeps undeclared-stream SKIP_RESULT failures inspectable without skip artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-skip-undeclared-stream-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'ghost_stream',
    reason: 'rate_limited',
    message: 'wrong stream should fail',
  }) + '\\n');
});
      `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken,
              rsUrl,
              state: null,
            }),
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              assert.match(rejected.message, TOP_LEVEL_REGEX_88);
              assert.ok(rejected.run_id, "undeclared-stream SKIP_RESULT failure should expose run_id");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          assert.equal(timeline.json.object, "run_timeline");
          assert.equal(timeline.json.run_id, requireRunId(rejected));
          assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.stream_skipped"));

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for undeclared-stream SKIP_RESULT envelopes");
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.records_flushed, 0);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "run timeline keeps pending-interaction protocol violations inspectable without fabricating blocked artifacts",
    async (subT) => {
      const scenarios = [
        {
          emitted: `process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'saved_tracks',
    record: {
      key: 'blocked_record',
      data: { id: 'blocked_record', name: 'Blocked Record' },
      emitted_at: '2026-04-18T00:00:00Z',
    },
  }) + '\\n');`,
          expectedMessage: "Connector emitted RECORD while waiting for INTERACTION_RESPONSE",
          name: "RECORD while waiting for INTERACTION_RESPONSE",
        },
        {
          emitted: `process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'saved_tracks',
    value: { cursor: 'blocked_cursor' },
  }) + '\\n');`,
          expectedMessage: "Connector emitted STATE while waiting for INTERACTION_RESPONSE",
          name: "STATE while waiting for INTERACTION_RESPONSE",
        },
        {
          emitted: `process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'saved_tracks',
    message: 'blocked progress',
  }) + '\\n');`,
          expectedMessage: "Connector emitted PROGRESS while waiting for INTERACTION_RESPONSE",
          name: "PROGRESS while waiting for INTERACTION_RESPONSE",
        },
        {
          emitted: `process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'saved_tracks',
    reason: 'rate_limited',
    message: 'blocked skip',
  }) + '\\n');`,
          expectedMessage: "Connector emitted SKIP_RESULT while waiting for INTERACTION_RESPONSE",
          name: "SKIP_RESULT while waiting for INTERACTION_RESPONSE",
        },
        {
          emitted: `process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_pending_second',
    stream: 'saved_tracks',
    kind: 'credentials',
    message: 'second interaction should fail',
    schema: { type: 'object', properties: { token: { type: 'string' } } },
    timeout_seconds: 300,
  }) + '\\n');`,
          expectedMessage: "Connector emitted INTERACTION while waiting for INTERACTION_RESPONSE",
          name: "INTERACTION while waiting for INTERACTION_RESPONSE",
        },
        {
          emitted: `process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');`,
          expectedMessage: "Connector emitted DONE while waiting for INTERACTION_RESPONSE",
          name: "DONE while waiting for INTERACTION_RESPONSE",
        },
        {
          emitted: `process.stdout.write('{this-is-not-json}\\n');`,
          expectedMessage: TOP_LEVEL_REGEX_89,
          name: "invalid JSONL while waiting for INTERACTION_RESPONSE",
        },
      ];

      for await (const scenario of scenarios) {
        await subT.test(scenario.name, async () => {
          await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
            const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
            const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-pending-interaction-"));
            const connectorPath = join(tmpDir, "connector.mjs");
            writeFileSync(
              connectorPath,
              `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'cli_run_interaction_pending',
    stream: 'saved_tracks',
    kind: 'credentials',
    message: 'Need a platform token',
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string', format: 'password' },
      },
      required: ['token'],
    },
    timeout_seconds: 300,
  }) + '\\n');
  ${scenario.emitted}
});
          `,
              "utf8"
            );

            try {
              let rejected: RuntimeRunConnectorError | undefined;
              await assert.rejects(
                runConnector({
                  admitRunConnection: fakeAdmitRunConnection(),
                  collectionMode: "full_refresh",
                  connectorId: spotifyManifest.connector_id,
                  connectorPath,
                  manifest: spotifyManifest as RuntimeConnectorManifest,
                  onInteraction: async () => new Promise(() => undefined),
                  ownerToken,
                  rsUrl,
                  state: null,
                }),
                (err) => {
                  rejected = asRuntimeError(err);
                  assert.equal(rejected.failure_reason, "connector_protocol_violation");
                  if (scenario.expectedMessage instanceof RegExp) {
                    assert.match(rejected.message, scenario.expectedMessage);
                  } else {
                    assert.equal(rejected.message, scenario.expectedMessage);
                  }
                  assert.ok(rejected.run_id, `${scenario.name} should expose run_id`);
                  return true;
                }
              );

              const timeline = await runCli([
                "run",
                "timeline",
                requireRunId(rejected),
                "--as-url",
                asUrl,
                "--format",
                "json",
              ]);
              assert.ok(timeline.json, "expected CLI --format json output to parse");

              assert.equal(timeline.json.object, "run_timeline");
              assert.equal(timeline.json.run_id, requireRunId(rejected));

              const interactionRequiredEvents = (timeline.json.data || []).filter(
                (event) => event.event_type === "run.interaction_required"
              );
              assert.equal(
                interactionRequiredEvents.length,
                1,
                "pending-interaction violations should preserve the first interaction request only"
              );
              assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.interaction_completed"));
              assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.progress_reported"));
              assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.stream_skipped"));
              assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.state_staged"));
              assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.state_advanced"));
              assert.ok(!(timeline.json.data || []).some((event) => event.event_type === "run.completed"));

              const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
              assert.ok(
                failedEvent,
                "run timeline should include run.failed for pending-interaction protocol violations"
              );
              assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
              assert.equal(failedEvent.data?.records_flushed, 0);
              assert.equal(failedEvent.data?.buffered_records_dropped, 0);
              assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
              assert.equal(timeline.stderr, "");
            } finally {
              rmSync(tmpDir, { force: true, recursive: true });
            }
          });
        });
      }
    }
  );

  await t.test("run timeline keeps failed checkpoint artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const connectorInstanceId = await materializeCliRunConnection(spotifyManifest.connector_id);
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-failed-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
        console.log(JSON.stringify({ type: 'RECORD', stream: 'top_artists', key: 'cli_run_failed', data: { id: 'cli_run_failed', name: 'CLI Failed Artist' }, emitted_at: '2026-04-18T00:00:00Z' }));
        console.log(JSON.stringify({ type: 'STATE', stream: 'top_artists', value: { cursor: 'cli_failed_cursor' } }));
        process.exit(1);
      `
      );

      const result = await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: spotifyManifest.connector_id,
        connectorInstanceId,
        connectorPath,
        manifest: spotifyManifest as RuntimeConnectorManifest,
        ownerToken,
        rsUrl,
        state: null,
      });

      assert.ok(result.run_id, "failed run should expose run_id");

      const timeline = await runCli(["run", "timeline", requireRunId(result), "--as-url", asUrl, "--format", "json"]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      assert.equal(timeline.json.object, "run_timeline");
      assert.equal(timeline.json.run_id, result.run_id);
      assert.ok(Array.isArray(timeline.json.data));

      const runStarted = (timeline.json.data || []).find((event) => event.event_type === "run.started");
      assert.ok(runStarted, "run timeline should include run.started for failed runs");
      assert.equal(runStarted.data?.collection_mode, "incremental");

      const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_staged");
      assert.ok(stagedEvent, "run timeline should include run.state_staged for failed runs");

      const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
      assert.ok(failedEvent, "run timeline should include run.failed");
      assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
      assert.equal(failedEvent.data?.state_streams_staged, 1);
      assert.equal(failedEvent.data?.state_streams_committed, 0);

      const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
      assert.equal(completedEvent, undefined, "failed run timeline should not include run.completed");
      assert.equal(timeline.stderr, "");
    });
  });

  await t.test("run timeline keeps runtime authentication failures from ingest inspectable", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-authentication-error-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_runtime_authentication_error',
    data: { id: 'cli_runtime_authentication_error', value: 'before auth failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
      `,
        "utf8"
      );

      const rsServer = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/v1/ingest/top_artists") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Invalid or expired token",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      try {
        await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
        const rsPort = serverPort(rsServer);

        let rejected: RuntimeRunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken: "invalid_owner_token",
              rsUrl: `http://localhost:${rsPort}`,
              state: null,
            });
          },
          (err) => {
            rejected = asRuntimeError(err);
            assert.equal(rejected.failure_reason, "authentication_error");
            return true;
          }
        );

        const timeline = await runCli([
          "run",
          "timeline",
          requireRunId(rejected),
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "run timeline should include run.failed for runtime authentication failures");
        assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "authentication_error");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(timeline.stderr, "");
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps runtime permission failures from state persistence inspectable", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-permission-error-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_runtime_permission_error',
    data: { id: 'cli_runtime_permission_error', value: 'before permission failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cli_runtime_permission_error_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
      `,
        "utf8"
      );

      const rsServer = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/v1/ingest/top_artists") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
          return;
        }

        if (req.method === "PUT" && url.pathname === `/v1/state/${encodeURIComponent(SPOTIFY_CONNECTOR_KEY)}`) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Owner token required",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      try {
        await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
        const rsPort = serverPort(rsServer);

        let rejected: RuntimeRunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken: "client_token_instead_of_owner",
              persistState: true,
              rsUrl: `http://localhost:${rsPort}`,
              state: null,
            });
          },
          (err) => {
            rejected = asRuntimeError(err);
            assert.equal(rejected.failure_reason, "permission_error");
            return true;
          }
        );

        const timeline = await runCli([
          "run",
          "timeline",
          requireRunId(rejected),
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_staged");
        assert.ok(stagedEvent, "run timeline should include run.state_staged before runtime permission failures");

        const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_advanced");
        assert.equal(advancedEvent, undefined, "runtime permission failures should not commit checkpoint state");

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "run timeline should include run.failed for runtime permission failures");
        assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "permission_error");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
        assert.equal(timeline.stderr, "");
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps deterministic runtime connector_invalid failures inspectable", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-connector-invalid-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_runtime_connector_invalid',
    data: { id: 'cli_runtime_connector_invalid', value: 'before connector invalid' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
      `,
        "utf8"
      );

      const rsServer = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/v1/ingest/top_artists") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: "connector_invalid",
                message: "Connector manifest is malformed",
                type: "invalid_request_error",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      try {
        await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
        const rsPort = serverPort(rsServer);

        let rejected: RuntimeRunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken: "owner_token",
              rsUrl: `http://localhost:${rsPort}`,
              state: null,
            });
          },
          (err) => {
            rejected = asRuntimeError(err);
            assert.equal(rejected.failure_reason, "connector_invalid");
            return true;
          }
        );

        const timeline = await runCli([
          "run",
          "timeline",
          requireRunId(rejected),
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(
          failedEvent,
          "run timeline should include run.failed for deterministic runtime connector_invalid failures"
        );
        assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "connector_invalid");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(timeline.stderr, "");
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps retryable runtime rate_limit_error failures inspectable", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-rate-limit-error-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_runtime_rate_limit_error',
    data: { id: 'cli_runtime_rate_limit_error', value: 'before rate limit' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
      `,
        "utf8"
      );

      const rsServer = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/v1/ingest/top_artists") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Too many requests",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      try {
        await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
        const rsPort = serverPort(rsServer);

        let rejected: RuntimeRunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              ownerToken: "owner_token",
              rsUrl: `http://localhost:${rsPort}`,
              state: null,
            });
          },
          (err) => {
            rejected = asRuntimeError(err);
            assert.equal(rejected.failure_reason, "rate_limit_error");
            return true;
          }
        );

        const timeline = await runCli([
          "run",
          "timeline",
          requireRunId(rejected),
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(
          failedEvent,
          "run timeline should include run.failed for retryable runtime rate_limit_error failures"
        );
        assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "rate_limit_error");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(timeline.stderr, "");
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps connector-declared terminal error details inspectable on failed runs", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-terminal-error-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_terminal_error',
    data: { id: 'cli_terminal_error', value: 'before terminal failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 1,
    error: { message: 'Remote provider rate limit', retryable: true },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
      `,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest as RuntimeConnectorManifest,
          onInteraction: async () => ({}),
          ownerToken,
          rsUrl,
          state: null,
        });

        assert.equal(result.status, "failed");
        assert.equal(result.terminal_reason, "connector_reported_failed");

        const timeline = await runCli(["run", "timeline", requireRunId(result), "--as-url", asUrl, "--format", "json"]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "run timeline should include run.failed for connector-declared failures");
        assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "connector_reported_failed");
        assert.equal(failedEvent.data?.connector_error_message, "Remote provider rate limit");
        assert.equal(failedEvent.data?.connector_error_retryable, true);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
        assert.equal(completedEvent, undefined, "connector-declared failed runs should not include run.completed");
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test(
    "run timeline keeps connector-declared terminal error details inspectable on cancelled runs",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-terminal-cancelled-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_terminal_cancelled',
    data: { id: 'cli_terminal_cancelled', value: 'before terminal cancellation' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'cancelled',
    records_emitted: 1,
    error: { message: 'User denied follow-up verification', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
      `,
          "utf8"
        );

        try {
          const result = await runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "full_refresh",
            connectorId: spotifyManifest.connector_id,
            connectorPath,
            manifest: spotifyManifest as RuntimeConnectorManifest,
            onInteraction: async () => ({}),
            ownerToken,
            rsUrl,
            state: null,
          });

          assert.equal(result.status, "cancelled");
          assert.equal(result.terminal_reason, "connector_reported_cancelled");

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(result),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for connector-declared cancellations");
          assert.equal(failedEvent.status, "cancelled");
          assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
          assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data?.reason, "connector_reported_cancelled");
          assert.equal(failedEvent.data?.connector_error_message, "User denied follow-up verification");
          assert.equal(failedEvent.data?.connector_error_retryable, false);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");

          const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
          assert.equal(completedEvent, undefined, "connector-declared cancelled runs should not include run.completed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test("run timeline keeps terminal counter mismatch protocol-violation details inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-terminal-counter-mismatch-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_terminal_counter_mismatch',
    data: { id: 'cli_terminal_counter_mismatch', value: 'before mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cli_terminal_counter_mismatch_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
      `,
        "utf8"
      );

      try {
        let rejected: RuntimeRunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              onInteraction: async () => ({}),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            });
          },
          (err) => {
            rejected = asRuntimeError(err);
            assert.equal(rejected.failure_reason, "connector_protocol_violation");
            assert.equal(rejected.terminal_reason, "connector_protocol_violation");
            return true;
          }
        );

        const timeline = await runCli([
          "run",
          "timeline",
          requireRunId(rejected),
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_staged");
        assert.ok(stagedEvent, "run timeline should include run.state_staged before terminal counter mismatch failure");

        const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_advanced");
        assert.equal(advancedEvent, undefined, "terminal counter mismatch should not commit checkpoint state");

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "run timeline should include run.failed for terminal counter mismatch");
        assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.reported_records_emitted, 2);
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps invalid DONE status protocol violations inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-invalid-done-status-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_invalid_done_status',
    data: { id: 'cli_invalid_done_status', value: 'before invalid done status' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cli_invalid_done_status_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'mystery',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(1);
});
      `,
        "utf8"
      );

      try {
        let rejected: RuntimeRunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              onInteraction: async () => ({}),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            });
          },
          (err) => {
            rejected = asRuntimeError(err);
            assert.equal(rejected.failure_reason, "connector_protocol_violation");
            return true;
          }
        );

        const timeline = await runCli([
          "run",
          "timeline",
          requireRunId(rejected),
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_staged");
        assert.ok(stagedEvent, "run timeline should include run.state_staged before invalid DONE.status failure");

        const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_advanced");
        assert.equal(advancedEvent, undefined, "invalid DONE.status should not commit checkpoint state");

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
        assert.equal(completedEvent, undefined, "invalid DONE.status should not emit run.completed");

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "run timeline should include run.failed for invalid DONE.status");
        assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps DONE and exit-code mismatch protocol violations inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const scenarios = [
        {
          doneStatus: "succeeded",
          exitCode: 1,
          expectedExitCode: 1,
          name: "DONE(succeeded) exiting non-zero",
          recordKey: "cli_done_succeeded_exit_mismatch",
          recordsEmitted: 1,
          tmpPrefix: "pdpp-cli-run-done-succeeded-exit-mismatch-",
        },
        {
          doneStatus: "failed",
          exitCode: 0,
          expectedExitCode: 0,
          name: "DONE(failed) exiting zero",
          recordKey: "cli_done_failed_exit_mismatch",
          recordsEmitted: 1,
          tmpPrefix: "pdpp-cli-run-done-failed-exit-mismatch-",
        },
      ];

      for await (const scenario of scenarios) {
        const tmpDir = mkdtempSync(join(tmpdir(), scenario.tmpPrefix));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: '${scenario.recordKey}',
    data: { id: '${scenario.recordKey}', value: 'before exit mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: '${scenario.recordKey}_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: '${scenario.doneStatus}',
    records_emitted: ${scenario.recordsEmitted},
  }) + '\\n');
  rl.close();
  process.exit(${scenario.exitCode});
});
        `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            async () => {
              await runConnector({
                admitRunConnection: fakeAdmitRunConnection(),
                collectionMode: "incremental",
                connectorId: spotifyManifest.connector_id,
                connectorPath,
                manifest: spotifyManifest as RuntimeConnectorManifest,
                onInteraction: async () => ({}),
                ownerToken,
                persistState: true,
                rsUrl,
                state: null,
              });
            },
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_staged");
          assert.ok(stagedEvent, `run timeline should include run.state_staged for ${scenario.name}`);

          const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_advanced");
          assert.equal(advancedEvent, undefined, `${scenario.name} should not commit checkpoint state`);

          const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
          assert.equal(completedEvent, undefined, `${scenario.name} should not emit run.completed`);

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, `run timeline should include run.failed for ${scenario.name}`);
          assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
          assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.exit_code, scenario.expectedExitCode);
          assert.equal(failedEvent.data?.records_flushed, 1);
          assert.equal(failedEvent.data?.buffered_records_dropped, 0);
          assert.equal(failedEvent.data?.state_streams_staged, 1);
          assert.equal(failedEvent.data?.state_streams_committed, 0);
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      }
    });
  });

  await t.test(
    "run timeline keeps contradictory success-terminal error violations inspectable without surfacing connector error details",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-done-succeeded-error-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
    error: { message: 'should_not_be_allowed', retryable: true },
  }) + '\\n');
  rl.close();
  process.exit(0);
});
      `,
          "utf8"
        );

        try {
          let rejected: RuntimeRunConnectorError | undefined;
          await assert.rejects(
            async () => {
              await runConnector({
                admitRunConnection: fakeAdmitRunConnection(),
                collectionMode: "full_refresh",
                connectorId: spotifyManifest.connector_id,
                connectorPath,
                manifest: spotifyManifest as RuntimeConnectorManifest,
                onInteraction: async () => ({}),
                ownerToken,
                rsUrl,
                state: null,
              });
            },
            (err) => {
              rejected = asRuntimeError(err);
              assert.equal(rejected.failure_reason, "connector_protocol_violation");
              return true;
            }
          );

          const timeline = await runCli([
            "run",
            "timeline",
            requireRunId(rejected),
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");

          const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
          assert.equal(
            completedEvent,
            undefined,
            "contradictory success-terminal errors should not emit run.completed"
          );

          const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "run timeline should include run.failed for contradictory success-terminal errors");
          assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
          assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
          assert.ok(
            !("connector_error_message" in failedEvent.data),
            "protocol-violation timeline should not surface contradictory DONE.error details"
          );
          assert.ok(
            !("connector_error_retryable" in failedEvent.data),
            "protocol-violation timeline should not surface contradictory DONE.error details"
          );
          assert.equal(timeline.stderr, "");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test("run timeline keeps post-DONE protocol violations inspectable without completed artifacts", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-post-done-violation-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_post_done_violation_before',
    data: { id: 'cli_post_done_violation_before', value: 'before_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cli_post_done_violation_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'cli_post_done_violation_after',
    data: { id: 'cli_post_done_violation_after', value: 'after_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  rl.close();
  process.exit(0);
});
      `,
        "utf8"
      );

      try {
        let rejected: RuntimeRunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest as RuntimeConnectorManifest,
              onInteraction: async () => ({}),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            });
          },
          (err) => {
            rejected = asRuntimeError(err);
            assert.equal(rejected.failure_reason, "connector_protocol_violation");
            return true;
          }
        );

        const timeline = await runCli([
          "run",
          "timeline",
          requireRunId(rejected),
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");

        const stagedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_staged");
        assert.ok(stagedEvent, "run timeline should include run.state_staged before post-DONE protocol failure");

        const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_advanced");
        assert.equal(advancedEvent, undefined, "post-DONE protocol violation should not commit checkpoint state");

        const completedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.completed");
        assert.equal(completedEvent, undefined, "post-DONE protocol violation should not leave a completed artifact");

        const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "run timeline should include run.failed for post-DONE protocol violations");
        assert.equal(asRecord(failedEvent.data?.source).kind, "connector");
        assert.equal(asRecord(failedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(timeline.stderr, "");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("run timeline keeps partial checkpoint commit artifacts inspectable", async () => {
    const manifest = {
      connector_id: "https://registry.pdpp.dev/connectors/cli-run-partial-checkpoint-test",
      source_declaration: {
        declaration_version: "cli-run-partial-checkpoint-test-v1",
        display: { name: "CLI Run Partial Checkpoint Test" },
        extensions: {},
        protocol_version: "0.1.0",
        publisher: { id: "https://publishers.example/pdpp-test" },
        source: { id: "https://registry.pdpp.dev/connectors/cli-run-partial-checkpoint-test", kind: "connector" },
        streams: [
          {
            name: "items",
            primary_key: ["id"],
            schema: {
              properties: {
                id: { type: "string" },
                value: { type: "string" },
              },
              required: ["id"],
              type: "object",
            },
            selection: { fields: true, resources: true },
            semantics: "mutable_state",
          },
          {
            name: "other_items",
            primary_key: ["id"],
            schema: {
              properties: {
                id: { type: "string" },
                value: { type: "string" },
              },
              required: ["id"],
              type: "object",
            },
            selection: { fields: true, resources: true },
            semantics: "mutable_state",
          },
        ],
      },
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
        {
          name: "other_items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "0.1.0",
    };
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-cli-run-partial-checkpoint-"));
    const connectorPath = join(tmpDir, "connector.mjs");
    writeFileSync(
      connectorPath,
      `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'partial_checkpoint_item',
    data: { id: 'partial_checkpoint_item', value: 'items value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'partial_checkpoint_other_item',
    data: { id: 'partial_checkpoint_other_item', value: 'other value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'other_items',
    cursor: { cursor: 'other_items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
      "utf8"
    );

    const server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: 0,
      ...TEST_INTROSPECTION_SERVER_OPTS,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const committedState: unknown[] = [];
    let stateWriteCount = 0;
    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname.startsWith("/v1/ingest/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
        return;
      }

      if (req.method === "PUT" && url.pathname === `/v1/state/${encodeURIComponent(manifest.connector_id)}`) {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        stateWriteCount += 1;
        const payload = JSON.parse(body || "{}");
        if (stateWriteCount === 1) {
          committedState.push(payload.state);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "simulated_state_write_failure" }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
      const rsPort = serverPort(rsServer);

      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registerResp.status, 201);

      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      let rejected: RuntimeRunConnectorError | undefined;
      await assert.rejects(
        async () => {
          await runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "incremental",
            connectorId: manifest.connector_id,
            connectorPath,
            manifest: manifest as RuntimeConnectorManifest,
            onInteraction: async () => ({}),
            ownerToken,
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            state: null,
          });
        },
        (err) => {
          rejected = asRuntimeError(err);
          assert.equal(rejected.failure_reason, "runtime_error");
          assert.ok(rejected.checkpoint_summary, "expected checkpoint_summary on the rejected run");
          assert.equal(rejected.checkpoint_summary.state_streams_staged, 2);
          assert.equal(rejected.checkpoint_summary.state_streams_committed, 1);
          return true;
        }
      );

      assert.deepEqual(committedState, [{ items: { cursor: "items_cursor_partial_commit" } }]);
      assert.ok(rejected?.run_id, "partial checkpoint failure should expose run_id");

      const timeline = await runCli(["run", "timeline", requireRunId(rejected), "--as-url", asUrl, "--format", "json"]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");

      assert.equal(timeline.json.object, "run_timeline");
      assert.equal(timeline.json.run_id, requireRunId(rejected));

      const advancedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.state_advanced");
      assert.ok(advancedEvent, "run timeline should include run.state_advanced for the committed stream");
      assert.equal(advancedEvent.stream_id, "items");
      assert.equal(advancedEvent.data?.state_streams_committed, 1);

      const commitFailedEvent = (timeline.json.data || []).find(
        (event) => event.event_type === "run.state_commit_failed"
      );
      assert.ok(commitFailedEvent, "run timeline should include run.state_commit_failed");
      assert.equal(commitFailedEvent.stream_id, "other_items");
      assert.deepEqual(commitFailedEvent.data?.cursor, { cursor: "other_items_cursor_partial_commit" });
      assert.equal(commitFailedEvent.data?.state_streams_staged, 2);
      assert.equal(commitFailedEvent.data?.state_streams_committed, 1);
      assert.match(String(commitFailedEvent.data?.error_message ?? ""), TOP_LEVEL_REGEX_90);

      const failedEvent = (timeline.json.data || []).find((event) => event.event_type === "run.failed");
      assert.ok(failedEvent, "run timeline should include run.failed for partial checkpoint failures");
      assert.equal(failedEvent.data?.reason, "runtime_error");
      assert.equal(failedEvent.data?.checkpoint_commit_status, "partially_committed");
      assert.equal(failedEvent.data?.state_streams_staged, 2);
      assert.equal(failedEvent.data?.state_streams_committed, 1);
      assert.equal(timeline.stderr, "");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
      await closeHttpServer(rsServer);
      await closeServer(server);
    }
  });

  await t.test("trace show returns the enclosing trace for an issued grant", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);
      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "single_use",
        client_display: { name: "Concert Recommendation App" },
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Recommend concerts based on listening history",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const timeline = await runCli([
        "grant",
        "timeline",
        approved.grant.grant_id,
        "--rs-url",
        rsUrl,
        "--format",
        "json",
      ]);
      assert.ok(timeline.json, "expected CLI --format json output to parse");
      const traceId = timeline.json.trace_id;
      assert.ok(typeof traceId === "string", "expected a string trace_id");

      const result = await runCli(["trace", "show", traceId, "--rs-url", rsUrl, "--format", "json"]);
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "trace");
      assert.equal(result.json.trace_id, traceId);
      assert.ok(Array.isArray(result.json.data));
      assert.ok(result.json.data.some((event) => event.event_type === "grant.issued"));
      assert.ok(result.json.data.some((event) => event.event_type === "token.issued"));
      assert.equal(result.stderr, "");
    });
  });

  await t.test("trace show keeps owner mutation artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");

      const ingestResp = await fetch(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          body: [
            JSON.stringify({
              data: { id: "cli_trace_owner_mutation", name: "CLI Trace Artist" },
              emitted_at: "2026-04-18T00:00:00Z",
              key: "cli_trace_owner_mutation",
            }),
            '{"bad":',
          ].join("\n"),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        }
      );
      assert.equal(ingestResp.status, 200);
      const ingestTraceId = ingestResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(ingestTraceId, "expected ingestTraceId to be present");
      assert.ok(ingestTraceId.startsWith("trc_mut_"));

      const ingestTrace = await runCli(["trace", "show", ingestTraceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(ingestTrace.json, "expected CLI --format json output to parse");
      const ingestRequested = (ingestTrace.json.data || []).find((event) => event.event_type === "mutation.requested");
      assert.ok(ingestRequested, "trace show should include mutation.requested for owner ingest");
      assert.equal(ingestRequested.data?.operation, "ingest_records");
      assert.equal(asRecord(ingestRequested.data?.source).kind, "connector");
      assert.equal(asRecord(ingestRequested.data?.source).id, SPOTIFY_CONNECTOR_KEY);

      const ingestCompleted = (ingestTrace.json.data || []).find((event) => event.event_type === "mutation.completed");
      assert.ok(ingestCompleted, "trace show should include mutation.completed for owner ingest");
      assert.equal(ingestCompleted.data?.records_accepted, 1);
      assert.equal(ingestCompleted.data?.records_rejected, 1);

      const rejectedDeleteResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent("missing_spotify_connector")}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          method: "DELETE",
        }
      );
      assert.equal(rejectedDeleteResp.status, 404);
      const rejectedDeleteTraceId = rejectedDeleteResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedDeleteTraceId, "expected rejectedDeleteTraceId to be present");
      assert.ok(rejectedDeleteTraceId.startsWith("trc_mut_"));

      const rejectedDeleteTrace = await runCli([
        "trace",
        "show",
        rejectedDeleteTraceId,
        "--as-url",
        asUrl,
        "--format",
        "json",
      ]);
      assert.ok(rejectedDeleteTrace.json, "expected CLI --format json output to parse");
      const rejectedDelete = (rejectedDeleteTrace.json.data || []).find(
        (event) => event.event_type === "mutation.rejected"
      );
      assert.ok(rejectedDelete, "trace show should include mutation.rejected for owner delete failures");
      assert.equal(rejectedDelete.data?.operation, "delete_stream_records");
      assert.equal(asRecord(rejectedDelete.data?.error).code, "not_found");
      assert.match(String(asRecord(rejectedDelete.data?.error).message ?? ""), TOP_LEVEL_REGEX_91);
    });
  });

  await t.test("trace show keeps malformed polyfill owner mutation artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      getDb()
        .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
        .run(
          '{"connector_id":"https://registry.pdpp.dev/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
          SPOTIFY_CONNECTOR_KEY
        );

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          method: "DELETE",
        }
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedBody = asRecord(await rejectedResp.json());
      assert.equal(asRecord(rejectedBody.error).code, "connector_invalid");
      // Owner mutation routes canonicalize the connector id at the namespace
      // boundary, so traces and diagnostics carry the operational key even
      // when the caller supplied the first-party manifest URL.
      assert.match(
        String(asRecord(rejectedBody.error).message ?? ""),
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );
      const requestId = rejectedResp.headers.get("Request-Id");
      const traceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId, "malformed polyfill owner mutation should surface a request id");
      assert.ok(traceId, "malformed polyfill owner mutation should surface a reference trace id");

      const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(trace.json, "expected CLI --format json output to parse");

      const mutationRejected = (trace.json.data || []).find(
        (event) => event.event_type === "mutation.rejected" && event.object_id === requestId
      );
      assert.ok(mutationRejected, "trace show should include mutation.rejected for malformed polyfill owner mutations");
      assert.equal(mutationRejected.data?.operation, "delete_stream_records");
      assert.equal(asRecord(mutationRejected.data?.source).kind, "connector");
      assert.equal(asRecord(mutationRejected.data?.source).id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(asRecord(mutationRejected.data?.error).code, "connector_invalid");
      assert.match(
        String(asRecord(mutationRejected.data?.error).message ?? ""),
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );
    });
  });

  await t.test("trace show keeps owner state artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");

      const updateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`, {
        body: JSON.stringify({ state: { top_artists: { cursor: "cli_trace_state_cursor" } } }),
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
        },
        method: "PUT",
      });
      assert.equal(updateResp.status, 200);
      const updateTraceId = updateResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(updateTraceId, "expected updateTraceId to be present");
      assert.ok(updateTraceId.startsWith("trc_state"));

      const updateTrace = await runCli(["trace", "show", updateTraceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(updateTrace.json, "expected CLI --format json output to parse");
      const stateRequested = (updateTrace.json.data || []).find((event) => event.event_type === "state.requested");
      assert.ok(stateRequested, "trace show should include state.requested for owner state writes");
      assert.equal(stateRequested.data?.state_scope, "owner");
      assert.equal(stateRequested.data?.operation, "write");
      assert.deepEqual(stateRequested.data?.requested_streams, ["top_artists"]);
      assert.equal(asRecord(stateRequested.data?.source).kind, "connector");
      assert.equal(asRecord(stateRequested.data?.source).id, SPOTIFY_CONNECTOR_KEY);

      const stateUpdated = (updateTrace.json.data || []).find((event) => event.event_type === "state.updated");
      assert.ok(stateUpdated, "trace show should include state.updated for owner state writes");
      assert.deepEqual(stateUpdated.data?.persisted_streams, ["top_artists"]);

      const rejectedResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent("missing_spotify_connector")}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedTraceId, "expected rejectedTraceId to be present");
      assert.ok(rejectedTraceId.startsWith("trc_state"));

      const rejectedTrace = await runCli(["trace", "show", rejectedTraceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(rejectedTrace.json, "expected CLI --format json output to parse");
      const stateRejected = (rejectedTrace.json.data || []).find((event) => event.event_type === "state.rejected");
      assert.ok(stateRejected, "trace show should include state.rejected for owner state failures");
      assert.equal(stateRejected.data?.state_scope, "owner");
      assert.equal(stateRejected.data?.operation, "read");
      assert.equal(asRecord(stateRejected.data?.error).code, "not_found");
      assert.match(String(asRecord(stateRejected.data?.error).message ?? ""), TOP_LEVEL_REGEX_92);
    });
  });

  await t.test("trace show keeps malformed polyfill owner state artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");

      getDb()
        .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
        .run(
          '{"connector_id":"https://registry.pdpp.dev/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
          SPOTIFY_CONNECTOR_KEY
        );

      const rejectedResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      assert.equal(rejectedResp.status, 400);
      const rejectedBody = asRecord(await rejectedResp.json());
      assert.equal(asRecord(rejectedBody.error).code, "connector_invalid");
      // Owner state routes canonicalize the connector id at the namespace
      // boundary, so traces and diagnostics carry the operational key even
      // when the caller supplied the first-party manifest URL.
      assert.match(
        String(asRecord(rejectedBody.error).message ?? ""),
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );
      const requestId = rejectedResp.headers.get("Request-Id");
      const traceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId, "malformed polyfill owner state read should surface a request id");
      assert.ok(traceId, "malformed polyfill owner state read should surface a reference trace id");

      const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(trace.json, "expected CLI --format json output to parse");

      const stateRejected = (trace.json.data || []).find(
        (event) => event.event_type === "state.rejected" && event.object_id === requestId
      );
      assert.ok(stateRejected, "trace show should include state.rejected for malformed polyfill owner state reads");
      assert.equal(stateRejected.data?.state_scope, "owner");
      assert.equal(stateRejected.data?.operation, "read");
      assert.equal(asRecord(stateRejected.data?.source).kind, "connector");
      assert.equal(asRecord(stateRejected.data?.source).id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(asRecord(stateRejected.data?.error).code, "connector_invalid");
      assert.match(
        String(asRecord(stateRejected.data?.error).message ?? ""),
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );
    });
  });

  await t.test("owner streams lists seeded streams through the RS", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const result = await runCli(
        ["owner", "streams", "--connector-id", spotifyManifest.connector_id, "--rs-url", rsUrl, "--format", "json"],
        { PDPP_OWNER_TOKEN: ownerToken }
      );
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "list");
      assert.ok(Array.isArray(result.json.data));
      assert.ok(result.json.data.some((stream) => stream.name === "top_artists"));
      assert.ok(result.json.data.some((stream) => stream.name === "saved_tracks"));
      assert.ok(result.json.request_id?.startsWith("req_"));
      assert.ok(typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("client query streams uses a granted client token against the RS", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const result = await runCli(["query", "streams", "--rs-url", rsUrl, "--format", "json"], {
        PDPP_CLIENT_TOKEN: approved.token,
      });
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "list");
      assert.ok(Array.isArray(result.json.data));
      assert.deepEqual(
        result.json.data.map((stream) => stream.name),
        ["top_artists"]
      );
      assert.ok(result.json.request_id?.startsWith("req_"));
      assert.ok(typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("client query records surfaces request and reference trace ids from the RS", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const result = await runCli(["query", "records", "top_artists", "--rs-url", rsUrl, "--format", "json"], {
        PDPP_CLIENT_TOKEN: approved.token,
      });
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "list");
      assert.ok(Array.isArray(result.json.data));
      assert.ok(result.json.request_id?.startsWith("req_"));
      assert.ok(typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("client query records and get preserve field-limited disclosure projections", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "single_use",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Recommend concerts using the basic top-artist subset",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [
          {
            fields: ["id", "name", "genres"],
            name: "top_artists",
          },
        ],
      });

      const listResult = await runCli(
        ["query", "records", "top_artists", "--rs-url", rsUrl, "--format", "json", "--limit", "1"],
        { PDPP_CLIENT_TOKEN: approved.token }
      );
      assert.ok(listResult.json, "expected CLI --format json output to parse");

      assert.equal(listResult.json.object, "list");
      const firstRecord = listResult.json.data?.[0];
      assert.ok(firstRecord, "expected at least one granted record from CLI query records");
      assert.deepEqual(Object.keys(firstRecord.data || {}).sort(), ["genres", "id", "name"]);
      assert.ok(!("popularity" in (firstRecord.data || {})));
      assert.ok(!("followers" in (firstRecord.data || {})));
      assert.ok(!("image_url" in (firstRecord.data || {})));
      assert.ok(!("source_updated_at" in (firstRecord.data || {})));
      assert.ok(listResult.json.request_id?.startsWith("req_"));
      assert.ok(
        typeof listResult.json.reference_trace_id === "string" && listResult.json.reference_trace_id.length > 0
      );
      assert.equal(listResult.stderr, "");

      const detailResult = await runCli(
        ["query", "get", "top_artists", String(firstRecord.id), "--rs-url", rsUrl, "--format", "json"],
        { PDPP_CLIENT_TOKEN: approved.token }
      );
      assert.ok(detailResult.json, "expected CLI --format json output to parse");

      assert.equal(detailResult.json.object, "record");
      assert.deepEqual(Object.keys(detailResult.json.data || {}).sort(), ["genres", "id", "name"]);
      assert.ok(!("popularity" in (detailResult.json.data || {})));
      assert.ok(!("followers" in (detailResult.json.data || {})));
      assert.ok(!("image_url" in (detailResult.json.data || {})));
      assert.ok(!("source_updated_at" in (detailResult.json.data || {})));
      assert.ok(detailResult.json.request_id?.startsWith("req_"));
      assert.ok(
        typeof detailResult.json.reference_trace_id === "string" && detailResult.json.reference_trace_id.length > 0
      );
      assert.equal(detailResult.stderr, "");
    });
  });

  await t.test("client query records keeps resource-limited pagination honest", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = (await ownerRecordsResp.json()) as RsRecordsPage;
      const ownerRecords = ownerRecordsBody.data || [];
      const [mostRecentVisible] = ownerRecords;
      assert.ok(
        mostRecentVisible,
        "expected at least one owner-visible record to scope the CLI resource-limited grant"
      );

      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "single_use",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Recommend concerts using only the latest permitted artist",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [
          {
            name: "top_artists",
            resources: [mostRecentVisible.id],
          },
        ],
      });

      const result = await runCli(
        ["query", "records", "top_artists", "--rs-url", rsUrl, "--format", "json", "--limit", "1"],
        { PDPP_CLIENT_TOKEN: approved.token }
      );
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "list");
      assert.equal(
        result.json.has_more,
        false,
        "CLI query records should not claim more pages when only hidden records remain"
      );
      assert.ok(
        !result.json.next_cursor,
        "CLI query records should not expose next_cursor when no more visible records exist"
      );
      assert.equal(result.json.data?.length, 1);
      assert.equal(result.json.data?.[0]?.id, mostRecentVisible.id);
      assert.ok(result.json.request_id?.startsWith("req_"));
      assert.ok(typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, "");
    });
  });

  await t.test("owner streams works without --connector-id against a native provider RS", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedNorthstar(nativeManifest);

      const result = await runCli(["owner", "streams", "--rs-url", rsUrl, "--format", "json"], {
        PDPP_OWNER_TOKEN: ownerToken,
      });
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "list");
      assert.ok(Array.isArray(result.json.data));
      assert.deepEqual(
        result.json.data.map((stream) => stream.name),
        ["pay_statements", "equity_grants", "benefits_enrollments"]
      );
      assert.ok(result.json.request_id?.startsWith("req_"));
      assert.ok(result.json.reference_trace_id?.startsWith("trc_qry_"));
      assert.equal(result.stderr, "");
    });
  });

  await t.test("client query failures surface request and reference trace ids on stderr", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "cli_owner", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.dev/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const result = await runCliExpectFailure(
        ["query", "records", "top_artists", "--rs-url", rsUrl, "--view", "basic", "--fields", "id"],
        { PDPP_CLIENT_TOKEN: approved.token }
      );

      assert.equal(result.code, 1);
      assert.match(result.stderr, TOP_LEVEL_REGEX_93);
      assert.match(result.stderr, TOP_LEVEL_REGEX_94);
      assert.match(result.stderr, TOP_LEVEL_REGEX_95);
    });
  });

  await t.test(
    "client auth-gate grant_invalid failures still surface request and reference trace ids on stderr",
    async () => {
      const { dbPath, cleanup } = createTempDbPath();
      const nativeManifest = JSON.parse(
        readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/northstar-hr.json"), "utf8")
      );
      let server = await startServer({
        asPort: 0,
        dbPath,
        nativeManifest,
        quiet: true,
        rsPort: 0,
        ...TEST_INTROSPECTION_SERVER_OPTS,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;

      try {
        await seedNorthstar(nativeManifest);

        const approved = await approveGrant(asUrl, "cli_owner", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        getDb()
          .prepare(`
        UPDATE grants
        SET storage_binding_json = NULL
        WHERE grant_id = ?
      `)
          .run(approved.grant.grant_id);

        await closeServer(server);
        server = await startServer({
          asPort: server.asPort,
          dbPath,
          nativeManifest,
          quiet: true,
          rsPort: server.rsPort,
          ...TEST_INTROSPECTION_SERVER_OPTS,
        });

        const result = await runCliExpectFailure(["query", "streams", "--rs-url", rsUrl], {
          PDPP_CLIENT_TOKEN: approved.token,
        });

        assert.equal(result.code, 4);
        assert.match(result.stderr, TOP_LEVEL_REGEX_96);
        assert.match(result.stderr, TOP_LEVEL_REGEX_97);
        assert.match(result.stderr, TOP_LEVEL_REGEX_98);
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  );

  await t.test(
    "client auth-gate grant_revoked failures still surface request and reference trace ids on stderr",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);

        const approved = await approveGrant(asUrl, "cli_owner", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        const result = await runCliExpectFailure(["query", "streams", "--rs-url", rsUrl], {
          PDPP_CLIENT_TOKEN: approved.token,
        });

        assert.equal(result.code, 4);
        assert.match(result.stderr, TOP_LEVEL_REGEX_99);
        assert.match(result.stderr, TOP_LEVEL_REGEX_100);
        assert.match(result.stderr, TOP_LEVEL_REGEX_101);
      });
    }
  );

  await t.test(
    "client auth-gate grant_expired failures still surface request and reference trace ids on stderr",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);

        const approved = await approveGrant(asUrl, "cli_owner", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        getDb()
          .prepare(`
        UPDATE tokens
        SET expires_at = ?
        WHERE token_id = ?
      `)
          .run(new Date(Date.now() - 60_000).toISOString(), approved.token);

        const result = await runCliExpectFailure(["query", "streams", "--rs-url", rsUrl], {
          PDPP_CLIENT_TOKEN: approved.token,
        });

        assert.equal(result.code, 4);
        assert.match(result.stderr, TOP_LEVEL_REGEX_102);
        assert.match(result.stderr, TOP_LEVEL_REGEX_103);
        assert.match(result.stderr, TOP_LEVEL_REGEX_104);
      });
    }
  );

  await t.test("auth-gate client failures stay inspectable through CLI grant timeline and trace readers", async () => {
    const scenarios: readonly AuthGateScenario[] = [
      {
        expectedMessage: TOP_LEVEL_REGEX_105,
        name: "grant_invalid",
        prepare: async ({ approved, server, dbPath, nativeManifest }) => {
          getDb()
            .prepare(`
            UPDATE grants
            SET storage_binding_json = NULL
            WHERE grant_id = ?
          `)
            .run(approved.grant.grant_id);

          await closeServer(server);
          return startServer({
            asPort: server.asPort,
            dbPath,
            nativeManifest,
            quiet: true,
            rsPort: server.rsPort,
            ...TEST_INTROSPECTION_SERVER_OPTS,
          });
        },
      },
      {
        expectedMessage: TOP_LEVEL_REGEX_106,
        name: "grant_revoked",
        prepare: async ({ asUrl, approved, server }) => {
          await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
            headers: {
              Authorization: `Bearer ${approved.token}`,
              "Content-Type": "application/json",
            },
            method: "POST",
          });
          return server;
        },
      },
      {
        expectedMessage: TOP_LEVEL_REGEX_107,
        name: "grant_expired",
        prepare: ({ approved, server }) => {
          getDb()
            .prepare(`
            UPDATE tokens
            SET expires_at = ?
            WHERE token_id = ?
          `)
            .run(new Date(Date.now() - 60_000).toISOString(), approved.token);
          return Promise.resolve(server);
        },
      },
    ];

    for await (const scenario of scenarios) {
      const { dbPath, cleanup } = createTempDbPath();
      const nativeManifest = JSON.parse(
        readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/northstar-hr.json"), "utf8")
      ) as TestManifest;
      let server = await startServer({
        asPort: 0,
        dbPath,
        nativeManifest,
        quiet: true,
        rsPort: 0,
        ...TEST_INTROSPECTION_SERVER_OPTS,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;

      try {
        await seedNorthstar(nativeManifest);
        const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

        server = await scenario.prepare({ approved, asUrl, dbPath, nativeManifest, server });

        const queryFailure = await runCliExpectFailure(["query", "streams", "--rs-url", rsUrl], {
          PDPP_CLIENT_TOKEN: approved.token,
        });

        assert.equal(queryFailure.code, 4);
        assert.match(queryFailure.stderr, scenario.expectedMessage);

        const timeline = await runCli([
          "grant",
          "timeline",
          approved.grant.grant_id,
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");
        const rejectedFromGrantTimeline = (timeline.json.data || []).find(
          (event) => event.event_type === "query.rejected" && event.data?.auth_gate === true
        );

        assert.ok(
          rejectedFromGrantTimeline,
          `grant timeline should include auth-gate query.rejected for ${scenario.name}`
        );
        assert.equal(asRecord(rejectedFromGrantTimeline.data?.error).code, scenario.name);
        assert.equal(rejectedFromGrantTimeline.data?.query_shape, "stream_list");
        assert.ok(typeof timeline.json.trace_id === "string" && timeline.json.trace_id.startsWith("trc_"));

        const traceId = timeline.json.trace_id;
        const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(trace.json, "expected CLI --format json output to parse");
        const rejectedFromTrace = (trace.json.data || []).find(
          (event) => event.event_type === "query.rejected" && event.data?.auth_gate === true
        );

        assert.ok(rejectedFromTrace, `trace show should include auth-gate query.rejected for ${scenario.name}`);
        assert.equal(asRecord(rejectedFromTrace.data?.error).code, scenario.name);
        assert.equal(rejectedFromTrace.data?.query_shape, "stream_list");
        assert.equal(trace.json.trace_id, timeline.json.trace_id);
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  });

  await t.test(
    "auth-gate record-detail failures stay inspectable through CLI grant timeline and trace readers",
    async () => {
      const scenarios: readonly AuthGateScenario[] = [
        {
          expectedMessage: TOP_LEVEL_REGEX_108,
          name: "grant_invalid",
          prepare: async ({ approved, server, dbPath, nativeManifest }) => {
            getDb()
              .prepare(`
            UPDATE grants
            SET storage_binding_json = NULL
            WHERE grant_id = ?
          `)
              .run(approved.grant.grant_id);

            await closeServer(server);
            return startServer({
              asPort: server.asPort,
              dbPath,
              nativeManifest,
              quiet: true,
              rsPort: server.rsPort,
              ...TEST_INTROSPECTION_SERVER_OPTS,
            });
          },
        },
        {
          expectedMessage: TOP_LEVEL_REGEX_109,
          name: "grant_revoked",
          prepare: async ({ asUrl, approved, server }) => {
            await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
              headers: {
                Authorization: `Bearer ${approved.token}`,
                "Content-Type": "application/json",
              },
              method: "POST",
            });
            return server;
          },
        },
        {
          expectedMessage: TOP_LEVEL_REGEX_110,
          name: "grant_expired",
          prepare: ({ approved, server }) => {
            getDb()
              .prepare(`
            UPDATE tokens
            SET expires_at = ?
            WHERE token_id = ?
          `)
              .run(new Date(Date.now() - 60_000).toISOString(), approved.token);
            return Promise.resolve(server);
          },
        },
      ];

      for await (const scenario of scenarios) {
        const { dbPath, cleanup } = createTempDbPath();
        const nativeManifest = JSON.parse(
          readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/northstar-hr.json"), "utf8")
        ) as TestManifest;
        let server = await startServer({
          asPort: 0,
          dbPath,
          nativeManifest,
          quiet: true,
          rsPort: 0,
          ...TEST_INTROSPECTION_SERVER_OPTS,
        });
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;

        try {
          await seedNorthstar(nativeManifest);
          const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

          server = await scenario.prepare({ approved, asUrl, dbPath, nativeManifest, server });

          const recordId = "ps_2026_04_15";
          const queryFailure = await runCliExpectFailure(
            ["query", "get", "pay_statements", recordId, "--rs-url", rsUrl],
            { PDPP_CLIENT_TOKEN: approved.token }
          );

          assert.equal(queryFailure.code, 4);
          assert.match(queryFailure.stderr, scenario.expectedMessage);
          const requestId = queryFailure.stderr.match(TOP_LEVEL_REGEX_111)?.[1];
          const traceId = queryFailure.stderr.match(TOP_LEVEL_REGEX_112)?.[1];
          assert.ok(requestId, `record-detail auth-gate failure should surface a request id for ${scenario.name}`);
          assert.ok(traceId, `record-detail auth-gate failure should surface a trace id for ${scenario.name}`);

          const timeline = await runCli([
            "grant",
            "timeline",
            approved.grant.grant_id,
            "--as-url",
            asUrl,
            "--format",
            "json",
          ]);
          assert.ok(timeline.json, "expected CLI --format json output to parse");
          const receivedFromGrantTimeline = (timeline.json.data || []).find(
            (event) =>
              event.event_type === "query.received" && event.object_id === requestId && event.data?.auth_gate === true
          );
          const rejectedFromGrantTimeline = (timeline.json.data || []).find(
            (event) =>
              event.event_type === "query.rejected" && event.object_id === requestId && event.data?.auth_gate === true
          );

          assert.ok(
            receivedFromGrantTimeline,
            `grant timeline should include auth-gate record-detail receipt for ${scenario.name}`
          );
          assert.equal(receivedFromGrantTimeline.trace_id, traceId);
          assert.equal(receivedFromGrantTimeline.stream_id, "pay_statements");
          assert.equal(receivedFromGrantTimeline.data?.query_shape, "record_detail");
          assert.equal(receivedFromGrantTimeline.data?.requested_record_id, recordId);
          assert.ok(
            rejectedFromGrantTimeline,
            `grant timeline should include auth-gate record-detail rejection for ${scenario.name}`
          );
          assert.equal(rejectedFromGrantTimeline.trace_id, traceId);
          assert.equal(rejectedFromGrantTimeline.stream_id, "pay_statements");
          assert.equal(asRecord(rejectedFromGrantTimeline.data?.error).code, scenario.name);
          assert.equal(rejectedFromGrantTimeline.data?.query_shape, "record_detail");
          assert.equal(rejectedFromGrantTimeline.data?.requested_record_id, recordId);
          assert.ok(typeof timeline.json.trace_id === "string" && timeline.json.trace_id.startsWith("trc_"));

          const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
          assert.ok(trace.json, "expected CLI --format json output to parse");
          const receivedFromTrace = (trace.json.data || []).find(
            (event) =>
              event.event_type === "query.received" && event.object_id === requestId && event.data?.auth_gate === true
          );
          const rejectedFromTrace = (trace.json.data || []).find(
            (event) =>
              event.event_type === "query.rejected" && event.object_id === requestId && event.data?.auth_gate === true
          );

          assert.ok(
            receivedFromTrace,
            `trace show should include auth-gate record-detail receipt for ${scenario.name}`
          );
          assert.equal(receivedFromTrace.data?.query_shape, "record_detail");
          assert.equal(receivedFromTrace.data?.requested_record_id, recordId);
          assert.ok(
            rejectedFromTrace,
            `trace show should include auth-gate record-detail rejection for ${scenario.name}`
          );
          assert.equal(asRecord(rejectedFromTrace.data?.error).code, scenario.name);
          assert.equal(rejectedFromTrace.data?.query_shape, "record_detail");
          assert.equal(rejectedFromTrace.data?.requested_record_id, recordId);
          assert.equal(trace.json.trace_id, traceId);
        } finally {
          await closeServer(server);
          cleanup();
        }
      }
    }
  );

  await t.test(
    "auth-gate record-list failures preserve limit and changes_since through CLI grant timeline and trace readers",
    async () => {
      const { dbPath, cleanup } = createTempDbPath();
      const nativeManifest = JSON.parse(
        readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/northstar-hr.json"), "utf8")
      );
      let server = await startServer({
        asPort: 0,
        dbPath,
        nativeManifest,
        quiet: true,
        rsPort: 0,
        ...TEST_INTROSPECTION_SERVER_OPTS,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;

      try {
        await seedNorthstar(nativeManifest);
        const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

        getDb()
          .prepare(`
        UPDATE grants
        SET storage_binding_json = NULL
        WHERE grant_id = ?
      `)
          .run(approved.grant.grant_id);

        await closeServer(server);
        server = await startServer({
          asPort: server.asPort,
          dbPath,
          nativeManifest,
          quiet: true,
          rsPort: server.rsPort,
        });

        const changesSince = Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64");
        const queryFailure = await runCliExpectFailure(
          ["query", "records", "pay_statements", "--rs-url", rsUrl, "--limit", "1", "--changes-since", changesSince],
          { PDPP_CLIENT_TOKEN: approved.token }
        );

        assert.equal(queryFailure.code, 4);
        assert.match(queryFailure.stderr, TOP_LEVEL_REGEX_113);
        const requestId = queryFailure.stderr.match(TOP_LEVEL_REGEX_114)?.[1];
        const traceId = queryFailure.stderr.match(TOP_LEVEL_REGEX_115)?.[1];
        assert.ok(requestId, "record-list auth-gate failure should surface a request id");
        assert.ok(traceId, "record-list auth-gate failure should surface a trace id");

        const timeline = await runCli([
          "grant",
          "timeline",
          approved.grant.grant_id,
          "--as-url",
          asUrl,
          "--format",
          "json",
        ]);
        assert.ok(timeline.json, "expected CLI --format json output to parse");
        const receivedFromGrantTimeline = (timeline.json.data || []).find(
          (event) =>
            event.event_type === "query.received" && event.object_id === requestId && event.data?.auth_gate === true
        );
        const rejectedFromGrantTimeline = (timeline.json.data || []).find(
          (event) =>
            event.event_type === "query.rejected" && event.object_id === requestId && event.data?.auth_gate === true
        );

        assert.ok(receivedFromGrantTimeline, "grant timeline should include auth-gate record-list receipt");
        assert.equal(receivedFromGrantTimeline.trace_id, traceId);
        assert.equal(receivedFromGrantTimeline.stream_id, "pay_statements");
        assert.equal(receivedFromGrantTimeline.data?.query_shape, "record_list");
        assert.equal(receivedFromGrantTimeline.data?.has_changes_since, true);
        assert.equal(receivedFromGrantTimeline.data?.limit, 1);
        assert.ok(rejectedFromGrantTimeline, "grant timeline should include auth-gate record-list rejection");
        assert.equal(rejectedFromGrantTimeline.trace_id, traceId);
        assert.equal(rejectedFromGrantTimeline.stream_id, "pay_statements");
        assert.equal(asRecord(rejectedFromGrantTimeline.data?.error).code, "grant_invalid");
        assert.equal(rejectedFromGrantTimeline.data?.query_shape, "record_list");
        assert.equal(rejectedFromGrantTimeline.data?.has_changes_since, true);
        assert.equal(rejectedFromGrantTimeline.data?.limit, 1);

        const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(trace.json, "expected CLI --format json output to parse");
        const receivedFromTrace = (trace.json.data || []).find(
          (event) =>
            event.event_type === "query.received" && event.object_id === requestId && event.data?.auth_gate === true
        );
        const rejectedFromTrace = (trace.json.data || []).find(
          (event) =>
            event.event_type === "query.rejected" && event.object_id === requestId && event.data?.auth_gate === true
        );

        assert.ok(receivedFromTrace, "trace show should include auth-gate record-list receipt");
        assert.equal(receivedFromTrace.data?.query_shape, "record_list");
        assert.equal(receivedFromTrace.data?.has_changes_since, true);
        assert.equal(receivedFromTrace.data?.limit, 1);
        assert.ok(rejectedFromTrace, "trace show should include auth-gate record-list rejection");
        assert.equal(asRecord(rejectedFromTrace.data?.error).code, "grant_invalid");
        assert.equal(rejectedFromTrace.data?.query_shape, "record_list");
        assert.equal(rejectedFromTrace.data?.has_changes_since, true);
        assert.equal(rejectedFromTrace.data?.limit, 1);
        assert.equal(trace.json.trace_id, traceId);
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  );

  await t.test(
    "trace show keeps rejected native client query artifacts inspectable without connector leakage",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);
        const approved = await issueNorthstarClientGrant(asUrl, nativeManifest);

        const queryFailure = await runCliExpectFailure(
          ["query", "records", "pay_statements", "--rs-url", rsUrl, "--view", "summary", "--fields", "id"],
          { PDPP_CLIENT_TOKEN: approved.token }
        );

        assert.equal(queryFailure.code, 1);
        assert.match(queryFailure.stderr, TOP_LEVEL_REGEX_116);
        const requestId = queryFailure.stderr.match(TOP_LEVEL_REGEX_117)?.[1];
        const traceId = queryFailure.stderr.match(TOP_LEVEL_REGEX_118)?.[1];
        assert.ok(requestId, "native client query failure should surface a request id on stderr");
        assert.ok(traceId, "native client query failure should surface a reference trace id on stderr");

        const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
        assert.ok(trace.json, "expected CLI --format json output to parse");

        const queryReceived = (trace.json.data || []).find(
          (event) => event.event_type === "query.received" && event.object_id === requestId
        );
        assert.ok(queryReceived, "trace show should include query.received for rejected native client reads");
        assert.equal(queryReceived.data?.query_shape, "record_list");
        assert.equal(queryReceived.stream_id, "pay_statements");
        assert.equal(asRecord(queryReceived.data?.source).kind, "provider_native");
        assert.equal(asRecord(queryReceived.data?.source).id, nativeManifest.provider_id);
        assert.ok(!("connector_id" in (queryReceived.data || {})));
        assert.ok(!("storage_connector_id" in (queryReceived.data || {})));

        const rejectedEvent = (trace.json.data || []).find(
          (event) => event.event_type === "query.rejected" && event.object_id === requestId
        );
        assert.ok(rejectedEvent, "trace show should include query.rejected for rejected native client reads");
        assert.equal(rejectedEvent.data?.query_shape, "record_list");
        assert.equal(rejectedEvent.stream_id, "pay_statements");
        assert.equal(asRecord(rejectedEvent.data?.source).kind, "provider_native");
        assert.equal(asRecord(rejectedEvent.data?.source).id, nativeManifest.provider_id);
        assert.ok(!("connector_id" in (rejectedEvent.data || {})));
        assert.ok(!("storage_connector_id" in (rejectedEvent.data || {})));
        assert.equal(asRecord(rejectedEvent.data?.error).code, "invalid_request");
        assert.match(String(asRecord(rejectedEvent.data?.error).message ?? ""), TOP_LEVEL_REGEX_119);
        assert.equal(trace.stderr, "");
      });
    }
  );

  await t.test("owner streams works without --connector-id against a polyfill RS", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const result = await runCli(["owner", "streams", "--rs-url", rsUrl, "--format", "json"], {
        PDPP_OWNER_TOKEN: ownerToken,
      });
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "list");
      assert.ok(Array.isArray(result.json.data));
      assert.ok(
        result.json.data.some(
          (stream) => stream.name === "top_artists" && stream.connector_id === SPOTIFY_CONNECTOR_KEY
        )
      );
      assert.ok(
        result.json.data.some(
          (stream) => stream.name === "saved_tracks" && stream.connector_id === SPOTIFY_CONNECTOR_KEY
        )
      );
      assert.ok(result.json.request_id?.startsWith("req_"));
      assert.ok(typeof result.json.reference_trace_id === "string" && result.json.reference_trace_id.length > 0);
      assert.equal(result.stderr, "");
    });
  });

  await t.test(
    "polyfill owner read failures surface connector-first messages and correlation ids on stderr",
    async () => {
      await withHarness(async ({ asUrl, rsUrl }) => {
        const ownerToken = await issueOwnerToken(asUrl, "cli_owner");

        const result = await runCliExpectFailure(
          ["owner", "streams", "--connector-id", "missing_spotify_connector", "--rs-url", rsUrl, "--format", "json"],
          { PDPP_OWNER_TOKEN: ownerToken }
        );

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, TOP_LEVEL_REGEX_120);
        assert.match(result.stderr, TOP_LEVEL_REGEX_121);
        assert.match(result.stderr, TOP_LEVEL_REGEX_122);
      });
    }
  );

  await t.test("trace show keeps malformed polyfill owner read artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      getDb()
        .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
        .run(
          '{"connector_id":"https://registry.pdpp.dev/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
          SPOTIFY_CONNECTOR_KEY
        );

      const result = await runCliExpectFailure(
        ["owner", "streams", "--connector-id", spotifyManifest.connector_id, "--rs-url", rsUrl, "--format", "json"],
        { PDPP_OWNER_TOKEN: ownerToken }
      );

      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );
      const requestId = result.stderr.match(TOP_LEVEL_REGEX_123)?.[1];
      const traceId = result.stderr.match(TOP_LEVEL_REGEX_124)?.[1];
      assert.ok(requestId, "malformed polyfill owner read should surface a request id on stderr");
      assert.ok(traceId, "malformed polyfill owner read should surface a reference trace id on stderr");

      const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(trace.json, "expected CLI --format json output to parse");

      const queryReceived = (trace.json.data || []).find(
        (event) => event.event_type === "query.received" && event.object_id === requestId
      );
      assert.ok(queryReceived, "trace show should include query.received for malformed polyfill owner reads");
      assert.equal(queryReceived.data?.query_shape, "stream_list");
      assert.equal(asRecord(queryReceived.data?.source).kind, "connector");
      assert.equal(asRecord(queryReceived.data?.source).id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = (trace.json.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === requestId
      );
      assert.ok(rejectedEvent, "trace show should include query.rejected for malformed polyfill owner reads");
      assert.equal(rejectedEvent.data?.query_shape, "stream_list");
      assert.equal(asRecord(rejectedEvent.data?.source).kind, "connector");
      assert.equal(asRecord(rejectedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(asRecord(rejectedEvent.data?.error).code, "connector_invalid");
      assert.match(
        String(asRecord(rejectedEvent.data?.error).message ?? ""),
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );

      const servedEvent = (trace.json.data || []).find(
        (event) => event.event_type === "disclosure.served" && event.object_id === requestId
      );
      assert.equal(servedEvent, undefined, "malformed polyfill owner reads should not produce disclosure.served");
    });
  });

  await t.test("trace show keeps malformed polyfill owner record-detail artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const beforeResp = await fetchJson<RsRecordsPage>(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      const protectedRecordId = beforeResp.body.data?.[0]?.id;
      assert.ok(protectedRecordId, "expected a seeded record before corrupting the connector manifest");

      getDb()
        .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
        .run(
          '{"connector_id":"https://registry.pdpp.dev/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
          SPOTIFY_CONNECTOR_KEY
        );

      const result = await runCliExpectFailure(
        [
          "owner",
          "get",
          "top_artists",
          protectedRecordId,
          "--connector-id",
          spotifyManifest.connector_id,
          "--rs-url",
          rsUrl,
        ],
        { PDPP_OWNER_TOKEN: ownerToken }
      );

      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );
      const requestId = result.stderr.match(TOP_LEVEL_REGEX_125)?.[1];
      const traceId = result.stderr.match(TOP_LEVEL_REGEX_126)?.[1];
      assert.ok(requestId, "malformed polyfill owner record-detail read should surface a request id on stderr");
      assert.ok(traceId, "malformed polyfill owner record-detail read should surface a reference trace id on stderr");

      const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(trace.json, "expected CLI --format json output to parse");

      const queryReceived = (trace.json.data || []).find(
        (event) => event.event_type === "query.received" && event.object_id === requestId
      );
      assert.ok(
        queryReceived,
        "trace show should include query.received for malformed polyfill owner record-detail reads"
      );
      assert.equal(queryReceived.data?.query_shape, "record_detail");
      assert.equal(queryReceived.stream_id, "top_artists");
      assert.equal(asRecord(queryReceived.data?.source).kind, "connector");
      assert.equal(asRecord(queryReceived.data?.source).id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = (trace.json.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === requestId
      );
      assert.ok(
        rejectedEvent,
        "trace show should include query.rejected for malformed polyfill owner record-detail reads"
      );
      assert.equal(rejectedEvent.data?.query_shape, "record_detail");
      assert.equal(rejectedEvent.stream_id, "top_artists");
      assert.equal(asRecord(rejectedEvent.data?.source).kind, "connector");
      assert.equal(asRecord(rejectedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(asRecord(rejectedEvent.data?.error).code, "connector_invalid");
      assert.match(
        String(asRecord(rejectedEvent.data?.error).message ?? ""),
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );

      const servedEvent = (trace.json.data || []).find(
        (event) => event.event_type === "disclosure.served" && event.object_id === requestId
      );
      assert.equal(
        servedEvent,
        undefined,
        "malformed polyfill owner record-detail reads should not produce disclosure.served"
      );
    });
  });

  await t.test("trace show keeps malformed polyfill owner record-list artifacts inspectable", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      getDb()
        .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
        .run(
          '{"connector_id":"https://registry.pdpp.dev/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
          SPOTIFY_CONNECTOR_KEY
        );

      const result = await runCliExpectFailure(
        ["owner", "export", "top_artists", "--connector-id", spotifyManifest.connector_id, "--rs-url", rsUrl],
        { PDPP_OWNER_TOKEN: ownerToken }
      );

      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );
      const requestId = result.stderr.match(TOP_LEVEL_REGEX_127)?.[1];
      const traceId = result.stderr.match(TOP_LEVEL_REGEX_128)?.[1];
      assert.ok(requestId, "malformed polyfill owner record-list read should surface a request id on stderr");
      assert.ok(traceId, "malformed polyfill owner record-list read should surface a reference trace id on stderr");

      const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(trace.json, "expected CLI --format json output to parse");

      const queryReceived = (trace.json.data || []).find(
        (event) => event.event_type === "query.received" && event.object_id === requestId
      );
      assert.ok(
        queryReceived,
        "trace show should include query.received for malformed polyfill owner record-list reads"
      );
      assert.equal(queryReceived.data?.query_shape, "record_list");
      assert.equal(queryReceived.stream_id, "top_artists");
      assert.equal(asRecord(queryReceived.data?.source).kind, "connector");
      assert.equal(asRecord(queryReceived.data?.source).id, SPOTIFY_CONNECTOR_KEY);

      const rejectedEvent = (trace.json.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === requestId
      );
      assert.ok(
        rejectedEvent,
        "trace show should include query.rejected for malformed polyfill owner record-list reads"
      );
      assert.equal(rejectedEvent.data?.query_shape, "record_list");
      assert.equal(rejectedEvent.stream_id, "top_artists");
      assert.equal(asRecord(rejectedEvent.data?.source).kind, "connector");
      assert.equal(asRecord(rejectedEvent.data?.source).id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(asRecord(rejectedEvent.data?.error).code, "connector_invalid");
      assert.match(
        String(asRecord(rejectedEvent.data?.error).message ?? ""),
        new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
      );

      const servedEvent = (trace.json.data || []).find(
        (event) => event.event_type === "disclosure.served" && event.object_id === requestId
      );
      assert.equal(
        servedEvent,
        undefined,
        "malformed polyfill owner record-list reads should not produce disclosure.served"
      );
    });
  });

  await t.test("owner query works without --connector-id against a native provider RS", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedNorthstar(nativeManifest);

      const result = await runCli(["owner", "query", "pay_statements", "--rs-url", rsUrl, "--format", "json"], {
        PDPP_OWNER_TOKEN: ownerToken,
      });
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.object, "list");
      const northstarRecords = result.json.data || [];
      assert.equal(northstarRecords.length, 1);
      assert.equal(northstarRecords[0]?.id, "ps_2026_04_15");
      assert.ok(result.json.request_id?.startsWith("req_"));
      assert.ok(result.json.reference_trace_id?.startsWith("trc_qry_"));
      assert.equal(result.stderr, "");
    });
  });

  await t.test("owner export works without --connector-id against a native provider RS", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedNorthstar(nativeManifest);

      const result = await runCli(["owner", "export", "pay_statements", "--rs-url", rsUrl], {
        PDPP_OWNER_TOKEN: ownerToken,
      });

      const lines = result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].id, "ps_2026_04_15");
      assert.equal(lines[0].data.employer, "Northstar HR");
      assert.equal(result.stderr, "");
    });
  });

  await t.test("native owner query failures surface request and reference trace ids on stderr", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedNorthstar(nativeManifest);

      const result = await runCliExpectFailure(
        ["owner", "query", "not_a_stream", "--rs-url", rsUrl, "--format", "json"],
        { PDPP_OWNER_TOKEN: ownerToken }
      );

      assert.equal(result.code, 5);
      assert.match(result.stderr, TOP_LEVEL_REGEX_129);
      assert.match(result.stderr, TOP_LEVEL_REGEX_130);
      assert.match(result.stderr, TOP_LEVEL_REGEX_131);
    });
  });

  await t.test("trace show keeps rejected native owner query artifacts inspectable", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedNorthstar(nativeManifest);

      const result = await runCliExpectFailure(
        ["owner", "query", "not_a_stream", "--rs-url", rsUrl, "--format", "json"],
        { PDPP_OWNER_TOKEN: ownerToken }
      );

      assert.equal(result.code, 5);
      const requestId = result.stderr.match(TOP_LEVEL_REGEX_132)?.[1];
      const traceId = result.stderr.match(TOP_LEVEL_REGEX_133)?.[1];
      assert.ok(requestId, "native owner query failure should surface a request id on stderr");
      assert.ok(traceId, "native owner query failure should surface a reference trace id on stderr");

      const trace = await runCli(["trace", "show", traceId, "--as-url", asUrl, "--format", "json"]);
      assert.ok(trace.json, "expected CLI --format json output to parse");

      const queryReceived = (trace.json.data || []).find(
        (event) => event.event_type === "query.received" && event.object_id === requestId
      );
      assert.ok(queryReceived, "trace show should include query.received for rejected native owner reads");
      assert.equal(queryReceived.data?.query_shape, "record_list");
      assert.equal(queryReceived.stream_id, "not_a_stream");
      assert.equal(asRecord(queryReceived.data?.source).kind, "provider_native");
      assert.equal(asRecord(queryReceived.data?.source).id, nativeManifest.provider_id);
      assert.ok(!("connector_id" in (queryReceived.data || {})));
      assert.ok(!("storage_connector_id" in (queryReceived.data || {})));

      const rejectedEvent = (trace.json.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === requestId
      );
      assert.ok(rejectedEvent, "trace show should include query.rejected for rejected native owner reads");
      assert.equal(rejectedEvent.data?.query_shape, "record_list");
      assert.equal(rejectedEvent.stream_id, "not_a_stream");
      assert.equal(asRecord(rejectedEvent.data?.source).kind, "provider_native");
      assert.equal(asRecord(rejectedEvent.data?.source).id, nativeManifest.provider_id);
      assert.ok(!("connector_id" in (rejectedEvent.data || {})));
      assert.ok(!("storage_connector_id" in (rejectedEvent.data || {})));
      assert.equal(asRecord(rejectedEvent.data?.error).code, "not_found");
      assert.match(String(asRecord(rejectedEvent.data?.error).message ?? ""), TOP_LEVEL_REGEX_134);
      assert.equal(trace.stderr, "");
    });
  });

  await t.test("owner get works without --connector-id against a native provider RS", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedNorthstar(nativeManifest);

      const result = await runCli(
        ["owner", "get", "pay_statements", "ps_2026_04_15", "--rs-url", rsUrl, "--format", "json"],
        { PDPP_OWNER_TOKEN: ownerToken }
      );
      assert.ok(result.json, "expected CLI --format json output to parse");

      assert.equal(result.json.id, "ps_2026_04_15");
      assert.equal(asRecord(result.json.data).employer, "Northstar HR");
      assert.ok(result.json.request_id?.startsWith("req_"));
      assert.ok(result.json.reference_trace_id?.startsWith("trc_qry_"));
      assert.equal(result.stderr, "");
    });
  });

  await t.test("owner export fails honestly without --connector-id against a polyfill RS", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "cli_owner");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const result = await runCliExpectFailure(["owner", "export", "top_artists", "--rs-url", rsUrl], {
        PDPP_OWNER_TOKEN: ownerToken,
      });

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, TOP_LEVEL_REGEX_135);
    });
  });
});

// Explicit coverage for the `pdpp ref` migration deprecation hint emitted
// by cli/index.js when legacy operator aliases are invoked. The
// per-call-site stderr assertions in this file scrub this warning via
// `scrubLegacyAliasWarning`; this test pins the warning behavior itself
// so a future change to the alias surface still trips a test rather than
// silently being masked.
test("legacy operator aliases emit a deprecation hint pointing at `pdpp ref ...`", async () => {
  await withHarness(async ({ asUrl }) => {
    // Use a bogus identifier so the handler returns quickly; we only
    // need to observe the stderr deprecation line, not a successful
    // round-trip.
    const { stderr } = await execFile(
      process.execPath,
      [CLI_PATH, "trace", "show", "trc_nope", "--as-url", asUrl, "--format", "json"],
      {
        cwd: REFERENCE_IMPL_DIR,
        env: {
          ...process.env,
          AS_URL: "",
          PDPP_AS_URL: "",
          PDPP_RS_URL: "",
          RS_URL: "",
        },
      }
    ).catch((error) => ({ stderr: error.stderr || "" }));
    assert.match(
      stderr,
      TOP_LEVEL_REGEX_2,
      "legacy `pdpp trace show` alias should emit a single deprecation hint on stderr"
    );
  });
});
