// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent control entrypoint
 * `GET /v1/owner/control` (mounted from `server/routes/owner-control.ts`) and
 * the `pdpp_owner_agent_onboarding.control_surface` discovery hint.
 *
 * Covers the control-entrypoint slice of the owner-agent control surface:
 *
 *   - a trusted owner-agent bearer can fetch the control capability document;
 *   - client grant tokens and missing/unauthenticated bearers cannot;
 *   - `/mcp` continues to reject owner bearers (the boundary this lane preserves);
 *   - the document marks supported families (`discover_control_capabilities`,
 *     `list_connections`) with method + absolute URL, and names every other
 *     family explicitly with an `owner_mediated`/`unsupported` status rather than
 *     silently omitting it;
 *   - the supported `list_connections` URL points at `/v1/owner/connections`;
 *   - the composed-mode discovery metadata advertises the same control entrypoint
 *     and action catalog, so discovery and the live document agree.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/index.ts";

const TOP_LEVEL_REGEX_1 = /test-event/;
const TOP_LEVEL_REGEX_2 = /resume/;
const TOP_LEVEL_REGEX_3 = /connector_id/;
const TOP_LEVEL_REGEX_4 = /health/;
const TOP_LEVEL_REGEX_5 = /future collection/i;
const TOP_LEVEL_REGEX_6 = /records/i;
const TOP_LEVEL_REGEX_7 = /erase/i;
const TOP_LEVEL_REGEX_8 = /NOT revoke/i;
const TOP_LEVEL_REGEX_9 = /subscription_id/;
const TOP_LEVEL_REGEX_10 = /run_id/;
const TOP_LEVEL_REGEX_11 = /run_connection/;
const TOP_LEVEL_REGEX_12 = /revoke_connection/;
const TOP_LEVEL_REGEX_13 = /delete_connection/;
const TOP_LEVEL_REGEX_14 = /owner-agent/i;
const TOP_LEVEL_REGEX_15 = /owner-agent/i;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  asPort: number;
  asServer: TestHttpServer;
  rsPort: number;
  rsServer: TestHttpServer;
  schedulerManager?: {
    stop?: () => void;
  };
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(resolve)),
    new Promise<void>((resolve) => server.rsServer.close(resolve)),
  ]);
}

interface FetchJsonResult {
  body: unknown;
  resp: Response;
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
  return { body, resp, status: resp.status };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface WithServerStartOptions {
  referenceMode?: string;
  referenceOrigin?: string;
}

async function withServer(
  fn: (ctx: { asUrl: string; rsUrl: string; server: TestServerHandle }) => Promise<void>,
  startOpts: WithServerStartOptions = {}
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    ...startOpts,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

async function issueOwnerToken(asUrl: string, subjectId: string = OWNER_SUBJECT_ID): Promise<string> {
  const clientId = "cli_longview";
  const device = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: clientId }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      })
    ).body
  );
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: String(device.user_code) }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tok = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: clientId,
          device_code: String(device.device_code),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      })
    ).body
  );
  assert.ok(tok.access_token, "device exchange should issue an owner token");
  return String(tok.access_token);
}

function loadManifest(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests", `${name}.json`), "utf8")
  ) as Record<string, unknown>;
}

async function registerConnector(asUrl: string, manifest: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  return manifest;
}

// PAR + consent yields a grant-scoped client-kind bearer. It must NOT reach the
// owner-agent control entrypoint. Scopes to a real registered connector/stream.
async function approveClientGrant(asUrl: string, connectorId: unknown, streamName: unknown): Promise<string> {
  const par = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/analytics",
              purpose_description: "owner-control boundary test",
              source: { id: connectorId, kind: "connector" },
              streams: [{ fields: ["id"], name: streamName }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    ).body
  );
  const approved = asRecord(
    (
      await fetchJson(`${asUrl}/consent/approve`, {
        body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    ).body
  );
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return String(approved.token);
}

function actionByFamily(doc: unknown, family: string): Record<string, unknown> {
  const action = asArray(asRecord(doc).actions).find((a) => asRecord(a).family === family);
  return asRecord(action);
}

test("owner-agent bearer fetches the control capability document", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    const bodyRecord = asRecord(body);
    assert.equal(bodyRecord.object, "owner_agent_control_surface");
    assert.equal(bodyRecord.scope, "reference_implementation");
    assert.equal(bodyRecord.mcp_owner_bearer_rejected, true);
    assert.equal(bodyRecord.entrypoint, `${rsUrl}/v1/owner/control`);
    assert.ok(Array.isArray(bodyRecord.actions) && bodyRecord.actions.length > 0);
  });
});

test("control document marks supported families with method + absolute URL", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    const discover = actionByFamily(body, "discover_control_capabilities");
    assert.ok(discover.family, "discover_control_capabilities must be listed");
    assert.equal(discover.status, "supported");
    assert.equal(discover.method, "GET");
    assert.equal(discover.url, `${rsUrl}/v1/owner/control`);

    // The already-supported owner-agent route must be linked, by URL, so an
    // agent does not have to guess where connection listing lives.
    const listConnections = actionByFamily(body, "list_connections");
    assert.ok(listConnections.family, "list_connections must be listed");
    assert.equal(listConnections.status, "supported");
    assert.equal(listConnections.method, "GET");
    assert.equal(listConnections.url, `${rsUrl}/v1/owner/connections`);

    // Rename is served over the owner-agent bearer surface as of the
    // owner-agent rename slice (task 4.4). It is templated by connection_id so
    // the URL carries a literal `{connection_id}` placeholder, not a live id.
    const rename = actionByFamily(body, "rename_connection");
    assert.ok(rename.family, "rename_connection must be listed");
    assert.equal(rename.status, "supported");
    assert.equal(rename.method, "PATCH");
    assert.equal(rename.url, `${rsUrl}/v1/owner/connections/{connection_id}`);

    // Connection initiation is served over the owner-agent bearer surface as of
    // the connection-initiation slice (tasks 2.3, 5.1-5.4). The intent route
    // returns a typed owner-mediated next step; it never marks a connection
    // active.
    const initiate = actionByFamily(body, "initiate_connection");
    assert.ok(initiate.family, "initiate_connection must be listed");
    assert.equal(initiate.status, "supported");
    assert.equal(initiate.method, "POST");
    assert.equal(initiate.url, `${rsUrl}/v1/owner/connections/intents`);

    // Schedule pause/resume is served over the owner-agent bearer surface as of
    // the instance-scoped schedule slice (tasks 6.1-6.3). It is templated by
    // connection_id; the representative URL is the pause route and the reason
    // names the resume sibling.
    const manageSchedule = actionByFamily(body, "manage_schedule");
    assert.ok(manageSchedule.family, "manage_schedule must be listed");
    assert.equal(manageSchedule.status, "supported");
    assert.equal(manageSchedule.method, "POST");
    assert.equal(manageSchedule.url, `${rsUrl}/v1/owner/connections/{connection_id}/schedule/pause`);
    assert.match(String(manageSchedule.reason), TOP_LEVEL_REGEX_2);

    // Run-now is served over the owner-agent bearer surface as of the run
    // control slice (tasks 6.1-6.3). It is templated by connection_id; the
    // representative URL is the connection-scoped route and the reason names the
    // connector-only addressing.
    const runConnection = actionByFamily(body, "run_connection");
    assert.ok(runConnection.family, "run_connection must be listed");
    assert.equal(runConnection.status, "supported");
    assert.equal(runConnection.method, "POST");
    assert.equal(runConnection.url, `${rsUrl}/v1/owner/connections/{connection_id}/run`);
    assert.match(String(runConnection.reason), TOP_LEVEL_REGEX_3);

    // Connection-scoped diagnostics is served over the owner-agent bearer surface
    // as of the diagnostics slice (task 6.1d / design "Deferred: connection-scoped
    // diagnostics"). It is templated by connection_id; the representative URL is
    // the connection-scoped route and the reason names the typed health states
    // and the connector-only addressing.
    const inspectDiagnostics = actionByFamily(body, "inspect_diagnostics");
    assert.ok(inspectDiagnostics.family, "inspect_diagnostics must be listed");
    assert.equal(inspectDiagnostics.status, "supported");
    assert.equal(inspectDiagnostics.method, "GET");
    assert.equal(inspectDiagnostics.url, `${rsUrl}/v1/owner/connections/{connection_id}/diagnostics`);
    assert.match(String(inspectDiagnostics.reason), TOP_LEVEL_REGEX_4);

    // Connection revoke is served over the owner-agent bearer surface as of the
    // revoke-durability slice (tasks 3.1d/6.1d / design "Deferred:
    // connection-revoke durability"). It is templated by connection_id; the
    // representative URL is the connection-scoped route and the reason states it
    // stops future collection, preserves records, and is reversible only by
    // explicit re-initiate.
    const revokeConnection = actionByFamily(body, "revoke_connection");
    assert.ok(revokeConnection.family, "revoke_connection must be listed");
    assert.equal(revokeConnection.status, "supported");
    assert.equal(revokeConnection.method, "POST");
    assert.equal(revokeConnection.url, `${rsUrl}/v1/owner/connections/{connection_id}/revoke`);
    assert.match(String(revokeConnection.reason), TOP_LEVEL_REGEX_5);
    assert.match(String(revokeConnection.reason), TOP_LEVEL_REGEX_6);

    // Connection delete is served over the owner-agent bearer surface as of the
    // delete-cascade slice (add-owner-connection-delete-contract section 2). It
    // is templated by connection_id; the representative URL is the bare
    // connection resource (REST DELETE verb, no `/delete` suffix) and the reason
    // states it erases the past and removes the configuration (NOT revoke).
    const deleteConnection = actionByFamily(body, "delete_connection");
    assert.ok(deleteConnection.family, "delete_connection must be listed");
    assert.equal(deleteConnection.status, "supported");
    assert.equal(deleteConnection.method, "DELETE");
    assert.equal(deleteConnection.url, `${rsUrl}/v1/owner/connections/{connection_id}`);
    assert.match(String(deleteConnection.reason), TOP_LEVEL_REGEX_7);
    assert.match(String(deleteConnection.reason), TOP_LEVEL_REGEX_8);

    // Event-subscription management is served over the owner-agent bearer
    // surface: the `/v1/event-subscriptions*` routes already accept a
    // trusted_owner_agent bearer, and the control catalog now advertises that
    // capability (admin-surface audit "one genuine construction gap"). It is a
    // surface-level family (not bound to one connection); the representative URL
    // is the list/create collection route and the reason names the
    // per-subscription and test-event siblings.
    const manageSubscriptions = actionByFamily(body, "manage_event_subscriptions");
    assert.ok(manageSubscriptions.family, "manage_event_subscriptions must be listed");
    assert.equal(manageSubscriptions.status, "supported");
    assert.equal(manageSubscriptions.method, "GET");
    assert.equal(manageSubscriptions.url, `${rsUrl}/v1/event-subscriptions`);
    assert.match(String(manageSubscriptions.reason), TOP_LEVEL_REGEX_1);
    assert.match(String(manageSubscriptions.reason), TOP_LEVEL_REGEX_9);
  });
});

test("control document advertises cancel_run honestly: typed, run-scoped, no owner-agent bearer URL", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // cancel_run is served only over the owner-session reference route
    // (`POST /_ref/runs/{run_id}/cancel`) in this tranche; the owner-agent
    // bearer route is deferred (R.2). So the catalog NAMES the action with a
    // typed status but advertises no bearer method/URL — the honesty rule.
    const cancelRun = actionByFamily(body, "cancel_run");
    assert.ok(cancelRun.family, "cancel_run must be named in the catalog");
    assert.equal(cancelRun.status, "owner_mediated");
    assert.equal(cancelRun.method, null, "no owner-agent bearer method while only the owner-session route serves it");
    assert.equal(cancelRun.url, null, "no owner-agent bearer url while only the owner-session route serves it");
    // It is described as run-scoped, non-destructive, and distinct from the
    // connection lifecycle actions.
    assert.match(String(cancelRun.reason), TOP_LEVEL_REGEX_10);
    assert.match(String(cancelRun.reason), TOP_LEVEL_REGEX_11);
    assert.match(String(cancelRun.reason), TOP_LEVEL_REGEX_12);
    assert.match(String(cancelRun.reason), TOP_LEVEL_REGEX_13);
  });
});

test("control document names every family with a typed status and a non-empty reason (no silent omission)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // As of the delete-cascade slice (add-owner-connection-delete-contract
    // section 2) every owner-agent control family is `supported`:
    // `delete_connection` was the last destructive family honestly typed
    // `unsupported`, and its route + store primitive + acceptance-test matrix
    // now land together, so the catalog flips it to `supported`. The
    // no-silent-omission property the catalog guarantees still holds: EVERY
    // family is named, carries a typed status from the known enum, and has a
    // non-empty reason — nothing is dropped.
    const VALID_STATUSES = new Set(["supported", "owner_mediated", "unsupported"]);
    const bodyRecord = asRecord(body);
    const actions = asArray(bodyRecord.actions);
    assert.ok(actions.length > 0, "catalog must enumerate families");
    for (const rawAction of actions) {
      const action = asRecord(rawAction);
      assert.ok(typeof action.family === "string" && action.family.length > 0, "every family is named");
      assert.ok(VALID_STATUSES.has(String(action.status)), `${String(action.family)} carries a typed status`);
      assert.ok(
        typeof action.reason === "string" && action.reason.length > 0,
        `${String(action.family)} carries a non-empty reason`
      );
      // A non-supported family must not advertise a route; a supported one must.
      if (action.status === "supported") {
        assert.ok(action.method, `${String(action.family)} supported → method present`);
        assert.ok(action.url, `${String(action.family)} supported → url present`);
      } else {
        assert.equal(action.url, null, `${String(action.family)} not supported → no url`);
      }
    }

    // delete_connection is specifically the formerly-unsupported destructive
    // family that is now named-and-supported (the overclaim guard inverted: it
    // is no longer faked as unsupported now that the cascade is proven).
    const del = actionByFamily(body, "delete_connection");
    assert.ok(del.family, "delete_connection must be named in the catalog");
    assert.equal(del.status, "supported");
  });
});

test("owner-agent control entrypoint rejects a client grant token with 403", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const streamName = asRecord(asArray(manifest.streams)[0]).name;
    const clientToken = await approveClientGrant(asUrl, manifest.connector_id, streamName);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(status, 403);
    assert.equal(asRecord(asRecord(body).error).code, "permission_error");
  });
});

test("owner-agent control entrypoint rejects a request with no bearer (401)", async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`);
    assert.equal(status, 401);
    assert.equal(asRecord(asRecord(body).error).type, "authentication_error");
  });
});

test("/mcp continues to reject owner-agent bearers (boundary preserved)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.equal(status, 403);
    const errorRecord = asRecord(asRecord(body).error);
    assert.equal(errorRecord.code, "permission_error");
    assert.match(String(errorRecord.message ?? ""), TOP_LEVEL_REGEX_14);
  });
});

test("manage_event_subscriptions advertisement is honest: owner bearer is accepted on the route, /mcp rejects it", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);

    // (1) The control catalog advertises the family as supported, pointing at
    // the real `/v1/event-subscriptions` collection route.
    const control = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const manageSubscriptions = actionByFamily(control.body, "manage_event_subscriptions");
    assert.ok(manageSubscriptions.family, "manage_event_subscriptions must be advertised");
    assert.equal(manageSubscriptions.status, "supported");
    assert.equal(manageSubscriptions.url, `${rsUrl}/v1/event-subscriptions`);

    // (2) The advertisement is honest: a trusted owner-agent bearer is actually
    // accepted on the advertised route (it can list its subscriptions; here zero
    // exist, so an empty data array, not a 401/403).
    const ownerList = await fetchJson(`${rsUrl}/v1/event-subscriptions`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerList.status, 200, "owner bearer must be accepted on /v1/event-subscriptions");
    const ownerListBody = asRecord(ownerList.body);
    assert.ok(Array.isArray(ownerListBody.data), "listing returns a data array");
    assert.equal(asArray(ownerListBody.data).length, 0, "no subscriptions configured yet");

    // (3) The credential boundary is preserved: the same owner bearer cannot
    // reach event-subscription tools over /mcp — /mcp rejects owner bearers by
    // construction, so advertising the REST control family does not widen /mcp.
    const mcp = await fetchJson(`${rsUrl}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.equal(mcp.status, 403, "/mcp must still reject owner bearers");
    const mcpErrorRecord = asRecord(asRecord(mcp.body).error);
    assert.equal(mcpErrorRecord.code, "permission_error");
    assert.match(String(mcpErrorRecord.message ?? ""), TOP_LEVEL_REGEX_15);
  });
});

test("manage_event_subscriptions is a surface family, never projected onto a connection row", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    // Surface-level families (discover/list/initiate/manage_event_subscriptions)
    // must not leak into a connection's instance-scoped supported_actions, even
    // when configured connections exist.
    for (const rawConnection of asArray(asRecord(body).data)) {
      const connection = asRecord(rawConnection);
      const families = asArray(connection.supported_actions).map((a) => asRecord(a).family);
      assert.ok(
        !families.includes("manage_event_subscriptions"),
        "manage_event_subscriptions must not appear in per-connection supported_actions"
      );
    }
  });
});

test("discovery metadata advertises the same control entrypoint and catalog", async () => {
  const publicOrigin = "http://localhost:3219";
  await withServer(
    async ({ rsUrl }) => {
      const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
      assert.equal(status, 200);
      const onboarding = asRecord(asRecord(body).pdpp_owner_agent_onboarding);
      assert.ok(onboarding.control_surface, "composed mode must advertise owner-agent onboarding");
      const surface = asRecord(onboarding.control_surface);
      assert.ok(surface.object, "onboarding block must carry a control_surface hint");
      assert.equal(surface.object, "owner_agent_control_surface");
      assert.equal(surface.entrypoint, `${publicOrigin}/v1/owner/control`);
      assert.equal(surface.mcp_owner_bearer_rejected, true);

      // The discovery hint and the live document must agree on the supported
      // list_connections route. (The live document is fetched against the
      // ephemeral rsUrl; the hint is rebased to the composed public origin, so
      // compare path suffixes.)
      const listConnections = asRecord(asArray(surface.actions).find((a) => asRecord(a).family === "list_connections"));
      assert.ok(listConnections.family);
      assert.equal(listConnections.status, "supported");
      assert.equal(listConnections.url, `${publicOrigin}/v1/owner/connections`);
    },
    { referenceMode: "composed", referenceOrigin: publicOrigin }
  );
});
