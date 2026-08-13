// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  approveGrant,
  denyGrant,
  getGrantPackageIdForGrant,
  listGrantPackagesForOwner,
  parsePendingConsentRequestUri,
  revokeGrantPackage,
} from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const REGEXP_1 = /Confirm each source/;
const REGEXP_2 = /Reference-experimental batch consent/;
const REGEXP_3 = /name="approved_source_indexes"/;
const REGEXP_4 = /Per-source confirmation required/;
const REGEXP_5 = /I confirm allowing all/;
const REGEXP_6 = /Approve-all is not available/;
const REGEXP_7 = /sensitive_no_time_bound/;
const REGEXP_8 = /three_or_more_sensitive_sources/;
const REGEXP_9 = /requires (?:a re-asserting )?confirmation/;
const REGEXP_10 = /out-of-range/;
const REGEXP_11 = /Broad setup/;
const REGEXP_12 = /reference warning threshold/;
const REGEXP_13 = /Over the soft cap/;
const REGEXP_14 = /Over the soft cap/;
const REGEXP_15 = /above the reference soft cap of 8/;
const REGEXP_16 = /reddit/;
const REGEXP_17 = /one access mode to every source/;
const REGEXP_18 = /continuous, single_use/;
const REGEXP_19 = /widening is forbidden/;
const REGEXP_20 = /not in the staged field set/;
const REGEXP_21 = /earlier than the staged bound/;
const REGEXP_22 = /not a valid ISO-8601 instant/;
const REGEXP_24 = /not in the approved set/;
const REGEXP_25 = /Narrow this source/;
const REGEXP_26 = /name="narrow_streams_0"/;
const REGEXP_27 = /name="narrow_fields_0__/;
const REGEXP_28 = /name="narrow_since_0__/;
const REGEXP_29 = /Client-authored claims/;
const CONSENT_EXCHANGE_CODE_RE = /cex_[0-9a-f]{64}/;
const LEGACY_PROJECTION_REVISION_RE = /^reference\.legacy-connector-projection\.v1:sha256:[0-9a-f]{64}$/;
const PACKAGE_ID_RE = /gpkg_[a-zA-Z0-9]+/;
const SPOTIFY_BATCH_COMMITMENT = "Only use Spotify listening history for playlist suggestions.";
const REDDIT_BATCH_COMMITMENT = "Only use Reddit posts for community summaries.";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

function countRows(sql: string): number {
  const row = getDb().prepare(sql).get<{ n: number }>();
  assert.ok(row, `count query returns a row: ${sql}`);
  return row.n;
}

function countConsentEvents(deviceCode: string, eventType: string): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM spine_events WHERE object_id = ? AND object_type = 'pending_consent' AND event_type = ?"
      )
      .get(deviceCode, eventType) as { count: number }
  ).count;
}

function createDecisionPause(): { hook: () => Promise<void>; paused: Promise<void>; release: () => void } {
  let markPaused: () => void = () => undefined;
  let release: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hook: async () => {
      markPaused();
      await resumed;
    },
    paused,
    release,
  };
}

function requirePackageId(body: GateResponseBody): string {
  assert.ok(typeof body.package_id === "string", "approval response includes package_id");
  return body.package_id;
}

async function closeServer(server: TestServer) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

interface ConnectorManifest {
  connector_id: string;
  sensitivity?: string;
  [key: string]: unknown;
}

function loadManifest(name: string): ConnectorManifest {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${name}.json`), "utf8")) as ConnectorManifest;
}

interface HarnessContext {
  asUrl: string;
  github: ConnectorManifest;
  reddit: ConnectorManifest;
  spotify: ConnectorManifest;
}

async function withHarness(fn: (ctx: HarnessContext) => Promise<void>) {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const spotify = loadManifest("spotify");
  const reddit = loadManifest("reddit");
  const github = loadManifest("github");
  try {
    for (const manifest of [spotify, reddit, github]) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      const resp = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.ok(resp.status < 400, `connector registration for ${manifest.connector_id} should succeed`);
      const connectorId = new URL(manifest.connector_id).pathname.split("/").filter(Boolean).at(-1);
      assert.ok(connectorId);
      const now = new Date().toISOString();
      await createSqliteConnectorInstanceStore().upsert({
        connectorId,
        connectorInstanceId: `cin_batch_${connectorId}`,
        createdAt: now,
        displayName: `${connectorId} batch fixture`,
        ownerSubjectId: "owner_local",
        sourceBinding: { fixture: connectorId },
        sourceBindingKey: `batch:${connectorId}`,
        sourceKind: "manual",
        status: "active",
        updatedAt: now,
      });
    }
    await fn({ asUrl, github, reddit, spotify });
  } finally {
    await closeServer(server);
  }
}

async function registerManifest(asUrl: string, manifest: ConnectorManifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.ok(resp.status < 400, `connector registration for ${manifest.connector_id} should succeed`);
}

interface AuthorizationDetailSource {
  id: string;
  kind: string;
}

interface AuthorizationDetailStream {
  fields?: string[];
  name: string;
  time_range?: { since: string };
}

function detail(
  source: AuthorizationDetailSource,
  streams: AuthorizationDetailStream[],
  overrides: Record<string, unknown> = {}
) {
  return {
    access_mode: "continuous",
    purpose_code: "https://pdpp.dev/purpose/personalization",
    source,
    streams,
    type: "https://pdpp.dev/data-access",
    ...overrides,
  };
}

interface GateResponseBody {
  error?: { code?: string; message?: string };
  grant?: {
    package?: boolean;
    grant_id?: string;
    child_grants?: { grant_id: string; source: { id: string } }[];
  };
  package_id?: string;
  request_uri?: string;
  token?: string;
}

interface GateResult {
  body: GateResponseBody | null;
  status: number;
}

async function par(asUrl: string, authorizationDetails: unknown[]): Promise<GateResult> {
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: authorizationDetails,
      client_display: { name: "Longview" },
      client_id: "longview",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return { body: (await resp.json().catch(() => null)) as GateResponseBody | null, status: resp.status };
}

async function consentPage(asUrl: string, requestUri: string): Promise<{ status: number; html: string }> {
  const resp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
  return { html: await resp.text(), status: resp.status };
}

function sourceCardHtml(html: string, sourceIndex: number): string {
  const start = html.indexOf(`aria-label="Source ${sourceIndex}"`);
  assert.notEqual(start, -1, `expected source ${sourceIndex} card`);
  const next = html.indexOf(`aria-label="Source ${sourceIndex + 1}"`, start + 1);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

async function approve(
  asUrl: string,
  requestBody: Record<string, unknown>,
  options: { confirmReviewedDecision?: boolean } = {}
): Promise<GateResult> {
  // The review artifact owns the complete batch decision. The final approval
  // only re-asserts that artifact by revision; source choices must not be
  // accepted again at the approval boundary.
  const reviewBody = { ...requestBody };
  if (
    reviewBody.approved_source_indexes === undefined &&
    reviewBody.source_narrowing === undefined &&
    reviewBody.confirm_approve_all === undefined
  ) {
    reviewBody.confirm_approve_all = true;
  }
  const reviewResp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify(reviewBody),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const reviewResult = {
    body: (await reviewResp.json().catch(() => null)) as GateResponseBody | null,
    status: reviewResp.status,
  };
  if (reviewResp.status !== 200) {
    return reviewResult;
  }
  const reviewedBody = reviewResult.body as GateResponseBody & {
    approval_review?: unknown;
    approval_review_revision?: unknown;
  };
  assert.ok(reviewedBody.approval_review && typeof reviewedBody.approval_review === "object");
  assert.equal(typeof reviewedBody.approval_review_revision, "string");
  const finalBody: Record<string, unknown> = {
    approval_review_revision: reviewedBody.approval_review_revision,
    request_uri: requestBody.request_uri,
  };
  if (options.confirmReviewedDecision !== false) {
    finalBody.confirm_reviewed_decision = "1";
  }
  const resp = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify(finalBody),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  return { body: (await resp.json().catch(() => null)) as GateResponseBody | null, status: resp.status };
}

async function approveForm(asUrl: string, fields: Record<string, unknown>): Promise<GateResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      params.append(key, String(item));
    }
  }
  if (!(params.has("approved_source_indexes") || params.has("source_narrowing") || params.has("confirm_approve_all"))) {
    params.set("confirm_approve_all", "1");
  }
  const reviewResp = await fetch(`${asUrl}/consent/review`, {
    body: params.toString(),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const reviewResult = {
    body: (await reviewResp.json().catch(() => null)) as GateResponseBody | null,
    status: reviewResp.status,
  };
  if (reviewResp.status !== 200) {
    return reviewResult;
  }
  const reviewedBody = reviewResult.body as GateResponseBody & {
    approval_review?: unknown;
    approval_review_revision?: unknown;
  };
  assert.ok(reviewedBody.approval_review && typeof reviewedBody.approval_review === "object");
  assert.equal(typeof reviewedBody.approval_review_revision, "string");
  const finalParams = new URLSearchParams({
    approval_review_revision: reviewedBody.approval_review_revision as string,
    confirm_reviewed_decision: "1",
    request_uri: String(fields.request_uri ?? ""),
  });
  const resp = await fetch(`${asUrl}/consent/approve`, {
    body: finalParams.toString(),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return { body: (await resp.json().catch(() => null)) as GateResponseBody | null, status: resp.status };
}

async function approveBatchHtml(asUrl: string, requestUri: string, approvedSourceIndexes: number[]): Promise<Response> {
  const review = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({
      approved_source_indexes: approvedSourceIndexes,
      request_uri: requestUri,
      subject_id: "owner_local",
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(review.status, 200, await review.clone().text());
  const reviewed = (await review.json()) as { approval_review_revision?: unknown };
  assert.equal(typeof reviewed.approval_review_revision, "string");
  return fetch(`${asUrl}/consent/approve`, {
    body: new URLSearchParams({
      approval_review_revision: reviewed.approval_review_revision as string,
      confirm_reviewed_decision: "1",
      request_uri: requestUri,
    }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

/** Narrows a `{status, body}` result's body from `T | null` to `T`, failing the assertion if null. */
function unwrapBody<T>(result: { status: number; body: T | null }): T {
  assert.ok(result.body, `expected a response body (status ${result.status})`);
  return result.body;
}

interface IssuedGrant {
  child_grants: { grant_id: string; source: { id: string } }[];
  grant_id?: string;
  package?: boolean;
}

/** Narrows an approve()/approveForm() result's body.grant.child_grants chain in one assertion. */
function issuedGrant(result: GateResult): IssuedGrant {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const grant = unwrapBody(result).grant;
  assert.ok(grant?.child_grants, `expected a grant with child_grants (status ${result.status})`);
  return grant as IssuedGrant;
}

test("batch consent terminal decision is exclusive across approval and denial", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );
    const code = parsePendingConsentRequestUri(body.request_uri);
    assert.ok(code);
    const review = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({
        approved_source_indexes: [0, 1],
        request_uri: body.request_uri,
        subject_id: "owner_local",
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(review.status, 200);
    const revision = ((await review.json()) as { approval_review_revision: string }).approval_review_revision;
    const pause = createDecisionPause();
    const denial = denyGrant(code, { beforeCasHook: pause.hook });
    await pause.paused;
    const approval = await approveGrant(code, "owner_local", { approval_review_revision: revision });
    pause.release();
    await assert.rejects(
      denial,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "approval_conflict"
    );
    assert.equal(typeof approval.token, "string");
    assert.equal(countConsentEvents(code, "consent.denied"), 0);
    assert.equal(countRows("SELECT COUNT(*) AS n FROM grant_packages"), 1);

    const body2 = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );
    const code2 = parsePendingConsentRequestUri(body2.request_uri);
    assert.ok(code2);
    const review2 = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({
        approved_source_indexes: [0, 1],
        request_uri: body2.request_uri,
        subject_id: "owner_local",
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const revision2 = ((await review2.json()) as { approval_review_revision: string }).approval_review_revision;
    assert.equal(await denyGrant(code2), true);
    await assert.rejects(
      approveGrant(code2, "owner_local", { approval_review_revision: revision2 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "approval_conflict"
    );
    assert.equal(countConsentEvents(code2, "consent.denied"), 1);
    assert.equal(countRows("SELECT COUNT(*) AS n FROM grant_packages"), 1);
  });
});

test("batch consent gate: page defaults to per-source confirmation and suppresses approve-all for continuous all-streams", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const parResult = await par(asUrl, [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "*" }]),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
    ]);
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const status = parResult.status;
    const body = unwrapBody(parResult);
    assert.equal(status, 201);
    assert.ok(body.request_uri);

    const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(body.request_uri)}`);
    assert.equal(consentResp.status, 200);
    const html = await consentResp.text();
    assert.match(html, REGEXP_2);
    assert.match(html, REGEXP_1);
    assert.match(html, REGEXP_3);
    assert.match(html, REGEXP_4);
    assert.doesNotMatch(html, REGEXP_5);
  });
});

test("batch consent gate: top-level client_claims render under the matching source cards", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }], {
          client_claims: { commitments: [SPOTIFY_BATCH_COMMITMENT] },
        }),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }], {
          client_claims: { commitments: [REDDIT_BATCH_COMMITMENT] },
        }),
      ])
    );

    assert.ok(body.request_uri);
    const { status, html } = await consentPage(asUrl, body.request_uri);
    assert.equal(status, 200);
    const spotifyCard = sourceCardHtml(html, 1);
    const redditCard = sourceCardHtml(html, 2);
    assert.match(spotifyCard, REGEXP_29);
    assert.match(redditCard, REGEXP_29);
    assert.ok(spotifyCard.includes(SPOTIFY_BATCH_COMMITMENT));
    assert.ok(!spotifyCard.includes(REDDIT_BATCH_COMMITMENT));
    assert.ok(redditCard.includes(REDDIT_BATCH_COMMITMENT));
    assert.ok(!redditCard.includes(SPOTIFY_BATCH_COMMITMENT));
  });
});

test("batch consent gate: suppressed approve-all cannot silently approve every source", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "*" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const denied = await approve(asUrl, { request_uri: body.request_uri, subject_id: "owner_local" });
    assert.equal(denied.status, 400);
    assert.equal(unwrapBody(denied).error?.code, "invalid_request");
    assert.match(unwrapBody(denied).error?.message ?? "", REGEXP_6);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
    assert.equal(countRows("SELECT COUNT(*) AS n FROM grant_packages"), 0);
  });
});

test("batch consent gate: sensitive source with no time bound suppresses approve-all", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    await registerManifest(asUrl, { ...spotify, sensitivity: "sensitive" });
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }], {
          access_mode: "single_use",
        }),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }], { access_mode: "single_use" }),
      ])
    );

    const denied = await approve(asUrl, { request_uri: body.request_uri, subject_id: "owner_local" });
    assert.equal(denied.status, 400);
    assert.match(unwrapBody(denied).error?.message ?? "", REGEXP_7);
  });
});

test("batch consent gate: three sensitive sources suppress approve-all", async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    for (const manifest of [spotify, reddit, github]) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await registerManifest(asUrl, { ...manifest, sensitivity: "sensitive" });
    }
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }], {
          access_mode: "single_use",
        }),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }], { access_mode: "single_use" }),
        detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }], {
          access_mode: "single_use",
        }),
      ])
    );

    const denied = await approve(asUrl, { request_uri: body.request_uri, subject_id: "owner_local" });
    assert.equal(denied.status, 400);
    assert.match(unwrapBody(denied).error?.message ?? "", REGEXP_8);
  });
});

test("batch consent gate: explicit per-source indexes issue only the selected child grants", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "*" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const approved = await approve(asUrl, {
      approved_source_indexes: [1],
      request_uri: body.request_uri,
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);
    assert.ok(unwrapBody(approved).package_id?.startsWith("gpkg_"));
    assert.equal(issuedGrant(approved).child_grants.length, 1);
    const [firstChild] = issuedGrant(approved).child_grants;
    assert.ok(firstChild);
    assert.equal(firstChild.source.id, reddit.connector_id);

    const db = getDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grant_package_members").get() as { n: number }).n, 1);
  });
});

test("batch consent gate: approved sources become independent child grants under one package", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const approved = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);
    assert.ok(unwrapBody(approved).package_id?.startsWith("gpkg_"));
    assert.equal(issuedGrant(approved).package, true);
    assert.equal(issuedGrant(approved).child_grants.length, 2);
    assert.deepEqual(
      // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
      issuedGrant(approved)
        .child_grants.map((child) => child.source.id)
        .sort(),
      [reddit.connector_id, spotify.connector_id]
    );

    const db = getDb();
    const pkg = db
      .prepare("SELECT package_id, status FROM grant_packages WHERE package_id = ?")
      .get(unwrapBody(approved).package_id) as { package_id: string; status: string };
    assert.equal(pkg.status, "active");
    const members = db
      .prepare("SELECT grant_id, token_id FROM grant_package_members WHERE package_id = ?")
      .all(unwrapBody(approved).package_id) as { grant_id: string; token_id: string }[];
    assert.equal(members.length, 2);
    assert.equal(new Set(members.map((member) => member.grant_id)).size, 2);
    assert.equal(new Set(members.map((member) => member.token_id)).size, 2);
    assert.ok(!members.some((member) => member.token_id === unwrapBody(approved).token));

    const owned = (await listGrantPackagesForOwner({ limit: 50 })) as {
      data: { package_id: string; member_count: number }[];
    };
    const listed = owned.data.find((entry) => entry.package_id === unwrapBody(approved).package_id);
    assert.equal(listed?.member_count, 2);
    for (const member of members) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      assert.equal(await getGrantPackageIdForGrant(member.grant_id), unwrapBody(approved).package_id);
    }
  });
});

test("batch consent gate: HTML approval hands off the package token durably", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const staged = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );
    const approval = await approveBatchHtml(asUrl, staged.request_uri || "", [0, 1]);
    assert.equal(approval.status, 200);
    const code = (await approval.text()).match(CONSENT_EXCHANGE_CODE_RE)?.[0];
    assert.ok(code);
    const exchange = await fetch(`${asUrl}/consent/exchange`, {
      body: JSON.stringify({ code }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(exchange.status, 200);
    const result = (await exchange.json()) as {
      grant: { child_grants?: unknown[]; package?: boolean };
      package_id?: string;
      token?: string;
    };
    assert.ok(result.package_id?.startsWith("gpkg_"));
    assert.equal(result.grant.package, true);
    assert.equal(result.grant.child_grants?.length, 2);
    assert.ok(result.token);
  });
});

test("batch consent gate: a revoked package is not delivered by a stored exchange code", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const staged = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );
    const approval = await approveBatchHtml(asUrl, staged.request_uri || "", [0, 1]);
    const html = await approval.text();
    const code = html.match(CONSENT_EXCHANGE_CODE_RE)?.[0];
    const packageId = html.match(PACKAGE_ID_RE)?.[0];
    assert.ok(code);
    assert.ok(packageId);
    await revokeGrantPackage(packageId);
    const exchange = await fetch(`${asUrl}/consent/exchange`, {
      body: JSON.stringify({ code }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(exchange.status, 404);
    assert.equal((await exchange.text()).includes("tok_"), false);
  });
});

test("batch consent gate: low-risk approve-all requires re-asserting confirmation", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const entries = [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }], { access_mode: "single_use" }),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }], { access_mode: "single_use" }),
    ];
    const first = await par(asUrl, entries);

    const missingConfirmation = await approve(
      asUrl,
      {
        request_uri: unwrapBody(first).request_uri,
        subject_id: "owner_local",
      },
      { confirmReviewedDecision: false }
    );
    assert.equal(missingConfirmation.status, 400);
    assert.match(unwrapBody(missingConfirmation).error?.message ?? "", REGEXP_9);

    const second = await par(asUrl, entries);
    const approved = await approve(asUrl, {
      confirm_approve_all: true,
      request_uri: unwrapBody(second).request_uri,
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);
    assert.equal(issuedGrant(approved).child_grants.length, 2);
  });
});

test("batch consent gate: invalid approval indexes reject before issuing a package", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const rejected = await approve(asUrl, {
      approved_source_indexes: [2],
      request_uri: body.request_uri,
      subject_id: "owner_local",
    });
    assert.equal(rejected.status, 400);
    assert.match(unwrapBody(rejected).error?.message ?? "", REGEXP_10);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
    assert.equal(countRows("SELECT COUNT(*) AS n FROM grant_packages"), 0);
  });
});

test("batch consent gate: staged batch remains source-bounded in storage", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const parResult = await par(asUrl, [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
    ]);
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const status = parResult.status;
    const body = unwrapBody(parResult);
    assert.equal(status, 201);

    assert.ok(body.request_uri);
    const deviceCode = parsePendingConsentRequestUri(body.request_uri);
    const row = getDb().prepare("SELECT params_json FROM pending_consents WHERE device_code = ?").get(deviceCode) as {
      params_json: string;
    };
    const stored = JSON.parse(row.params_json) as {
      request_kind: string;
      entries: {
        source_binding: { id: string };
        source_declaration_snapshot: {
          declaration: {
            declaration_version: string;
            extensions?: Record<string, { connector?: { id?: string; version?: string } }>;
            publisher: { id: string };
            source: { id: string; kind: string };
            streams: { name: string }[];
          };
          declaration_version: string;
          snapshot_version: string;
          source: { id: string; kind: string };
        };
      }[];
    };
    assert.equal(stored.request_kind, "pdpp_selection_request_batch");
    assert.deepEqual(
      stored.entries.map((entry) => entry.source_binding.id),
      [spotify.connector_id, reddit.connector_id]
    );
    const [spotifySnapshot, redditSnapshot] = stored.entries.map((entry) => entry.source_declaration_snapshot);
    assert.ok(spotifySnapshot);
    assert.ok(redditSnapshot);
    for (const snapshot of [spotifySnapshot, redditSnapshot]) {
      assert.match(snapshot.declaration_version, LEGACY_PROJECTION_REVISION_RE);
      assert.equal(snapshot.snapshot_version, "reference.source-declaration-snapshot.v1");
      assert.equal(snapshot.declaration.declaration_version, snapshot.declaration_version);
    }
    assert.deepEqual(spotifySnapshot.source, { id: spotify.connector_id, kind: "connector" });
    assert.deepEqual(redditSnapshot.source, { id: reddit.connector_id, kind: "connector" });
    const [firstStoredEntry] = stored.entries;
    assert.ok(firstStoredEntry);
    assert.deepEqual(firstStoredEntry.source_declaration_snapshot.declaration.source, {
      id: spotify.connector_id,
      kind: "connector",
    });
    assert.deepEqual(firstStoredEntry.source_declaration_snapshot.declaration.publisher, {
      id: "https://pdpp.dev/reference-implementation",
    });
    assert.equal(
      firstStoredEntry.source_declaration_snapshot.declaration.declaration_version,
      firstStoredEntry.source_declaration_snapshot.declaration_version
    );
    assert.equal("connector_id" in firstStoredEntry.source_declaration_snapshot.declaration, false);
    assert.equal("version" in firstStoredEntry.source_declaration_snapshot.declaration, false);
    const collectionExtension =
      firstStoredEntry.source_declaration_snapshot.declaration.extensions?.["https://pdpp.org/profile/collection"];
    assert.ok(collectionExtension);
    assert.deepEqual(collectionExtension.connector, { id: spotify.manifest_uri, version: spotify.version });
    assert.equal(firstStoredEntry.source_declaration_snapshot.declaration.streams[0]?.name, "top_artists");
  });
});

test("batch consent gate: a request at the warning threshold surfaces the broad-setup warning", async () => {
  await withHarness(async ({ asUrl, spotify }) => {
    // Soft cap is 8, warning threshold is 6. Six entries warns but does not exceed the cap.
    const entries = Array.from({ length: 6 }, () =>
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }])
    );
    const parResult = await par(asUrl, entries);
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const status = parResult.status;
    const body = unwrapBody(parResult);
    assert.equal(status, 201);
    assert.ok(body.request_uri);

    const { status: pageStatus, html } = await consentPage(asUrl, body.request_uri);
    assert.equal(pageStatus, 200);
    assert.match(html, REGEXP_11);
    assert.match(html, REGEXP_12);
    // At the warning threshold but not over the cap: no over-cap flag.
    assert.doesNotMatch(html, REGEXP_13);
  });
});

test("batch consent gate: over-soft-cap requests are flagged with affected sources, never silently dropped", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Nine entries exceeds the soft cap of 8. The first eight are spotify; the
    // ninth is reddit — the over-cap source that must be named.
    const entries = [
      ...Array.from({ length: 8 }, () =>
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }])
      ),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
    ];
    const parResult = await par(asUrl, entries);
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const status = parResult.status;
    const body = unwrapBody(parResult);
    // Soft cap is not a hard cap: the request is accepted, not rejected.
    assert.equal(status, 201);
    assert.ok(body.request_uri);

    // All nine sources are persisted — nothing is silently truncated.
    const deviceCode = parsePendingConsentRequestUri(body.request_uri);
    const row = getDb().prepare("SELECT params_json FROM pending_consents WHERE device_code = ?").get(deviceCode) as {
      params_json: string;
    };
    const stored = JSON.parse(row.params_json) as {
      entries: unknown[];
      over_soft_cap: boolean;
      over_cap_sources: { id: string }[];
    };
    assert.equal(stored.entries.length, 9);
    assert.equal(stored.over_soft_cap, true);
    assert.deepEqual(
      stored.over_cap_sources.map((source) => source.id),
      [reddit.connector_id]
    );

    // The ceremony flags the over-cap condition and names the affected source.
    const { status: pageStatus, html } = await consentPage(asUrl, body.request_uri);
    assert.equal(pageStatus, 200);
    assert.match(html, REGEXP_14);
    assert.match(html, REGEXP_15);
    assert.match(html, REGEXP_16);
  });
});

test("batch consent gate: a package mixing access modes across approved sources is rejected, not issued", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Two approved sources declaring different access modes. A package applies one
    // access mode to every child grant in this tranche, so the mix must be rejected
    // before any package or child grant is issued — not silently collapsed.
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }], {
          access_mode: "continuous",
        }),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }], { access_mode: "single_use" }),
      ])
    );

    const denied = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      subject_id: "owner_local",
    });
    assert.equal(denied.status, 400);
    assert.equal(unwrapBody(denied).error?.code, "invalid_request");
    assert.match(unwrapBody(denied).error?.message ?? "", REGEXP_17);
    assert.match(unwrapBody(denied).error?.message ?? "", REGEXP_18);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
    assert.equal(countRows("SELECT COUNT(*) AS n FROM grant_packages"), 0);
    assert.equal(countRows("SELECT COUNT(*) AS n FROM grant_package_members"), 0);
  });
});

interface StoredGrant {
  source?: { id: string };
  streams: {
    name: string;
    fields?: string[];
    instance_ids?: string[];
    time_constraint?: { field: string; since?: string };
    time_range?: { since: string };
  }[];
}

function childGrantStreams(
  db: ReturnType<typeof getDb>,
  packageId: string | undefined,
  sourceId: string
): StoredGrant["streams"] | null {
  const rows = (
    db
      .prepare(
        `SELECT g.grant_json
           FROM grant_package_members m
           JOIN grants g ON g.grant_id = m.grant_id
          WHERE m.package_id = ?`
      )
      .all(packageId) as { grant_json: string }[]
  ).map((row) => JSON.parse(row.grant_json) as StoredGrant);
  const grant = rows.find((g) => g.source?.id === sourceId);
  return grant ? grant.streams : null;
}

test("batch consent narrowing: owner defers a source by approving a subset", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    // Approve only spotify (index 0); defer reddit (index 1).
    const approved = await approve(asUrl, {
      approved_source_indexes: [0],
      request_uri: body.request_uri,
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);
    assert.equal(issuedGrant(approved).child_grants.length, 1);
    const [onlySpotifyChild] = issuedGrant(approved).child_grants;
    assert.ok(onlySpotifyChild);
    assert.equal(onlySpotifyChild.source.id, spotify.connector_id);

    const db = getDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, 1);
    // No reddit grant issued from this ceremony.
    assert.equal(childGrantStreams(db, requirePackageId(unwrapBody(approved)), reddit.connector_id), null);
  });
});

test("batch consent narrowing: HTML form defers a source even when nested controls submit", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const approved = await approveForm(asUrl, {
      approved_source_indexes: "0",
      // The rendered form keeps nested stream checkboxes checked even when the
      // owner unchecks the parent source. The flat form parser must ignore the
      // deferred source's narrowing controls so ordinary defer does not fail.
      narrow_streams_0: "top_artists",
      narrow_streams_1: "posts",
      request_uri: body.request_uri,
      subject_id: "owner_local",
    });

    assert.equal(approved.status, 200);
    assert.equal(issuedGrant(approved).child_grants.length, 1);
    const [formSpotifyChild] = issuedGrant(approved).child_grants;
    assert.ok(formSpotifyChild);
    assert.equal(formSpotifyChild.source.id, spotify.connector_id);

    const db = getDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, 1);
    assert.equal(childGrantStreams(db, requirePackageId(unwrapBody(approved)), reddit.connector_id), null);
  });
});

test("batch consent narrowing: owner reduces a wildcard source to a single stream", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // spotify staged as wildcard (all streams); reddit as posts.
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "*" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const approved = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      source_narrowing: { 0: { streams: ["top_artists"] } },
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);

    const db = getDb();
    const spotifyStreams = childGrantStreams(db, requirePackageId(unwrapBody(approved)), spotify.connector_id);
    assert.ok(spotifyStreams);
    assert.deepEqual(
      spotifyStreams.map((s) => s.name),
      ["top_artists"]
    );
    // reddit untouched.
    const redditStreams = childGrantStreams(db, requirePackageId(unwrapBody(approved)), reddit.connector_id);
    assert.ok(redditStreams);
    assert.deepEqual(
      redditStreams.map((s) => s.name),
      ["posts"]
    );
  });
});

// Narrowing only engages on the batch path (authorization_details.length > 1),
// so every narrowing test stages at least two source-bounded entries and
// targets narrowing at the spotify entry (index 0). reddit (index 1) is the
// second staged source.

test("batch consent narrowing: owner reduces a stream to a subset of staged fields", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [
          { fields: ["id", "name", "genres", "popularity"], name: "top_artists" },
        ]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const approved = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      source_narrowing: { 0: { fields: { top_artists: ["id", "name"] } } },
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);

    const db = getDb();
    const streams = childGrantStreams(db, requirePackageId(unwrapBody(approved)), spotify.connector_id);
    assert.ok(streams);
    assert.equal(streams.length, 1);
    const [fieldNarrowedStream] = streams;
    assert.ok(fieldNarrowedStream);
    assert.deepEqual(fieldNarrowedStream.fields, ["id", "name"]);
  });
});

test("batch consent narrowing: owner tightens an existing time bound", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [
          { name: "top_artists", time_range: { since: "2026-01-01T00:00:00Z" } },
        ]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const approved = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      source_narrowing: { 0: { since: { top_artists: "2026-03-01T00:00:00Z" } } },
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);

    const db = getDb();
    const streams = childGrantStreams(db, requirePackageId(unwrapBody(approved)), spotify.connector_id);
    assert.ok(streams);
    const [timeBoundStream] = streams;
    assert.ok(timeBoundStream?.time_constraint);
    assert.equal(timeBoundStream.time_constraint.field, "source_updated_at");
    assert.equal(timeBoundStream.time_constraint.since, "2026-03-01T00:00:00Z");
  });
});

test("batch consent narrowing: widening streams beyond the staged set is rejected", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Stage only top_artists for spotify; try to "narrow" to a stream that was
    // not staged.
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const rejected = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      source_narrowing: { 0: { streams: ["top_artists", "saved_tracks"] } },
      subject_id: "owner_local",
    });
    assert.equal(rejected.status, 400);
    assert.equal(unwrapBody(rejected).error?.code, "invalid_request");
    assert.match(unwrapBody(rejected).error?.message ?? "", REGEXP_19);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
    assert.equal(countRows("SELECT COUNT(*) AS n FROM grant_packages"), 0);
  });
});

test("batch consent narrowing: widening fields beyond the staged set is rejected", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ fields: ["id", "name"], name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const rejected = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      // 'genres' is a real manifest field but was NOT in the staged field set.
      source_narrowing: { 0: { fields: { top_artists: ["id", "genres"] } } },
      subject_id: "owner_local",
    });
    assert.equal(rejected.status, 400);
    assert.match(unwrapBody(rejected).error?.message ?? "", REGEXP_20);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
  });
});

test("batch consent narrowing: a since bound earlier than the staged bound is rejected", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [
          { name: "top_artists", time_range: { since: "2026-03-01T00:00:00Z" } },
        ]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const rejected = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      source_narrowing: { 0: { since: { top_artists: "2026-01-01T00:00:00Z" } } },
      subject_id: "owner_local",
    });
    assert.equal(rejected.status, 400);
    assert.match(unwrapBody(rejected).error?.message ?? "", REGEXP_21);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
  });
});

test("batch consent narrowing: a malformed since value is rejected before issuing", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [
          { name: "top_artists", time_range: { since: "2026-01-01T00:00:00Z" } },
        ]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const rejected = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      source_narrowing: { 0: { since: { top_artists: "not-a-date" } } },
      subject_id: "owner_local",
    });
    assert.equal(rejected.status, 400);
    assert.match(unwrapBody(rejected).error?.message ?? "", REGEXP_22);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
  });
});

test("batch consent narrowing: omitted fields resolve from the snapshot and may be narrowed", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Omitted fields resolve to the snapshot's complete field set at staging,
    // so owner narrowing has a concrete immutable baseline.
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const approved = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      source_narrowing: { 0: { fields: { top_artists: ["id"] } } },
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);
    const streams = childGrantStreams(getDb(), requirePackageId(unwrapBody(approved)), spotify.connector_id);
    assert.deepEqual(streams?.[0]?.fields, ["id", "name"]);
  });
});

test("batch consent narrowing: narrowing a source that was not approved is rejected", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const rejected = await approve(asUrl, {
      approved_source_indexes: [0],
      request_uri: body.request_uri,
      // index 1 (reddit) was deferred, so narrowing it is a mistake.
      source_narrowing: { 1: { streams: ["posts"] } },
      subject_id: "owner_local",
    });
    assert.equal(rejected.status, 400);
    assert.match(unwrapBody(rejected).error?.message ?? "", REGEXP_24);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
  });
});

test("batch consent narrowing: ceremony renders per-source narrowing controls", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [
          { fields: ["id", "name"], name: "top_artists", time_range: { since: "2026-01-01T00:00:00Z" } },
        ]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    assert.ok(body.request_uri);
    const { status, html } = await consentPage(asUrl, body.request_uri);
    assert.equal(status, 200);
    assert.match(html, REGEXP_25);
    assert.match(html, REGEXP_26);
    // top_artists staged with explicit fields → field checkboxes rendered.
    assert.match(html, REGEXP_27);
    // top_artists staged with a time bound → since input rendered.
    assert.match(html, REGEXP_28);
  });
});

test("batch consent gate: a uniform-access-mode package issues all children under one access mode", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // Both sources declare single_use — a uniform-mode batch issues every child
    // grant under that one access mode.
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }], {
          access_mode: "single_use",
        }),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }], { access_mode: "single_use" }),
      ])
    );

    const approved = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      subject_id: "owner_local",
    });
    assert.equal(approved.status, 200);
    assert.equal(issuedGrant(approved).child_grants.length, 2);

    const db = getDb();
    const modes = (
      db
        .prepare(
          `SELECT DISTINCT g.access_mode
             FROM grant_package_members m
             JOIN grants g ON g.grant_id = m.grant_id
            WHERE m.package_id = ?`
        )
        .all(unwrapBody(approved).package_id) as { access_mode: string }[]
    ).map((row) => row.access_mode);
    assert.deepEqual(modes, ["single_use"]);
  });
});
