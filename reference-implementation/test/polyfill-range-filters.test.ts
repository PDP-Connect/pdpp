// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer as startServerUntyped } from "../server/index.ts";

const REGEXP_1 = /\.json$/;
const REGEXP_2 = /(^id$|_id$|text|subject|snippet|memo|description|name|email)/i;

// server/index.js is untyped JS (allowJs, checkJs:false). This suite only
// calls close/closeAllConnections/asPort/rsPort on the started server, and
// otherwise reads loosely-typed JSON Schema-shaped manifest fixtures off
// disk — `Schema`/`Stream`/`Manifest` intentionally model only the fields
// this suite reads or mutates, not the full protocol schema.
interface CloseableHandle {
  close: (cb: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

interface StartedServer {
  asPort: number;
  asServer: CloseableHandle;
  rsPort: number;
  rsServer: CloseableHandle;
}

async function startServer(opts: Record<string, unknown>): Promise<StartedServer> {
  const raw: Record<string, unknown> = await startServerUntyped(opts);
  return {
    asPort: raw.asPort as number,
    asServer: raw.asServer as CloseableHandle,
    rsPort: raw.rsPort as number,
    rsServer: raw.rsServer as CloseableHandle,
  };
}

interface Schema {
  format?: string;
  properties?: Record<string, Schema>;
  type?: string | string[];
  [key: string]: unknown;
}

interface AggregationsDecl {
  count?: boolean;
  group_by?: string[];
  max?: string[];
  min?: string[];
  sum?: string[];
  [key: string]: unknown;
}

interface Stream {
  name: string;
  query?: {
    range_filters?: Record<string, string[]>;
    aggregations?: AggregationsDecl;
    [key: string]: unknown;
  };
  schema?: Schema;
  [key: string]: unknown;
}

interface Manifest {
  connector_id: string;
  streams: Stream[];
  [key: string]: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const POLYFILL_MANIFEST_DIR = join(REPO_ROOT, "packages/polyfill-connectors/manifests");
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const SUPPORTED_RANGE_OPERATORS = new Set(["gte", "gt", "lte", "lt"]);
const AGGREGATION_DECLARED_CONNECTORS = ["ynab", "chase", "usaa", "gmail", "slack"];
const POLYFILL_MANIFEST_NAMES = readdirSync(POLYFILL_MANIFEST_DIR)
  .filter((fileName) => fileName.endsWith(".json"))
  .map((fileName) => fileName.replace(REGEXP_1, ""))
  .sort();

function readManifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFEST_DIR, `${name}.json`), "utf8"));
}

function hasQueryRangeFilters(manifest: Manifest): boolean {
  return manifest.streams.some((stream) => Object.keys(stream.query?.range_filters || {}).length > 0);
}

const RANGE_FILTERED_CONNECTORS = POLYFILL_MANIFEST_NAMES.filter((manifestName) =>
  hasQueryRangeFilters(readManifest(manifestName))
);

function nonNullSchemaTypes(schema: Schema | undefined): string[] {
  const raw = schema?.type;
  if (raw === null || raw === undefined) {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((type): type is string => typeof type === "string" && type !== "null");
}

function isOrderableRangeSchema(schema: Schema | undefined): boolean {
  const types = nonNullSchemaTypes(schema);
  if (types.length !== 1) {
    return false;
  }
  if (types[0] === "integer" || types[0] === "number") {
    return true;
  }
  return types[0] === "string" && (schema?.format === "date" || schema?.format === "date-time");
}

function isNumericAggregateSchema(schema: Schema | undefined): boolean {
  const types = nonNullSchemaTypes(schema);
  return types.length === 1 && (types[0] === "integer" || types[0] === "number");
}

function isMinMaxAggregateSchema(schema: Schema | undefined): boolean {
  return isOrderableRangeSchema(schema);
}

function isScalarAggregateGroupSchema(schema: Schema | undefined): boolean {
  const types = nonNullSchemaTypes(schema);
  return types.length === 1 && ["boolean", "integer", "number", "string"].includes(types[0] as string);
}

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
    new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
  ]);
}

interface FetchJsonResult {
  body: unknown;
  status: number;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<FetchJsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: rawDevice } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = rawDevice as { user_code: string; device_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: rawTokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return (rawTokenBody as { access_token: string }).access_token;
}

interface HarnessHandles {
  asUrl: string;
  rsUrl: string;
}

async function withHarness(fn: (handles: HarnessHandles) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  try {
    await fn({
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
    });
  } finally {
    await closeServer(server);
  }
}

function mustFindStream(manifest: Manifest, name: string): Stream {
  const stream = manifest.streams.find((s) => s.name === name);
  assert.ok(stream, `expected a ${name} stream on ${manifest.connector_id}`);
  return stream;
}

async function registerManifest(asUrl: string, manifest: Manifest): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const responseBody = await resp.text();
  assert.equal(resp.status, 201, `register ${manifest.connector_id}: ${responseBody}`);
}

interface SeedRecord {
  date?: string;
  emitted_at?: string;
  id: string;
  received_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

async function seedStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: SeedRecord[]
): Promise<void> {
  const lines = records
    .map((record) =>
      JSON.stringify({
        data: record,
        emitted_at:
          record.emitted_at || record.updated_at || record.received_at || record.date || new Date().toISOString(),
        key: record.id,
      })
    )
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: lines,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `ingest ${connectorId} ${stream}: ${await resp.text()}`);
}

const rangeQueryCases = [
  {
    expectedIds: ["gmail_hit", "gmail_new"],
    field: "received_at",
    manifestName: "gmail",
    records: [
      { id: "gmail_old", received_at: "2026-01-01T00:00:00Z", thread_id: "thread_1" },
      { id: "gmail_hit", received_at: "2026-02-01T00:00:00Z", thread_id: "thread_2" },
      { id: "gmail_new", received_at: "2026-03-01T00:00:00Z", thread_id: "thread_3" },
    ],
    stream: "messages",
    threshold: "2026-02-01T00:00:00Z",
  },
  {
    expectedIds: ["slack_hit", "slack_new"],
    field: "reply_count",
    manifestName: "slack",
    records: [
      { channel_id: "channel_1", id: "slack_old", reply_count: 0, sent_at: "2026-01-01T00:00:00Z", ts: "1.000" },
      { channel_id: "channel_1", id: "slack_hit", reply_count: 2, sent_at: "2026-01-02T00:00:00Z", ts: "2.000" },
      { channel_id: "channel_1", id: "slack_new", reply_count: 4, sent_at: "2026-01-03T00:00:00Z", ts: "3.000" },
    ],
    stream: "messages",
    threshold: "2",
  },
  {
    expectedIds: ["github_hit", "github_new"],
    field: "stargazers_count",
    manifestName: "github",
    records: [
      { full_name: "owner/old", id: "github_old", stargazers_count: 10 },
      { full_name: "owner/hit", id: "github_hit", stargazers_count: 100 },
      { full_name: "owner/new", id: "github_new", stargazers_count: 250 },
    ],
    stream: "repositories",
    threshold: "100",
  },
  {
    expectedIds: ["ynab_hit", "ynab_new"],
    field: "amount",
    manifestName: "ynab",
    records: [
      { account_id: "account_1", amount: 1200, budget_id: "budget_1", date: "2026-01-01", id: "ynab_old" },
      { account_id: "account_1", amount: 50_000, budget_id: "budget_1", date: "2026-01-02", id: "ynab_hit" },
      { account_id: "account_1", amount: 75_000, budget_id: "budget_1", date: "2026-01-03", id: "ynab_new" },
    ],
    stream: "transactions",
    threshold: "50000",
  },
  {
    expectedIds: ["chatgpt_hit", "chatgpt_new"],
    field: "create_time",
    manifestName: "chatgpt",
    records: [
      { create_time: "2026-01-01T00:00:00Z", id: "chatgpt_old" },
      { create_time: "2026-02-01T00:00:00Z", id: "chatgpt_hit" },
      { create_time: "2026-03-01T00:00:00Z", id: "chatgpt_new" },
    ],
    stream: "conversations",
    threshold: "2026-02-01T00:00:00Z",
  },
  {
    expectedIds: ["codex_hit", "codex_new"],
    field: "tokens_used",
    manifestName: "codex",
    records: [
      { id: "codex_old", tokens_used: 200 },
      { id: "codex_hit", tokens_used: 1000 },
      { id: "codex_new", tokens_used: 2500 },
    ],
    stream: "sessions",
    threshold: "1000",
  },
  {
    expectedIds: ["claude_hit", "claude_new"],
    field: "content_bytes",
    manifestName: "claude_code",
    records: [
      { content_bytes: 128, id: "claude_old", session_id: "session_1" },
      { content_bytes: 1000, id: "claude_hit", session_id: "session_1" },
      { content_bytes: 4096, id: "claude_new", session_id: "session_1" },
    ],
    stream: "attachments",
    threshold: "1000",
  },
  {
    expectedIds: ["chase_hit", "chase_new"],
    field: "amount",
    manifestName: "chase",
    records: [
      {
        account_id: "account_1",
        amount: 1200,
        currency: "USD",
        date: "2026-01-01",
        fitid: "fitid_old",
        id: "chase_old",
      },
      {
        account_id: "account_1",
        amount: 5000,
        currency: "USD",
        date: "2026-01-02",
        fitid: "fitid_hit",
        id: "chase_hit",
      },
      {
        account_id: "account_1",
        amount: 9000,
        currency: "USD",
        date: "2026-01-03",
        fitid: "fitid_new",
        id: "chase_new",
      },
    ],
    stream: "transactions",
    threshold: "5000",
  },
  {
    expectedIds: ["usaa_hit", "usaa_new"],
    field: "balance_after_cents",
    manifestName: "usaa",
    records: [
      {
        account_id: "account_1",
        amount: 100,
        balance_after_cents: 1200,
        currency: "USD",
        date: "2026-01-01",
        id: "usaa_old",
      },
      {
        account_id: "account_1",
        amount: 100,
        balance_after_cents: 50_000,
        currency: "USD",
        date: "2026-01-02",
        id: "usaa_hit",
      },
      {
        account_id: "account_1",
        amount: 100,
        balance_after_cents: 75_000,
        currency: "USD",
        date: "2026-01-03",
        id: "usaa_new",
      },
    ],
    stream: "transactions",
    threshold: "50000",
  },
  {
    expectedIds: ["amazon_hit", "amazon_new"],
    field: "order_total_cents",
    manifestName: "amazon",
    records: [
      { id: "amazon_old", order_date: "2026-01-01", order_total_cents: 1200 },
      { id: "amazon_hit", order_date: "2026-01-02", order_total_cents: 5000 },
      { id: "amazon_new", order_date: "2026-01-03", order_total_cents: 9000 },
    ],
    stream: "orders",
    threshold: "5000",
  },
  {
    expectedIds: ["reddit_hit", "reddit_new"],
    field: "score",
    manifestName: "reddit",
    records: [
      { created_utc: "2026-01-01T00:00:00Z", id: "reddit_old", score: 1 },
      { created_utc: "2026-01-02T00:00:00Z", id: "reddit_hit", score: 10 },
      { created_utc: "2026-01-03T00:00:00Z", id: "reddit_new", score: 25 },
    ],
    stream: "submitted",
    threshold: "10",
  },
];

test("first-party polyfill manifests declare only valid range filter fields", () => {
  for (const manifestName of RANGE_FILTERED_CONNECTORS) {
    const manifest = readManifest(manifestName);
    for (const stream of manifest.streams) {
      const rangeFilters = stream.query?.range_filters;
      if (!rangeFilters) {
        continue;
      }
      for (const [field, operators] of Object.entries(rangeFilters)) {
        const schema = stream.schema?.properties?.[field];
        assert.ok(schema, `${manifestName}.${stream.name}.${field} must exist in schema.properties`);
        assert.ok(
          isOrderableRangeSchema(schema),
          `${manifestName}.${stream.name}.${field} must be numeric, date, or date-time`
        );
        assert.ok(
          Array.isArray(operators) && operators.length > 0,
          `${manifestName}.${stream.name}.${field} operators must be non-empty`
        );
        assert.deepEqual(
          operators.filter((operator) => !SUPPORTED_RANGE_OPERATORS.has(operator)),
          [],
          `${manifestName}.${stream.name}.${field} must use supported operators`
        );
      }
    }
  }
});

test("first-party polyfill manifests with range filters register through the AS validator", async () => {
  await withHarness(async ({ asUrl }) => {
    for (const manifestName of RANGE_FILTERED_CONNECTORS) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await registerManifest(asUrl, readManifest(manifestName));
    }
  });
});

test("first-party polyfill manifests declare only conservative aggregation fields", () => {
  for (const manifestName of AGGREGATION_DECLARED_CONNECTORS) {
    const manifest = readManifest(manifestName);
    const declaredStreams = manifest.streams.filter((stream) => stream.query?.aggregations);
    assert.ok(declaredStreams.length > 0, `${manifestName} should declare at least one aggregation stream`);

    for (const stream of declaredStreams) {
      const aggregations = stream.query?.aggregations;
      assert.ok(aggregations, `${manifestName}.${stream.name} must declare aggregations`);
      assert.equal(aggregations.count, true, `${manifestName}.${stream.name} count must be declared explicitly`);
      for (const field of aggregations.sum || []) {
        const schema = stream.schema?.properties?.[field];
        assert.ok(schema, `${manifestName}.${stream.name}.sum.${field} must exist in schema.properties`);
        assert.ok(isNumericAggregateSchema(schema), `${manifestName}.${stream.name}.sum.${field} must be numeric`);
      }
      for (const metric of ["min", "max"] as const) {
        const fields: string[] = aggregations[metric] || [];
        for (const field of fields) {
          const schema = stream.schema?.properties?.[field];
          assert.ok(schema, `${manifestName}.${stream.name}.${metric}.${field} must exist in schema.properties`);
          assert.ok(
            isMinMaxAggregateSchema(schema),
            `${manifestName}.${stream.name}.${metric}.${field} must be numeric, date, or date-time`
          );
        }
      }
      for (const field of aggregations.group_by || []) {
        const schema = stream.schema?.properties?.[field];
        assert.ok(schema, `${manifestName}.${stream.name}.group_by.${field} must exist in schema.properties`);
        assert.ok(
          isScalarAggregateGroupSchema(schema),
          `${manifestName}.${stream.name}.group_by.${field} must be scalar`
        );
        assert.equal(
          REGEXP_2.test(field),
          false,
          `${manifestName}.${stream.name}.group_by.${field} should avoid identifiers and free text`
        );
      }
    }
  }
});

test("manifest validator rejects unsafe aggregation declarations", async () => {
  await withHarness(async ({ asUrl }) => {
    const unknownField = readManifest("ynab");
    const unknownFieldAggregations = mustFindStream(unknownField, "transactions").query?.aggregations;
    assert.ok(unknownFieldAggregations?.sum, "ynab transactions must declare aggregations.sum");
    unknownFieldAggregations.sum.push("not_a_field");
    const unknownResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(unknownField),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(unknownResp.status, 400);

    const nonNumericSum = readManifest("ynab");
    const nonNumericSumAggregations = mustFindStream(nonNumericSum, "transactions").query?.aggregations;
    assert.ok(nonNumericSumAggregations?.sum, "ynab transactions must declare aggregations.sum");
    nonNumericSumAggregations.sum.push("cleared");
    const nonNumericResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(nonNumericSum),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(nonNumericResp.status, 400);

    const nonScalarGroup = readManifest("gmail");
    const nonScalarGroupAggregations = mustFindStream(nonScalarGroup, "messages").query?.aggregations;
    assert.ok(nonScalarGroupAggregations?.group_by, "gmail messages must declare aggregations.group_by");
    nonScalarGroupAggregations.group_by.push("labels");
    const nonScalarResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(nonScalarGroup),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(nonScalarResp.status, 400);
  });
});

test("first-party polyfill manifests with aggregation declarations register through the AS validator", async () => {
  await withHarness(async ({ asUrl }) => {
    for (const manifestName of AGGREGATION_DECLARED_CONNECTORS) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await registerManifest(asUrl, readManifest(manifestName));
    }
  });
});

test("first-party polyfill range filters execute against synthetic records", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    for (const manifestName of RANGE_FILTERED_CONNECTORS) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await registerManifest(asUrl, readManifest(manifestName));
    }
    const ownerToken = await issueOwnerToken(asUrl, "polyfill_range_owner");
    for (const queryCase of rangeQueryCases) {
      const manifest = readManifest(queryCase.manifestName);
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await seedStream(rsUrl, ownerToken, manifest.connector_id, queryCase.stream, queryCase.records);
      const url =
        `${rsUrl}/v1/streams/${encodeURIComponent(queryCase.stream)}/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        `&filter[${encodeURIComponent(queryCase.field)}][gte]=${encodeURIComponent(queryCase.threshold)}`;
      const { status, body } = await fetchJson(url, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200, `${queryCase.manifestName}.${queryCase.stream}.${queryCase.field}`);
      const { data } = body as { data: { id: string }[] };
      assert.deepEqual(
        // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
        data.map((record) => record.id).sort(),
        queryCase.expectedIds,
        `${queryCase.manifestName}.${queryCase.stream}.${queryCase.field} should filter synthetics`
      );
    }
  });
});
