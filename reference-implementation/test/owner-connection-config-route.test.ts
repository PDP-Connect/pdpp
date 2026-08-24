// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner connector-config routes
 * (server/routes/owner-connection-config.ts).
 *
 * The property these tests exist to protect is narrow and specific: the owner
 * subject used to CONFIRM a revision must come from the authenticated session,
 * never from the request body. If it could come from the body, then an agent
 * holding the owner's bearer token could propose a collection-shaping revision
 * and confirm it in the same breath, and the whole propose/confirm split -- the
 * correction from the adversarial design review -- would be decorative.
 *
 * Routes are exercised through the real mount function against a fake
 * express-shaped app, driving the REAL SQLite store, so the assertions cover
 * the adapter's auth handling, validation, error mapping, and response shape
 * rather than a mock's idea of them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedConnectorOptionsSchema } from "../../packages/polyfill-connectors/src/connector-options-schema.ts";
import { ConnectorOptionsSchemaError } from "../../packages/polyfill-connectors/src/connector-options-schema.ts";
import {
  platformOptionKind,
  resolveEnforcedOptionKind,
} from "../../packages/polyfill-connectors/src/connector-config-option-kind-registry.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { mountOwnerConnectionConfig } from "../server/routes/owner-connection-config.ts";
import { codeToStatus } from "../server/routes/ref-error-status.ts";
import { createSqliteConnectorInstanceConfigStore } from "../server/stores/connector-instance-config-store.ts";

const NOW = "2026-08-23T10:00:00.000Z";
const OWNER_SUBJECT_ID = "owner-1";
const OTHER_SUBJECT_ID = "owner-2";
const CONNECTION_ID = "cin_slack_1";

// ─── Fake app / req / res ───────────────────────────────────────────────────

interface CapturedResponse {
  body: unknown;
  status: number;
}

type Handler = (req: unknown, res: unknown) => unknown | Promise<unknown>;

class FakeApp {
  readonly routes = new Map<string, Handler>();

  private register(method: string, path: string, args: unknown[]): this {
    // The handler is always last; the middlewares before it (requireToken /
    // requireOwner) are asserted separately, not invoked here.
    this.routes.set(`${method} ${path}`, args.at(-1) as Handler);
    return this;
  }

  get(path: string, ...args: unknown[]): this {
    return this.register("GET", path, args);
  }

  post(path: string, ...args: unknown[]): this {
    return this.register("POST", path, args);
  }
}

function makeRes(): { captured: CapturedResponse; res: unknown } {
  const captured: CapturedResponse = { body: undefined, status: 200 };
  const res = {
    end: () => res,
    json: (body: unknown) => {
      captured.body = body;
      return res;
    },
    status: (code: number) => {
      captured.status = code;
      return res;
    },
  };
  return { captured, res };
}

function seedConnectorInstance(connectorInstanceId: string, ownerSubjectId = OWNER_SUBJECT_ID, connectorId = "slack") {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    connectorId,
    JSON.stringify({ connector_id: connectorId }),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(connectorInstanceId, ownerSubjectId, connectorId, connectorInstanceId, connectorInstanceId, NOW, NOW);
}

interface Harness {
  app: FakeApp;
  errors: { code: string; message: string; status: number }[];
  store: ReturnType<typeof createSqliteConnectorInstanceConfigStore>;
}

interface MountOptions {
  /** The connector key `resolveOwnerConnectorNamespace` reports for this connection. */
  readonly connectorKey?: string;
  /** Overrides the schema resolver seam; omit to drive the REAL manifest-backed one. */
  readonly connectorOptionsSchema?: (connectorKey: string) => ResolvedConnectorOptionsSchema | null;
}

/**
 * Mount the real routes with a ctx whose auth boundary is explicit: the
 * authenticated subject is whatever `getOwnerTokenSubjectId` returns from
 * `req.tokenInfo`, exactly as `server/index.ts` wires it.
 */
function mountHarness(authenticatedSubject = OWNER_SUBJECT_ID, mountOptions: MountOptions = {}): Harness {
  const app = new FakeApp();
  const errors: { code: string; message: string; status: number }[] = [];
  const store = createSqliteConnectorInstanceConfigStore();
  const connectorKey = mountOptions.connectorKey ?? "slack";
  mountOwnerConnectionConfig(app as never, {
    // Omitted unless a test overrides it, so the default path exercises the
    // REAL manifest-backed resolver rather than a mock's idea of it.
    ...(mountOptions.connectorOptionsSchema ? { connectorOptionsSchema: mountOptions.connectorOptionsSchema } : {}),
    getOwnerTokenSubjectId: (req) =>
      (req as { tokenInfo?: { subject_id?: string } }).tokenInfo?.subject_id ?? authenticatedSubject,
    handleError: (_res, err) => {
      errors.push({ code: "unhandled", message: err instanceof Error ? err.message : String(err), status: 500 });
    },
    now: () => new Date(NOW),
    pdppError: (_res, status, code, message) => {
      errors.push({ code, message, status });
    },
    requireOwner: "requireOwner",
    requireToken: "requireToken",
    resolveOwnerConnectorNamespace: (_req, _connectorId, options) =>
      Promise.resolve({
        connectorId: connectorKey,
        connectorInstanceId: options?.connectorInstanceId ?? CONNECTION_ID,
      }),
    store,
  });
  return { app, errors, store };
}

function withDb(fn: () => Promise<void> | void) {
  return async () => {
    initDb(":memory:");
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

async function call(
  harness: Harness,
  route: string,
  req: { body?: unknown; params?: Record<string, string>; tokenInfo?: Record<string, unknown> }
): Promise<CapturedResponse> {
  const handler = harness.app.routes.get(route);
  assert.ok(handler, `route not mounted: ${route}`);
  const { captured, res } = makeRes();
  await handler({ params: {}, ...req }, res);
  return captured;
}

const PROPOSE_ROUTE = "POST /v1/owner/connections/:connectionId/config/revisions";
const CONFIRM_ROUTE = "POST /v1/owner/connections/:connectionId/config/revisions/:revision/confirm";
const GET_ACTIVE_ROUTE = "GET /v1/owner/connections/:connectionId/config";
const LIST_ROUTE = "GET /v1/owner/connections/:connectionId/config/revisions";

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "expected an object response");
  return value as Record<string, unknown>;
}

// ─── Mounting / auth wiring ─────────────────────────────────────────────────

test("all four routes mount behind requireToken + requireOwner", () => {
  const app = new FakeApp();
  const seen: unknown[][] = [];
  const recording = {
    get: (path: string, ...args: unknown[]) => {
      seen.push([path, ...args]);
      return app.get(path, ...args);
    },
    post: (path: string, ...args: unknown[]) => {
      seen.push([path, ...args]);
      return app.post(path, ...args);
    },
  };
  mountOwnerConnectionConfig(
    recording as never,
    {
      getOwnerTokenSubjectId: () => OWNER_SUBJECT_ID,
      handleError: () => undefined,
      pdppError: () => undefined,
      requireOwner: "requireOwner",
      requireToken: "requireToken",
      resolveOwnerConnectorNamespace: () =>
        Promise.resolve({ connectorId: "slack", connectorInstanceId: CONNECTION_ID }),
      store: createSqliteConnectorInstanceConfigStore(),
    } as never
  );

  assert.equal(seen.length, 4, "propose, confirm, get-active, list-revisions");
  for (const [path, first, second] of seen) {
    assert.equal(first, "requireToken", `${path} must require a token`);
    assert.equal(second, "requireOwner", `${path} must require owner kind`);
  }
});

// ─── The load-bearing auth property ─────────────────────────────────────────

test(
  "ACCEPTANCE: confirm takes the owner subject from the SESSION -- a forged body owner subject is ignored",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID, OWNER_SUBJECT_ID);
    // The authenticated caller is NOT the connection owner.
    const harness = mountHarness(OTHER_SUBJECT_ID);

    const proposed = await harness.store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { CHANNEL_ALLOWLIST: ["C1"] },
      connectorInstanceId: CONNECTION_ID,
      provenance: {
        isExplicit: true,
        origin: "agent",
        setAt: NOW,
        setBy: "agent",
        sourceOfChange: "agent proposal",
      },
    });

    // The attacker supplies the real owner's id in the BODY, hoping the route
    // trusts it. It must not even be read.
    await call(harness, CONFIRM_ROUTE, {
      body: {
        authenticated_owner_subject_id: OWNER_SUBJECT_ID,
        authenticatedOwnerSubjectId: OWNER_SUBJECT_ID,
        confirmed_by: OWNER_SUBJECT_ID,
        owner_subject_id: OWNER_SUBJECT_ID,
      },
      params: { connectionId: CONNECTION_ID, revision: String(proposed.revision) },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OTHER_SUBJECT_ID },
    });

    assert.deepEqual(
      harness.errors.map((e) => ({ code: e.code, status: e.status })),
      [{ code: "connector_instance_owner_mismatch", status: 403 }],
      "the session subject, not the body, decides who may confirm"
    );

    // And the revision is still unconfirmed, so no run can pick it up.
    const stillProposed = await harness.store.getActiveRevision(CONNECTION_ID);
    assert.equal(stillProposed, null);
  })
);

test(
  "MUTATION PROOF: the same confirm call from the REAL owner's session succeeds",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID, OWNER_SUBJECT_ID);
    const harness = mountHarness(OWNER_SUBJECT_ID);
    const proposed = await harness.store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { CHANNEL_ALLOWLIST: ["C1"] },
      connectorInstanceId: CONNECTION_ID,
      provenance: {
        isExplicit: true,
        origin: "agent",
        setAt: NOW,
        setBy: "agent",
        sourceOfChange: "agent proposal",
      },
    });

    // No body at all -- proving the body was never the identity source.
    const res = await call(harness, CONFIRM_ROUTE, {
      params: { connectionId: CONNECTION_ID, revision: String(proposed.revision) },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    assert.deepEqual(harness.errors, []);
    const body = asRecord(res.body);
    assert.equal(body.status, "active");
    assert.equal(body.confirmed_by, OWNER_SUBJECT_ID);
    assert.equal(body.object, "connector_config_revision");

    const active = await harness.store.getActiveRevision(CONNECTION_ID);
    assert.deepEqual(active?.config, { CHANNEL_ALLOWLIST: ["C1"] });
  })
);

// ─── Propose ────────────────────────────────────────────────────────────────

test(
  "propose appends a collection_scope revision as PROPOSED and answers 201",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness();
    const res = await call(harness, PROPOSE_ROUTE, {
      body: {
        base_epoch: 1,
        base_revision: 0,
        config: { CHANNEL_ALLOWLIST: ["C1", "C2"] },
        source_of_change: "console: owner narrowed the allowlist",
      },
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    assert.deepEqual(harness.errors, []);
    assert.equal(res.status, 201);
    const body = asRecord(res.body);
    assert.equal(body.status, "proposed", "a collection_scope revision never self-activates");
    assert.equal(body.option_kind, "collection_scope");
    assert.equal(body.origin, "owner");
    assert.equal(body.set_by, OWNER_SUBJECT_ID);
    assert.equal(body.source_of_change, "console: owner narrowed the allowlist");
    // Still nothing in force.
    assert.equal(await harness.store.getActiveRevision(CONNECTION_ID), null);
  })
);

test(
  "a non-owner token records origin=agent -- a caller cannot label its own write 'owner'",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness();
    const res = await call(harness, PROPOSE_ROUTE, {
      body: {
        base_epoch: 1,
        base_revision: 0,
        config: { CHANNEL_ALLOWLIST: ["C1"] },
        // A forged attribution attempt in the body.
        origin: "owner",
        set_by: "owner",
        source_of_change: "agent write",
      },
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { client_id: "cli_abc", pdpp_token_kind: "client", subject_id: OWNER_SUBJECT_ID },
    });

    assert.deepEqual(harness.errors, []);
    const body = asRecord(res.body);
    assert.equal(body.origin, "agent", "origin is derived from the token kind, not the body");
    assert.equal(body.set_by, "client:cli_abc");
  })
);

test(
  "a stale base_revision maps ConfigStaleWriteError to 409, never a silent merge",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness();
    // Land an ACTIVE transport revision so the pointer advances to 1.
    await harness.store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { SKIP_FILES: true },
      connectorInstanceId: CONNECTION_ID,
      provenance: {
        isExplicit: true,
        origin: "owner",
        setAt: NOW,
        setBy: OWNER_SUBJECT_ID,
        sourceOfChange: "first write",
      },
    });

    // A second writer still believes the base is 0.
    await call(harness, PROPOSE_ROUTE, {
      body: {
        base_epoch: 1,
        base_revision: 0,
        config: { CHANNEL_ALLOWLIST: ["C1"] },
        source_of_change: "stale writer",
      },
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    assert.equal(harness.errors.length, 1);
    assert.equal(harness.errors[0]?.status, 409);
    assert.equal(harness.errors[0]?.code, "connector_instance_config_stale_write");
    assert.ok(
      (harness.errors[0]?.message ?? "").includes("rebase and retry, do not merge"),
      "the 409 must tell the caller to rebase rather than implying a merge happened"
    );
  })
);

test("the stale-write code is registered as 409 in the shared status table", () => {
  assert.equal(codeToStatus.connector_instance_config_stale_write, 409);
});

test(
  "propose rejects a body without base_revision rather than defaulting it",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness();
    await call(harness, PROPOSE_ROUTE, {
      body: { config: { CHANNEL_ALLOWLIST: ["C1"] }, source_of_change: "no base" },
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });
    assert.equal(harness.errors[0]?.status, 400);
    assert.equal(harness.errors[0]?.code, "invalid_request");
    assert.ok((harness.errors[0]?.message ?? "").includes("base_revision"));
  })
);

test(
  "propose rejects a body without source_of_change -- an unexplained revision is unattributed",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness();
    await call(harness, PROPOSE_ROUTE, {
      body: { base_epoch: 1, base_revision: 0, config: { CHANNEL_ALLOWLIST: ["C1"] } },
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });
    assert.equal(harness.errors[0]?.status, 400);
    assert.ok((harness.errors[0]?.message ?? "").includes("source_of_change"));
  })
);

// ─── Confirm error mapping ──────────────────────────────────────────────────

test(
  "confirming an already-active revision is a typed 409, not an opaque 500",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness(OWNER_SUBJECT_ID);
    const active = await harness.store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { SKIP_FILES: true },
      connectorInstanceId: CONNECTION_ID,
      provenance: {
        isExplicit: true,
        origin: "owner",
        setAt: NOW,
        setBy: OWNER_SUBJECT_ID,
        sourceOfChange: "transport",
      },
    });
    assert.equal(active.status, "active");

    await call(harness, CONFIRM_ROUTE, {
      params: { connectionId: CONNECTION_ID, revision: String(active.revision) },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });
    assert.equal(harness.errors[0]?.status, 409);
    assert.equal(harness.errors[0]?.code, "connector_instance_config_not_proposed");
  })
);

test(
  "confirming a revision that does not exist is a typed 404",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness(OWNER_SUBJECT_ID);
    await call(harness, CONFIRM_ROUTE, {
      params: { connectionId: CONNECTION_ID, revision: "99" },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });
    assert.equal(harness.errors[0]?.status, 404);
    assert.equal(harness.errors[0]?.code, "connector_instance_config_revision_not_found");
  })
);

test(
  "a non-integer revision path segment is rejected before the store is touched",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness(OWNER_SUBJECT_ID);
    await call(harness, CONFIRM_ROUTE, {
      params: { connectionId: CONNECTION_ID, revision: "not-a-number" },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });
    assert.equal(harness.errors[0]?.status, 400);
    assert.equal(harness.errors[0]?.code, "invalid_request");
  })
);

// ─── Reads ──────────────────────────────────────────────────────────────────

test(
  "GET config returns the active revision plus the base a propose must echo",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness();

    const empty = await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });
    const emptyBody = asRecord(empty.body);
    assert.equal(emptyBody.active_revision, null);
    assert.equal(emptyBody.base_revision, 0, "a first write must not have to guess its base");
    assert.equal(emptyBody.base_epoch, 1);
    assert.equal(emptyBody.current, null);

    await harness.store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { SKIP_FILES: true },
      connectorInstanceId: CONNECTION_ID,
      provenance: {
        isExplicit: true,
        origin: "owner",
        setAt: NOW,
        setBy: OWNER_SUBJECT_ID,
        sourceOfChange: "transport",
      },
    });

    const after = await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });
    const afterBody = asRecord(after.body);
    assert.equal(afterBody.base_revision, 1);
    assert.deepEqual(asRecord(afterBody.active_revision).config, { SKIP_FILES: true });
    assert.deepEqual(harness.errors, []);
  })
);

// ─── Options schema on the config read ──────────────────────────────────────
//
// The console renders its config form from this response. The properties under
// test are that the form can be built without inventing anything, and that a
// connector which has never described its options is reported as exactly that
// rather than as a connector with no options.

test(
  "GET config carries the REAL manifest-declared options schema for a connector that has one",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    // No resolver override: this drives the real slack.json manifest through
    // the real resolver, so the assertion covers the actual wiring.
    const harness = mountHarness();

    const res = await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    assert.deepEqual(harness.errors, []);
    const body = asRecord(res.body);
    assert.equal(body.options_schema_status, "declared");
    assert.equal(body.connector_key, "slack");

    const schema = asRecord(body.options_schema);
    assert.equal(schema.object, "connector_config_options_schema");
    assert.equal(schema.connector_key, "slack");

    const options = schema.options as Record<string, unknown>[];
    assert.ok(options.length > 0, "slack declares options; an empty form would be a rendering lie");

    // Every option carries what a form needs to render a control.
    const byKey = new Map(options.map((option) => [option.option_key as string, option]));
    const allowlist = byKey.get("CHANNEL_ALLOWLIST");
    assert.ok(allowlist, "CHANNEL_ALLOWLIST is declared in slack.json");
    assert.equal(allowlist.type, "string_array");
    assert.deepEqual(allowlist.default, []);
    assert.equal(typeof allowlist.description, "string");
  })
);

test(
  "GET config reports not_declared -- NOT an empty schema -- for a connector that has never described its options",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    // 42 of the 45 shipped manifests are in this state.
    const harness = mountHarness(OWNER_SUBJECT_ID, {
      connectorKey: "amazon",
      connectorOptionsSchema: () => null,
    });

    const res = await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    assert.deepEqual(harness.errors, []);
    const body = asRecord(res.body);
    assert.equal(
      body.options_schema_status,
      "not_declared",
      "an undeclared connector must be distinguishable from one declaring zero options"
    );
    assert.equal(body.options_schema, null);
    // The distinction is load-bearing: `null` alone would be indistinguishable
    // from an empty declared form, so the status must carry it.
    assert.notEqual(body.options_schema_status, "declared");
    // And the config ledger still reads normally -- an undeclared schema is not
    // an error condition.
    assert.equal(body.base_revision, 0);
    assert.equal(body.active_revision, null);
  })
);

test(
  "a connector declaring an EMPTY options schema is 'declared', not 'not_declared'",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    // The other side of the same coin: this connector really does say it has
    // no knobs. That is a claim the server may faithfully repeat.
    const harness = mountHarness(OWNER_SUBJECT_ID, {
      connectorOptionsSchema: () => ({
        connectorKey: "slack",
        description: "declares no knobs",
        options: [],
      }),
    });

    const res = await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    assert.deepEqual(harness.errors, []);
    const body = asRecord(res.body);
    assert.equal(body.options_schema_status, "declared");
    assert.deepEqual(asRecord(body.options_schema).options, []);
  })
);

test(
  "GUARDRAIL: a collection_scope option is never reported as self-activating",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    // Real manifest + real platform registry: slack declares both kinds.
    const harness = mountHarness();

    const res = await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    const options = asRecord(asRecord(res.body).options_schema).options as Record<string, unknown>[];
    assert.ok(options.length > 0);

    // Every option must carry BOTH guardrail facts, or a console cannot tell
    // the owner which changes need confirmation.
    for (const option of options) {
      assert.ok(
        option.option_kind === "collection_scope" || option.option_kind === "transport",
        `${String(option.option_key)} must carry a platform-enforced option_kind`
      );
      assert.equal(
        typeof option.platform_classified,
        "boolean",
        `${String(option.option_key)} must say whether the registry actually classified it`
      );
    }

    const byKey = new Map(options.map((option) => [option.option_key as string, option]));
    // CHANNEL_ALLOWLIST decides which channels are collected at all. If this
    // ever surfaced as `transport`, a console would let it self-activate and
    // silently widen the collection boundary without an owner confirm.
    assert.equal(
      byKey.get("CHANNEL_ALLOWLIST")?.option_kind,
      "collection_scope",
      "a collection-shaping knob must never be presented as self-activating"
    );
    assert.equal(byKey.get("LOOKBACK_DAYS")?.option_kind, "collection_scope");
    assert.equal(byKey.get("MEMBER_ONLY")?.option_kind, "collection_scope");
    // The registry does classify slack, so the fail-closed default is not what
    // is being observed here.
    assert.equal(byKey.get("CHANNEL_ALLOWLIST")?.platform_classified, true);
    // And a genuine transport knob is still reported as transport, so the
    // assertion above is not passing merely because everything says
    // collection_scope.
    assert.equal(byKey.get("SKIP_FILES")?.option_kind, "transport");
  })
);

test(
  "an unregistered connector's options fail CLOSED to collection_scope and say the registry never classified them",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    // A connector the platform registry has never classified. The safe
    // direction: every field requires an owner confirm, and
    // `platform_classified: false` says so out loud.
    //
    // This originally used `claude-code`, whose manifest declares options while
    // the registry keyed it `claude_code` — so the hyphenated canonical key
    // missed and the fixture was "unregistered" only by accident. `cb29060b0`
    // normalized the lookup, which is what SHOULD happen for a real connector,
    // and correctly broke that fixture. The invariant under test is unchanged;
    // it now needs a connector genuinely absent from the registry.
    //
    // `notion` is such a connector, but it declares no options_schema, so the
    // shape is injected here while the KIND still resolves through the real
    // registry — which is the rule under test.
    const harness = mountHarness(OWNER_SUBJECT_ID, {
      connectorKey: "notion",
      connectorOptionsSchema: (connectorKey: string) => ({
        connectorKey,
        options: [
          {
            name: "NOTION_PAGE_ALLOWLIST",
            type: "string_array" as const,
            default: [],
            description: "Pages to collect.",
            optionKind: resolveEnforcedOptionKind(connectorKey, "NOTION_PAGE_ALLOWLIST"),
            platformClassified: platformOptionKind(connectorKey, "NOTION_PAGE_ALLOWLIST") !== null,
          },
        ],
      }),
    });

    const res = await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    assert.deepEqual(harness.errors, []);
    const body = asRecord(res.body);
    assert.equal(body.options_schema_status, "declared");
    const options = asRecord(body.options_schema).options as Record<string, unknown>[];
    assert.ok(options.length > 0);
    for (const option of options) {
      assert.equal(option.option_kind, "collection_scope", "an unclassified key must fail closed");
      assert.equal(option.platform_classified, false, "and must not claim the platform classified it");
    }
  })
);

test(
  "a malformed options_schema is a typed 400, not an opaque 500 and not an empty form",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness(OWNER_SUBJECT_ID, {
      connectorOptionsSchema: () => {
        throw new ConnectorOptionsSchemaError("slack.json: options_schema.properties must be an object");
      },
    });

    const res = await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    assert.equal(harness.errors.length, 1);
    assert.equal(harness.errors[0]?.status, 400);
    assert.equal(harness.errors[0]?.code, "connector_invalid");
    assert.equal(codeToStatus.connector_invalid, 400, "the code must be registered in the shared status table");
    // No body was emitted: a broken manifest must not degrade into a form.
    assert.equal(res.body, undefined);
    assert.notEqual(harness.errors[0]?.code, "unhandled");
  })
);

test(
  "an unexpected resolver failure is NOT swallowed as a 400",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness(OWNER_SUBJECT_ID, {
      connectorOptionsSchema: () => {
        throw new Error("disk exploded");
      },
    });

    await call(harness, GET_ACTIVE_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });

    // Only ConnectorOptionsSchemaError is classified; anything else keeps its
    // own handling rather than being mislabelled a manifest defect.
    assert.equal(harness.errors[0]?.code, "unhandled");
    assert.ok((harness.errors[0]?.message ?? "").includes("disk exploded"));
  })
);

test(
  "GET config/revisions lists the whole ledger newest-first, including proposed ones",
  withDb(async () => {
    seedConnectorInstance(CONNECTION_ID);
    const harness = mountHarness();
    await harness.store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { CHANNEL_ALLOWLIST: ["C1"] },
      connectorInstanceId: CONNECTION_ID,
      provenance: {
        isExplicit: true,
        origin: "agent",
        setAt: NOW,
        setBy: "agent",
        sourceOfChange: "first proposal",
      },
    });

    const res = await call(harness, LIST_ROUTE, {
      params: { connectionId: CONNECTION_ID },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    });
    const body = asRecord(res.body);
    assert.equal(body.object, "list");
    const data = body.data as Record<string, unknown>[];
    assert.equal(data.length, 1);
    assert.equal(data[0]?.status, "proposed");
    assert.equal(data[0]?.source_of_change, "first proposal");
    assert.deepEqual(harness.errors, []);
  })
);
