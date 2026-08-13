// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getGrantPackageIdForGrant, listGrantPackagesForOwner, parsePendingConsentRequestUri } from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const REGEXP_1 = /Confirm each source/;
const REGEXP_2 = /Reference-experimental batch consent/;
const REGEXP_3 = /name="approved_source_indexes"/;
const REGEXP_4 = /Per-source confirmation required/;
const REGEXP_5 = /I confirm allowing all/;
const REGEXP_6 = /Approve-all is not available/;
const REGEXP_7 = /sensitive_no_time_bound/;
const REGEXP_8 = /three_or_more_sensitive_sources/;
const REGEXP_9 = /requires a re-asserting confirmation/;
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
const REGEXP_23 = /no field projection/;
const REGEXP_24 = /not in the approved set/;
const REGEXP_25 = /Narrow this source/;
const REGEXP_26 = /name="narrow_streams_0"/;
const REGEXP_27 = /name="narrow_fields_0__/;
const REGEXP_28 = /name="narrow_since_0__/;

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

async function approve(asUrl: string, requestBody: Record<string, unknown>): Promise<GateResult> {
  const resp = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify(requestBody),
    headers: { "Content-Type": "application/json" },
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
  const resp = await fetch(`${asUrl}/consent/approve`, {
    body: params.toString(),
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return { body: (await resp.json().catch(() => null)) as GateResponseBody | null, status: resp.status };
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
    assert.equal(firstChild.source.id, "reddit");

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
      ["reddit", "spotify"]
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

test("batch consent gate: low-risk approve-all requires re-asserting confirmation", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    const entries = [
      detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }], { access_mode: "single_use" }),
      detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }], { access_mode: "single_use" }),
    ];
    const first = await par(asUrl, entries);

    const missingConfirmation = await approve(asUrl, {
      request_uri: unwrapBody(first).request_uri,
      subject_id: "owner_local",
    });
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
      entries: { source_binding: { id: string } }[];
    };
    assert.equal(stored.request_kind, "pdpp_selection_request_batch");
    assert.deepEqual(
      stored.entries.map((entry) => entry.source_binding.id),
      ["spotify", "reddit"]
    );
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
      ["reddit"]
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
  streams: { name: string; fields?: string[]; time_range?: { since: string } }[];
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
    assert.equal(onlySpotifyChild.source.id, "spotify");

    const db = getDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, 1);
    // No reddit grant issued from this ceremony.
    assert.equal(childGrantStreams(db, requirePackageId(unwrapBody(approved)), "reddit"), null);
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
    assert.equal(formSpotifyChild.source.id, "spotify");

    const db = getDb();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n, 1);
    assert.equal(childGrantStreams(db, requirePackageId(unwrapBody(approved)), "reddit"), null);
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
    const spotifyStreams = childGrantStreams(db, requirePackageId(unwrapBody(approved)), "spotify");
    assert.ok(spotifyStreams);
    assert.deepEqual(
      spotifyStreams.map((s) => s.name),
      ["top_artists"]
    );
    // reddit untouched.
    const redditStreams = childGrantStreams(db, requirePackageId(unwrapBody(approved)), "reddit");
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
    const streams = childGrantStreams(db, requirePackageId(unwrapBody(approved)), "spotify");
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
    const streams = childGrantStreams(db, requirePackageId(unwrapBody(approved)), "spotify");
    assert.ok(streams);
    const [timeBoundStream] = streams;
    assert.ok(timeBoundStream?.time_range);
    assert.equal(timeBoundStream.time_range.since, "2026-03-01T00:00:00Z");
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

test("batch consent narrowing: a field subset on an unprojected stream is rejected", async () => {
  await withHarness(async ({ asUrl, spotify, reddit }) => {
    // spotify top_artists staged with NO field projection. A field subset
    // cannot be proven narrower against an unprojected (full-record) stream, so
    // the narrowing is rejected rather than silently issuing the full record.
    const body = unwrapBody(
      await par(asUrl, [
        detail({ id: spotify.connector_id, kind: "connector" }, [{ name: "top_artists" }]),
        detail({ id: reddit.connector_id, kind: "connector" }, [{ name: "posts" }]),
      ])
    );

    const rejected = await approve(asUrl, {
      approved_source_indexes: [0, 1],
      request_uri: body.request_uri,
      source_narrowing: { 0: { fields: { top_artists: ["id"] } } },
      subject_id: "owner_local",
    });
    assert.equal(rejected.status, 400);
    assert.match(unwrapBody(rejected).error?.message ?? "", REGEXP_23);

    assert.equal(countRows("SELECT COUNT(*) AS n FROM grants"), 0);
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
