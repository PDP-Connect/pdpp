// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `/_ref/provider-app-config` route (GET + POST) using an
 * injected in-memory test-double store — no real DB, no real manifest
 * registry. Proves the route-owned contract independent of whichever lane
 * implements the real `ProviderAppConfigStore`:
 *
 *   - GET returns the opaque identity_group token (hidden addressing value)
 *     plus label + logical field labels/secret/configured only —
 *     never env_alias, never a value.
 *   - POST validates every key against the group's declared logical keys
 *     BEFORE any write; an unknown key rejects with zero writes.
 *   - POST requires every currently-missing declared key on first setup;
 *     an incomplete first-setup call rejects with zero writes.
 *   - POST allows blanks/omission for already-configured (store OR
 *     env-satisfied) fields.
 *   - POST commits every value in exactly one setMany call — never a loop of
 *     individual writes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  MountRefProviderAppConfigContext,
  ProviderAppConfigStore,
  ProviderIdentityGroupDescriptor,
} from "../server/routes/ref-provider-app-config.ts";
import {
  mountRefProviderAppConfigGet,
  mountRefProviderAppConfigPost,
} from "../server/routes/ref-provider-app-config.ts";

interface FakeRequest {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | string[] | undefined>>;
}

interface FakeResponse {
  body: unknown;
  json: (value: unknown) => unknown;
  status: (code: number) => FakeResponse;
  statusCode: number | null;
}

type FakeRouteHandler = (req: FakeRequest, res: FakeResponse) => Promise<unknown>;

function fakeResponse(): FakeResponse {
  const res: FakeResponse = {
    body: undefined,
    json(value) {
      res.body = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    statusCode: null,
  };
  return res;
}

const FIXTURE_GROUP: ProviderIdentityGroupDescriptor = {
  fields: [
    { envAlias: "FIXTURE_CLIENT_ID", label: "Client ID", logicalKey: "client_id", secret: false },
    { envAlias: "FIXTURE_CLIENT_SECRET", label: "Client Secret", logicalKey: "client_secret", secret: true },
  ],
  identityGroup: "shared-fixture-oauth-app",
  providerIdentityLabel: "Shared Fixture OAuth App",
};

interface Harness {
  ctx: MountRefProviderAppConfigContext;
  getHandler: FakeRouteHandler;
  postHandler: FakeRouteHandler;
  satisfiedEnvAliases: Set<string>;
  setManyCalls: Array<{ identityGroup: string; values: Readonly<Record<string, string>>; updatedAt: string }>;
  storedByKey: Map<string, string>;
}

function buildHarness(overrides: Partial<MountRefProviderAppConfigContext> = {}): Harness {
  const storedByKey = new Map<string, string>();
  const setManyCalls: Harness["setManyCalls"] = [];
  const satisfiedEnvAliases = new Set<string>();

  const store: ProviderAppConfigStore = {
    listConfiguredKeys: (identityGroup) =>
      Promise.resolve(
        [...storedByKey.keys()].filter((k) => k.startsWith(`${identityGroup}:`)).map((k) => k.split(":")[1] as string)
      ),
    setMany: ({ identityGroup, values, updatedAt }) => {
      setManyCalls.push({ identityGroup, updatedAt, values });
      for (const [logicalKey, value] of Object.entries(values)) {
        storedByKey.set(`${identityGroup}:${logicalKey}`, value);
      }
      return Promise.resolve();
    },
  };

  const ctx: MountRefProviderAppConfigContext = {
    createRequestProviderAppConfigStore: () => store,
    handleError: (_res, err) => {
      throw err;
    },
    isEnvAliasSatisfied: (envAlias) => satisfiedEnvAliases.has(envAlias),
    listProviderIdentityGroups: () => Promise.resolve([FIXTURE_GROUP]),
    now: () => "2026-08-09T00:00:00.000Z",
    pdppError: (_res, status, code, message) => {
      const err = new Error(message) as Error & { status: number; code: string };
      err.status = status;
      err.code = code;
      throw err;
    },
    requireOwnerSession: (_req, _res, next) => (typeof next === "function" ? next() : undefined),
    resolveProviderIdentityGroup: (identityGroup) =>
      Promise.resolve(identityGroup === FIXTURE_GROUP.identityGroup ? FIXTURE_GROUP : null),
    ...overrides,
  };

  let getHandler: FakeRouteHandler | null = null;
  let postHandler: FakeRouteHandler | null = null;
  const app = {
    get(_path: string, ..._handlers: unknown[]) {
      getHandler = _handlers.at(-1) as FakeRouteHandler;
      return app;
    },
    post(_path: string, ..._handlers: unknown[]) {
      postHandler = _handlers.at(-1) as FakeRouteHandler;
      return app;
    },
  };
  mountRefProviderAppConfigGet(app, ctx);
  mountRefProviderAppConfigPost(app, ctx);
  if (!(getHandler && postHandler)) {
    throw new Error("route handlers were not captured");
  }
  return { ctx, getHandler, postHandler, satisfiedEnvAliases, setManyCalls, storedByKey };
}

// ─── GET ────────────────────────────────────────────────────────────────────

test("GET returns the opaque identity_group token plus label + logical field labels/secret/configured only, never env_alias or a value", async () => {
  const { getHandler } = buildHarness();
  const res = fakeResponse();
  await getHandler({ query: { identity_group: FIXTURE_GROUP.identityGroup } }, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as {
    identity_group: string;
    provider_identity_label: string;
    logical_keys: Record<string, unknown>[];
  };
  assert.equal(
    body.identity_group,
    FIXTURE_GROUP.identityGroup,
    "identity_group is returned as a hidden addressing token"
  );
  assert.equal(body.provider_identity_label, "Shared Fixture OAuth App");
  assert.equal(body.logical_keys.length, 2);
  for (const field of body.logical_keys) {
    assert.deepEqual(Object.keys(field).sort(), ["configured", "label", "logical_key", "secret"]);
  }
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("FIXTURE_CLIENT_ID"), "env_alias must never appear in the GET response");
  assert.ok(!serialized.includes("FIXTURE_CLIENT_SECRET"), "env_alias must never appear in the GET response");
});

test("GET reports configured:true for a field satisfied by env, without ever naming the env var", async () => {
  const { getHandler, satisfiedEnvAliases } = buildHarness();
  satisfiedEnvAliases.add("FIXTURE_CLIENT_ID");
  const res = fakeResponse();
  await getHandler({ query: { identity_group: FIXTURE_GROUP.identityGroup } }, res);
  const body = res.body as { logical_keys: Array<{ logical_key: string; configured: boolean }> };
  const clientId = body.logical_keys.find((f) => f.logical_key === "client_id");
  assert.equal(clientId?.configured, true);
  const clientSecret = body.logical_keys.find((f) => f.logical_key === "client_secret");
  assert.equal(clientSecret?.configured, false);
});

test("GET with no identity_group lists every registered group, in the same per-group shape", async () => {
  const { getHandler } = buildHarness();
  const res = fakeResponse();
  await getHandler({ query: {} }, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as {
    object: string;
    groups: Array<{ identity_group: string; provider_identity_label: string }>;
  };
  assert.equal(body.object, "provider_app_config_list");
  assert.equal(body.groups.length, 1);
  assert.equal(body.groups[0]?.identity_group, FIXTURE_GROUP.identityGroup);
  assert.equal(body.groups[0]?.provider_identity_label, "Shared Fixture OAuth App");
});

test("GET on an unknown identity_group returns 404", async () => {
  const { getHandler } = buildHarness();
  await assert.rejects(
    () => getHandler({ query: { identity_group: "no-such-group" } }, fakeResponse()),
    (err: unknown) => (err as { code: string }).code === "not_found"
  );
});

// ─── POST validation-before-write ──────────────────────────────────────────

test("POST rejects an unrecognized logical key with zero writes", async () => {
  const { postHandler, setManyCalls } = buildHarness();
  await assert.rejects(
    () =>
      postHandler(
        { body: { identity_group: FIXTURE_GROUP.identityGroup, values: { not_a_real_key: "x" } } },
        fakeResponse()
      ),
    (err: unknown) => (err as { code: string }).code === "provider_app_config_unknown_key"
  );
  assert.equal(setManyCalls.length, 0, "an invalid request must not reach the store");
});

test("POST rejects an incomplete first-setup call (missing required key) with zero writes", async () => {
  const { postHandler, setManyCalls } = buildHarness();
  await assert.rejects(
    () =>
      postHandler(
        { body: { identity_group: FIXTURE_GROUP.identityGroup, values: { client_id: "id-only" } } },
        fakeResponse()
      ),
    (err: unknown) => (err as { code: string }).code === "provider_app_config_missing_required"
  );
  assert.equal(setManyCalls.length, 0, "an incomplete first-setup call must not reach the store");
});

test("POST succeeds when all declared keys are present on first setup, committed as one setMany call", async () => {
  const { postHandler, setManyCalls } = buildHarness();
  const res = fakeResponse();
  await postHandler(
    {
      body: {
        identity_group: FIXTURE_GROUP.identityGroup,
        values: { client_id: "id-1", client_secret: "secret-1" },
      },
    },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(setManyCalls.length, 1, "exactly one atomic write, never a loop of per-key writes");
  assert.deepEqual(setManyCalls[0]?.values, { client_id: "id-1", client_secret: "secret-1" });
  assert.equal(setManyCalls[0]?.identityGroup, FIXTURE_GROUP.identityGroup);
});

test("POST allows omitting an already-configured field on a follow-up update", async () => {
  const harness = buildHarness();
  // First setup: configure both.
  await harness.postHandler(
    {
      body: {
        identity_group: FIXTURE_GROUP.identityGroup,
        values: { client_id: "id-1", client_secret: "secret-1" },
      },
    },
    fakeResponse()
  );
  harness.setManyCalls.length = 0;

  // Follow-up: rotate only the secret, omitting client_id entirely.
  const res = fakeResponse();
  await harness.postHandler(
    { body: { identity_group: FIXTURE_GROUP.identityGroup, values: { client_secret: "secret-2" } } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(harness.setManyCalls.length, 1);
  assert.deepEqual(harness.setManyCalls[0]?.values, { client_secret: "secret-2" });
});

test("POST allows omitting a field satisfied by env on first setup — never requires the DB to duplicate an env-configured value", async () => {
  const { postHandler, setManyCalls, satisfiedEnvAliases } = buildHarness();
  satisfiedEnvAliases.add("FIXTURE_CLIENT_ID");
  const res = fakeResponse();
  await postHandler(
    { body: { identity_group: FIXTURE_GROUP.identityGroup, values: { client_secret: "secret-1" } } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(setManyCalls.length, 1);
  assert.deepEqual(setManyCalls[0]?.values, { client_secret: "secret-1" });
});

test("POST with nothing to write (all fields already configured, none sent) is a no-op success, not an error", async () => {
  const harness = buildHarness();
  await harness.postHandler(
    {
      body: {
        identity_group: FIXTURE_GROUP.identityGroup,
        values: { client_id: "id-1", client_secret: "secret-1" },
      },
    },
    fakeResponse()
  );
  harness.setManyCalls.length = 0;

  const res = fakeResponse();
  await harness.postHandler({ body: { identity_group: FIXTURE_GROUP.identityGroup, values: {} } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(harness.setManyCalls.length, 0, "nothing changed, so no store write should occur");
});

test("POST on an unknown identity_group returns 404 before any validation of values", async () => {
  const { postHandler, setManyCalls } = buildHarness();
  await assert.rejects(
    () => postHandler({ body: { identity_group: "no-such-group", values: { client_id: "x" } } }, fakeResponse()),
    (err: unknown) => (err as { code: string }).code === "not_found"
  );
  assert.equal(setManyCalls.length, 0);
});

test("POST response never echoes a submitted value back", async () => {
  const { postHandler } = buildHarness();
  const res = fakeResponse();
  await postHandler(
    {
      body: {
        identity_group: FIXTURE_GROUP.identityGroup,
        values: { client_id: "id-1", client_secret: "super-secret-value" },
      },
    },
    res
  );
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("super-secret-value"), "POST response must never echo a submitted value");
  assert.ok(!serialized.includes("id-1"), "POST response must never echo a submitted value");
});
