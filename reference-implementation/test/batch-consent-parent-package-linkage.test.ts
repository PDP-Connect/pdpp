// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Incremental add-source linkage (`parent_package_id`) for the
 * reference-experimental batch consent ceremony.
 *
 * OpenSpec change `implement-batch-consent-ceremony`, task 2.10:
 *
 *   "A later same-client ceremony creates a new package linked via
 *    `parent_package_id`, issues independent grants for the added sources
 *    without re-issuing prior grants, and the dashboard renders a cumulative
 *    per-client view across linked packages."
 *
 * These tests drive the real reference server (in-memory SQLite, owner auth
 * disabled via `ownerAuthPassword: ''`) through:
 *
 *   1. An initial batch ceremony issuing a root package.
 *   2. A second same-client ceremony carrying `parent_package_id`, asserting
 *      it issues only the added source's child grant, links to the prior
 *      package, and leaves the prior package + child grants untouched.
 *   3. The cumulative per-client view across the linked lineage.
 *   4. Fail-closed handling of invalid / cross-client / inactive / malformed
 *      linkage — no new package or child grant is written.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getCumulativeClientAccessForPackage, revokeGrant } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

const REGEXP_1 = /access_token|refresh_token|"token"|token_hash/;
const REGEXP_2 = /does not exist/;
const REGEXP_3 = /different client/;
const REGEXP_4 = /revoked|inactive/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

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
  [key: string]: unknown;
}

function loadManifest(name: string): ConnectorManifest {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${name}.json`), "utf8")) as ConnectorManifest;
}

async function registerManifest(asUrl: string, manifest: ConnectorManifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.ok(resp.status < 400, `connector registration for ${manifest.connector_id} should succeed`);
}

async function seedOwnerConnectorInstance(manifest: ConnectorManifest): Promise<void> {
  const connectorKey = canonicalConnectorKey(manifest.connector_id);
  assert.ok(connectorKey, `expected a canonical connector key for ${manifest.connector_id}`);
  const connectorInstanceId = makeDefaultAccountConnectorInstanceId("owner_local", connectorKey);
  const now = new Date().toISOString();
  await createRequestConnectorInstanceStore().upsert({
    connectorId: connectorKey,
    connectorInstanceId,
    createdAt: now,
    displayName: `${connectorKey} test account`,
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: "batch-consent-parent-package-linkage" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
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
      await registerManifest(asUrl, manifest);
      await seedOwnerConnectorInstance(manifest);
    }
    await fn({ asUrl, github, reddit, spotify });
  } finally {
    await closeServer(server);
  }
}

interface AuthorizationDetailSource {
  id: string;
  kind: string;
}

interface AuthorizationDetailStream {
  name: string;
}

function detail(
  source: AuthorizationDetailSource,
  streams: AuthorizationDetailStream[],
  overrides: Record<string, unknown> = {}
) {
  return {
    access_mode: "single_use",
    purpose_code: "https://pdpp.dev/purpose/personalization",
    source,
    streams,
    type: "https://pdpp.dev/data-access",
    ...overrides,
  };
}

interface ParResponseBody {
  error?: { code?: string; message?: string };
  request_uri?: string;
}

interface ParResult {
  body: ParResponseBody | null;
  status: number;
}

async function par(
  asUrl: string,
  authorizationDetails: unknown[],
  extra: Record<string, unknown> = {},
  clientId = "longview"
): Promise<ParResult> {
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: authorizationDetails,
      client_display: { name: "Longview" },
      client_id: clientId,
      ...extra,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return { body: (await resp.json().catch(() => null)) as ParResponseBody | null, status: resp.status };
}

interface ChildGrant {
  grant_id: string;
  source: { kind: string; id: string };
}

interface ApproveResponseBody {
  error?: { code?: string; message?: string };
  grant?: { grant_id: string; child_grants?: ChildGrant[] };
  package_id?: string;
}

interface ApproveResult {
  body: ApproveResponseBody | null;
  status: number;
}

async function approveBatch(
  asUrl: string,
  requestUri: string | undefined,
  approvedIndexes: number[],
  extra: Record<string, unknown> = {}
): Promise<ApproveResult> {
  const reviewResp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({
      approved_source_indexes: approvedIndexes,
      request_uri: requestUri,
      ...extra,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const reviewBody = (await reviewResp.json().catch(() => null)) as
    | (ApproveResponseBody & {
        approval_review?: unknown;
        approval_review_revision?: unknown;
      })
    | null;
  if (reviewResp.status !== 200) {
    return { body: reviewBody, status: reviewResp.status };
  }
  assert.ok(reviewBody?.approval_review && typeof reviewBody.approval_review === "object");
  assert.equal(typeof reviewBody.approval_review_revision, "string");
  const resp = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: reviewBody.approval_review_revision,
      confirm_reviewed_decision: "1",
      request_uri: requestUri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  return { body: (await resp.json().catch(() => null)) as ApproveResponseBody | null, status: resp.status };
}

async function approveSingle(asUrl: string, requestUri: string | undefined, subjectId: string): Promise<ApproveResult> {
  const reviewResp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const reviewBody = (await reviewResp.json().catch(() => null)) as
    | (ApproveResponseBody & {
        approval_review?: unknown;
        approval_review_revision?: unknown;
      })
    | null;
  assert.equal(reviewResp.status, 200, JSON.stringify(reviewBody));
  assert.ok(reviewBody?.approval_review && typeof reviewBody.approval_review === "object");
  assert.equal(typeof reviewBody?.approval_review_revision, "string");
  const resp = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: reviewBody?.approval_review_revision,
      request_uri: requestUri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  return { body: (await resp.json().catch(() => null)) as ApproveResponseBody | null, status: resp.status };
}

/** Narrows a `{status, body}` result's body from `T | null` to `T`, failing the assertion if null. */
function unwrapBody<T>(result: { status: number; body: T | null }): T {
  assert.ok(result.body, `expected a response body (status ${result.status})`);
  return result.body;
}

interface CumulativePackageDetail {
  approved_at: string | null;
  created_at: string;
  member_count: number;
  package_id: string;
  parent_package_id: string | null;
  revoked_at: string | null;
  status: string;
}

interface CumulativeChild {
  grant_id: string;
  grant_status: string;
  member_status: string;
  package_id: string;
  [key: string]: unknown;
}

interface CumulativeClientAccess {
  active_child_count: number;
  children: CumulativeChild[];
  client_id: string;
  package_count: number;
  packages: CumulativePackageDetail[];
  root_package_id: string;
  subject_id: string;
}

/** Typed wrapper: server/auth.ts is untyped JS, so this pins the real (call-site-verified) return shape. */
async function cumulativeAccess(packageId: string): Promise<CumulativeClientAccess> {
  const result = (await getCumulativeClientAccessForPackage(packageId)) as CumulativeClientAccess | null;
  assert.ok(result, `expected a cumulative view for package ${packageId}`);
  return result;
}

test("parent linkage: a later same-client ceremony links a new package and issues only the added source", async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    // Root ceremony: two sources.
    const first = await par(asUrl, [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
    ]);
    assert.equal(first.status, 201);
    const root = await approveBatch(asUrl, unwrapBody(first).request_uri, [0, 1]);
    assert.equal(root.status, 200);
    const rootPackageId = unwrapBody(root).package_id;
    assert.ok(rootPackageId?.startsWith("gpkg_"));
    assert.ok(rootPackageId);
    const rootGrant = unwrapBody(root).grant;
    assert.ok(rootGrant?.child_grants);
    const rootChildGrantIds = rootGrant.child_grants.map((c) => c.grant_id).sort();
    assert.equal(rootChildGrantIds.length, 2);

    // Add-source ceremony: one new source, linked to the root.
    const second = await par(
      asUrl,
      [detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }])],
      { parent_package_id: rootPackageId }
    );
    assert.equal(second.status, 201);
    const added = await approveBatch(asUrl, unwrapBody(second).request_uri, [0]);
    assert.equal(added.status, 200);
    const addedPackageId = unwrapBody(added).package_id;
    assert.ok(addedPackageId?.startsWith("gpkg_"));
    assert.notEqual(addedPackageId, rootPackageId);

    const db = getDb();
    // The new package records the linkage.
    const addedRow = db
      .prepare("SELECT parent_package_id, status FROM grant_packages WHERE package_id = ?")
      .get(addedPackageId) as { parent_package_id: string | null; status: string };
    assert.equal(addedRow.parent_package_id, rootPackageId);
    assert.equal(addedRow.status, "active");

    // The root package and its child grants are untouched — not re-issued,
    // not mutated, not linked.
    const rootRow = db
      .prepare("SELECT parent_package_id, status FROM grant_packages WHERE package_id = ?")
      .get(rootPackageId) as { parent_package_id: string | null; status: string };
    assert.equal(rootRow.parent_package_id, null);
    assert.equal(rootRow.status, "active");
    // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
    const rootMembersAfter = (
      db
        .prepare("SELECT grant_id FROM grant_package_members WHERE package_id = ? ORDER BY grant_id")
        .all(rootPackageId) as { grant_id: string }[]
    )
      .map((r) => r.grant_id)
      .sort();
    assert.deepEqual(rootMembersAfter, rootChildGrantIds);

    // The added package issues its own independent child grants for the added
    // sources only.
    const addedMembers = db
      .prepare("SELECT grant_id FROM grant_package_members WHERE package_id = ?")
      .all(addedPackageId) as { grant_id: string }[];
    assert.equal(addedMembers.length, 1);
    for (const m of addedMembers) {
      assert.ok(!rootChildGrantIds.includes(m.grant_id), "added grants must be distinct from root grants");
    }

    // Three child grants total (2 root + 1 added), each independently revocable.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, 3);
  });
});

test("parent linkage: cumulative per-client view unions child grants across linked packages", async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    const first = await par(asUrl, [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
    ]);
    const root = await approveBatch(asUrl, unwrapBody(first).request_uri, [0, 1]);
    const rootPackageId = unwrapBody(root).package_id;
    assert.ok(rootPackageId);

    const second = await par(
      asUrl,
      [detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }])],
      { parent_package_id: rootPackageId }
    );
    const added = await approveBatch(asUrl, unwrapBody(second).request_uri, [0]);
    const addedPackageId = unwrapBody(added).package_id;
    assert.ok(addedPackageId);

    // Cumulative view, resolved from EITHER end of the lineage, must agree.
    for (const anchor of [rootPackageId, addedPackageId]) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      const view = await cumulativeAccess(anchor);
      assert.equal(view.root_package_id, rootPackageId, `lineage root from ${anchor}`);
      assert.equal(view.client_id, "longview");
      assert.equal(view.package_count, 2);
      assert.equal(view.children.length, 3, "cumulative view unions all three child grants");
      assert.equal(view.active_child_count, 3);
      // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
      const lineagePackages = view.packages.map((p) => p.package_id).sort();
      assert.deepEqual(lineagePackages, [rootPackageId, addedPackageId].sort());
      // Each child carries its owning package id so the dashboard can group.
      const childPackages = new Set(view.children.map((c) => c.package_id));
      assert.deepEqual([...childPackages].sort(), [rootPackageId, addedPackageId].sort());
    }

    // The cumulative-view route surfaces the lineage and stays owner-gated.
    const resp = await fetch(`${asUrl}/_ref/grant-packages/${addedPackageId}/cumulative`);
    assert.equal(resp.status, 200);
    const routeBody = (await resp.json()) as {
      object: string;
      root_package_id: string;
      package_count: number;
      active_child_count: number;
      children: unknown[];
    };
    assert.equal(routeBody.object, "grant_package_cumulative_view");
    assert.equal(routeBody.root_package_id, rootPackageId);
    assert.equal(routeBody.package_count, 2);
    assert.equal(routeBody.active_child_count, 3);
    assert.equal(routeBody.children.length, 3);
    // No token / secret material leaks.
    const serialized = JSON.stringify(routeBody);
    assert.doesNotMatch(serialized, REGEXP_1);
  });
});

test("parent linkage: revoking one child grant updates the cumulative active count, leaves others active", async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    const first = await par(asUrl, [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
    ]);
    const root = await approveBatch(asUrl, unwrapBody(first).request_uri, [0, 1]);
    const rootPackageId = unwrapBody(root).package_id;
    const rootGrant = unwrapBody(root).grant;
    assert.ok(rootGrant?.child_grants);
    const spotifyChild = rootGrant.child_grants.find((c) => c.source.id === spotify.connector_id);
    assert.ok(spotifyChild, "root grant must include a spotify child grant");

    const second = await par(
      asUrl,
      [detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }])],
      { parent_package_id: rootPackageId }
    );
    const added = await approveBatch(asUrl, unwrapBody(second).request_uri, [0]);

    // Revoke one root child grant directly (per-grant revocation stays primary).
    await revokeGrant(spotifyChild.grant_id, { request_id: "parent-linkage-child-revoke-test" });

    const addedPackageId = unwrapBody(added).package_id;
    assert.ok(addedPackageId);
    const view = await cumulativeAccess(addedPackageId);
    assert.equal(view.children.length, 3, "cumulative view still lists every issued child");
    assert.equal(view.active_child_count, 2, "one child revoked, two remain active");
  });
});

test("parent linkage: a non-existent parent fails closed before issuing", async () => {
  await withHarness(async ({ asUrl, github }) => {
    const resp = await par(
      asUrl,
      [detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }])],
      { parent_package_id: "gpkg_does_not_exist" }
    );
    assert.equal(resp.status, 400);
    assert.equal(unwrapBody(resp).error?.code, "invalid_request");
    assert.match(unwrapBody(resp).error?.message ?? "", REGEXP_2);

    const db = getDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grant_packages").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, 0);
  });
});

test("parent linkage: a cross-client parent fails closed", async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    // Root package owned by 'longview'.
    const first = await par(asUrl, [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
    ]);
    const root = await approveBatch(asUrl, unwrapBody(first).request_uri, [0, 1]);
    const rootPackageId = unwrapBody(root).package_id;

    // A different registered client attempts to link to longview's package.
    const cross = await par(
      asUrl,
      [detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }])],
      { parent_package_id: rootPackageId },
      "concert_recommendation_app"
    );
    assert.equal(cross.status, 400);
    assert.match(unwrapBody(cross).error?.message ?? "", REGEXP_3);
  });
});

test("parent linkage: an inactive (revoked) parent fails closed", async () => {
  await withHarness(async ({ asUrl, spotify, reddit, github }) => {
    const first = await par(asUrl, [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
    ]);
    const root = await approveBatch(asUrl, unwrapBody(first).request_uri, [0, 1]);
    const rootPackageId = unwrapBody(root).package_id;

    // Revoke the whole root package.
    const revoke = await fetch(`${asUrl}/_ref/grant-packages/${rootPackageId}/revoke`, {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.ok(revoke.status < 400, "package revoke should succeed");

    const linked = await par(
      asUrl,
      [detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }])],
      { parent_package_id: rootPackageId }
    );
    assert.equal(linked.status, 400);
    assert.match(unwrapBody(linked).error?.message ?? "", REGEXP_4);
  });
});

test("parent linkage: a malformed parent_package_id fails closed", async () => {
  await withHarness(async ({ asUrl, github }) => {
    const resp = await par(
      asUrl,
      [detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }])],
      { parent_package_id: "   " }
    );
    assert.equal(resp.status, 400);
    assert.equal(unwrapBody(resp).error?.code, "invalid_request");
  });
});

test("parent linkage: a single-entry request without parent_package_id stays on the default grant path", async () => {
  await withHarness(async ({ asUrl, github }) => {
    const resp = await par(asUrl, [detail({ id: github.connector_id, kind: "connector" }, [{ name: "repositories" }])]);
    assert.equal(resp.status, 201);

    const approved = await approveSingle(asUrl, unwrapBody(resp).request_uri, "owner_local");
    assert.equal(approved.status, 200);
    const approvedGrant = unwrapBody(approved).grant;
    assert.ok(approvedGrant);
    assert.ok(approvedGrant.grant_id.startsWith("grt_"));
    assert.equal(unwrapBody(approved).package_id, undefined);

    const db = getDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grant_packages").get() as { n: number }).n, 0);
  });
});
