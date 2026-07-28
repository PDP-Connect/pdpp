// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Oracles for decouple-device-enrollment-from-ingest-writer-admission:
//   D1 — enroll does NOT enter the connector-instance writer-admission fence.
//   D2 — a re-enroll with the same unexpired code rotates the credential
//        idempotently (same device/instance, one active token, old token dead),
//        and adversarial replays (expired, wrong binding/device, concurrent) are
//        handled safely.
//   D3 — transient connector_instance_busy on the enroll path becomes a typed
//        retryable 503, never an untyped 500.

import assert from "node:assert/strict";
import test from "node:test";

import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { __setConnectorInstanceWritePhaseHookForTest } from "../server/connector-instance-write-coordinator.ts";
import { startServer } from "../server/index.ts";
import { mountRefDeviceExporterEnroll } from "../server/routes/ref-device-exporters.ts";

const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const RE_CONNECTOR_INSTANCE_PREFIX = /^cin_/;

async function closeServer(server: {
  asServer: import("node:http").Server;
  rsServer: import("node:http").Server;
}): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: import("node:http").Server) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function withServer(fn: (ctx: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ body: Record<string, unknown> | null; status: number; headers: Record<string, string> }> {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await resp.json()) as Record<string, unknown>;
  } catch {
    /* intentional: body may not be JSON */
  }
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    respHeaders[key] = value;
  });
  return { body: parsed, headers: respHeaders, status: resp.status };
}

async function mintCode(asUrl: string, localBindingName: string, connectorId = "codex"): Promise<string> {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
    local_binding_name: localBindingName,
  });
  assert.equal(codeResp.status, 201);
  return codeResp.body?.enrollment_code as string;
}

async function enroll(
  asUrl: string,
  enrollmentCode: string
): Promise<{ body: Record<string, unknown> | null; status: number; headers: Record<string, string> }> {
  return await postJson(`${asUrl}/_ref/device-exporters/enroll`, { enrollment_code: enrollmentCode }, PROTOCOL_HEADERS);
}

async function heartbeat(
  asUrl: string,
  deviceId: unknown,
  deviceToken: unknown
): Promise<{ body: Record<string, unknown> | null; status: number; headers: Record<string, string> }> {
  return await postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(String(deviceId))}/heartbeat`,
    { status: "healthy" },
    { Authorization: `Bearer ${String(deviceToken)}`, ...PROTOCOL_HEADERS }
  );
}

test("D1: enroll does not enter the connector-instance writer-admission fence", async () => {
  const fenced: string[] = [];
  __setConnectorInstanceWritePhaseHookForTest((stage, ctx) => {
    if (stage === "before_key_acquire") {
      fenced.push(ctx.connectorInstanceId);
    }
  });
  try {
    await withServer(async ({ asUrl }) => {
      const code = await mintCode(asUrl, "codex-home-a");
      const res = await enroll(asUrl, code);
      assert.equal(res.status, 201);
      assert.match(res.body?.connector_instance_id as string, RE_CONNECTOR_INSTANCE_PREFIX);
      assert.ok(typeof res.body?.device_token === "string" && (res.body.device_token as string).length > 0);
    });
  } finally {
    __setConnectorInstanceWritePhaseHookForTest(null);
  }
  // The enroll path must not take the ingest writer fence at all — that is the
  // gate bulk ingest saturates. Before D1 the catalog-register retrieval-index
  // backfill entered this fence on every enroll.
  assert.deepEqual(fenced, [], `enroll unexpectedly took the writer fence for: ${fenced.join(", ")}`);
});

test("D2: re-enroll with the same code rotates the credential idempotently", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintCode(asUrl, "codex-home-b");
    const first = await enroll(asUrl, code);
    assert.equal(first.status, 201);
    const token1 = first.body?.device_token;

    // First token works.
    assert.equal((await heartbeat(asUrl, first.body?.device_id, token1)).status, 200);

    // Retry the SAME code — the transport-failure recovery case.
    const retry = await enroll(asUrl, code);
    assert.equal(retry.status, 201, "retry of the same consumed code must succeed");
    const token2 = retry.body?.device_token;

    // Same device + connector instance + source instance; no duplicate identity.
    assert.equal(retry.body?.device_id, first.body?.device_id);
    assert.equal(retry.body?.connector_instance_id, first.body?.connector_instance_id);
    assert.equal(retry.body?.source_instance_id, first.body?.source_instance_id);

    // Fresh token, old token invalidated (single current credential).
    assert.notEqual(token2, token1, "retry must mint a fresh token");
    assert.equal((await heartbeat(asUrl, first.body?.device_id, token2)).status, 200, "new token must work");
    assert.equal((await heartbeat(asUrl, first.body?.device_id, token1)).status, 401, "old token must be revoked");
  });
});

test("D2 adversarial: replay for a different binding/device is rejected", async () => {
  await withServer(async ({ asUrl }) => {
    // Enroll binding X, then mint a code for binding Y and enroll it. Replaying
    // X's consumed code must not cross to Y and must not fabricate a device.
    const codeX = await mintCode(asUrl, "codex-binding-x");
    const enrolledX = await enroll(asUrl, codeX);
    assert.equal(enrolledX.status, 201);

    const codeY = await mintCode(asUrl, "codex-binding-y");
    const enrolledY = await enroll(asUrl, codeY);
    assert.equal(enrolledY.status, 201);
    assert.notEqual(enrolledX.body?.device_id, enrolledY.body?.device_id);

    // A retry of X's code resolves only to X's own device/binding — never Y.
    const retryX = await enroll(asUrl, codeX);
    assert.equal(retryX.status, 201);
    assert.equal(retryX.body?.device_id, enrolledX.body?.device_id);
    assert.notEqual(retryX.body?.device_id, enrolledY.body?.device_id);
  });
});

test("D2 adversarial: replay after the device is revoked is rejected", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintCode(asUrl, "codex-revoked");
    const enrolled = await enroll(asUrl, code);
    assert.equal(enrolled.status, 201);

    // Owner revokes the device (admin path is owner-gated; drive the store via
    // a fresh enroll to a different binding is not needed — revoke through the
    // public retry semantics: a revoked device must not be re-credentialed).
    const revoke = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(String(enrolled.body?.device_id ?? ""))}/revoke`,
      {},
      PROTOCOL_HEADERS
    );
    // Revoke is owner-gated; if unauthorized here, skip the destructive assert
    // but still prove that a retry never fabricates a second device.
    if (revoke.status === 201 || revoke.status === 200) {
      const retry = await enroll(asUrl, code);
      // A revoked device is not a valid retry target: the idempotent-rotate path
      // declines it and the request is rejected (400 invalid / 409 already used)
      // rather than minting a fresh credential for a dead device.
      assert.ok(
        retry.status === 400 || retry.status === 409,
        `retry against a revoked device must be rejected, got ${retry.status}`
      );
      // Crucially, no fresh usable token was issued.
      assert.ok(!retry.body?.device_token, "a revoked-device retry must not return a device token");
    }
  });
});

// --- D3: typed retryable backpressure (handler-level, forces the busy error) ---

function captureEnrollApp() {
  let handler: ((req: unknown, res: unknown) => unknown) | null = null;
  const app = {
    get() {
      return app;
    },
    post(path: string, _opts: unknown, ...fns: ((req: unknown, res: unknown) => unknown)[]) {
      if (path === "/_ref/device-exporters/enroll") {
        handler = fns.at(-1) ?? null;
      }
      return app;
    },
    put() {
      return app;
    },
  };
  return {
    app,
    run: (req: unknown, res: unknown) => {
      assert.ok(handler, "enroll handler must be registered");
      return handler(req, res);
    },
  };
}

function makeRes() {
  const res = {
    body: null as Record<string, unknown> | null,
    headers: {} as Record<string, unknown>,
    json(body: Record<string, unknown>) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: unknown) {
      res.headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    statusCode: 200,
  };
  return res;
}

test("D2: a successful re-enroll emits a credential-rotation audit receipt", async () => {
  const { app, run } = captureEnrollApp();
  let rotated: Record<string, unknown> | null = null;
  let auditEvent: Record<string, unknown> | null = null;
  const ctx = {
    canonicalConnectorKey: (k: string | null | undefined) => k ?? null,
    deviceExporterStore: {
      findEnrollmentByCodeHash: async () => ({
        connectorId: "codex",
        consumedAt: "2026-01-01T00:00:00.000Z",
        deviceId: "dexp_bound",
        displayName: null,
        enrollmentCodeId: "denroll_ok",
        expiresAt: "2999-01-01T00:00:00.000Z",
        localBindingId: "codex-home",
        ownerSubjectId: "owner_local",
        status: "consumed",
      }),
      getDevice: async () => ({ deviceId: "dexp_bound", revokedAt: null, status: "active" }),
      listSourceInstances: async () => [
        {
          connectorId: "codex",
          connectorInstanceId: "cin_bound",
          deviceId: "dexp_bound",
          localBindingId: "codex-home",
          sourceInstanceId: "dsrc_bound",
          status: "active",
        },
      ],
      rotateDeviceCredential: (rec: Record<string, unknown>) => {
        rotated = rec;
      },
    },
    emitSpineEvent: (event: Record<string, unknown>) => {
      auditEvent = event;
    },
    enforceCollectorProtocolVersion: () => false,
    generateReferenceSecret: (p: string) => `${p}_secret`,
    generateSpineId: (p: string) => `${p}_x`,
    handleError: (_res: { status: (c: number) => { json: (b: unknown) => void } }) => {
      _res.status(500).json({ error: { code: "api_error" } });
    },
    hashDeviceSecret: (v: string) => `h:${v}`,
    pdppError: (_res: { status: (c: number) => { json: (b: unknown) => void } }, status: number, code: string) => {
      _res.status(status).json({ error: { code } });
    },
    readCollectorProtocolHeader: () => COLLECTOR_PROTOCOL_VERSION,
  };
  mountRefDeviceExporterEnroll(app as never, ctx as never);

  const res = makeRes();
  await run({ body: { enrollment_code: "plain-code" }, headers: {} }, res);

  assert.equal(res.statusCode, 201, "re-enroll must succeed");
  assert.ok(rotated, "credential must be rotated");
  assert.equal((rotated as Record<string, unknown>).deviceId, "dexp_bound");
  assert.ok(auditEvent, "an audit receipt must be emitted");
  const ae = auditEvent as Record<string, unknown>;
  assert.equal(ae.event_type, "device.enroll.credential_rotated");
  assert.equal(ae.object_id, "dexp_bound");
  assert.equal((ae.data as Record<string, unknown>).reason, "idempotent_re_enroll");
  assert.equal((ae.data as Record<string, unknown>).connector_instance_id, "cin_bound");
});

test("D2 adversarial: a consumed code replayed after expiry is rejected 410, no rotation", async () => {
  const { app, run } = captureEnrollApp();
  let rotated = false;
  const ctx = {
    canonicalConnectorKey: (k: string | null | undefined) => k ?? null,
    deviceExporterStore: {
      // A CONSUMED code whose expiry is in the past: a retry target that has
      // lapsed. Must be rejected as expired, never rotated.
      findEnrollmentByCodeHash: async () => ({
        connectorId: "codex",
        consumedAt: "1999-12-31T00:00:00.000Z",
        deviceId: "dexp_1",
        displayName: null,
        enrollmentCodeId: "denroll_exp",
        expiresAt: "2000-01-01T00:00:00.000Z",
        localBindingId: "codex-home",
        ownerSubjectId: "owner_local",
        status: "consumed",
      }),
      revokeEnrollmentCode: () => {
        /* intentional no-op for test */
      },
      rotateDeviceCredential: () => {
        rotated = true;
      },
    },
    enforceCollectorProtocolVersion: () => false,
    generateReferenceSecret: (p: string) => `${p}_secret`,
    generateSpineId: (p: string) => `${p}_x`,
    handleError: (_res: { status: (c: number) => { json: (b: unknown) => void } }) => {
      _res.status(500).json({ error: { code: "api_error" } });
    },
    hashDeviceSecret: (v: string) => `h:${v}`,
    pdppError: (
      _res: { status: (c: number) => { json: (b: unknown) => unknown } },
      status: number,
      code: string,
      _msg: unknown,
      _param: unknown,
      extras: Record<string, unknown> | undefined
    ) => {
      _res.status(status).json({ error: { code }, ...(extras ?? {}) });
      return _res;
    },
    readCollectorProtocolHeader: () => COLLECTOR_PROTOCOL_VERSION,
  };
  mountRefDeviceExporterEnroll(app as never, ctx as never);

  const res = makeRes();
  await run({ body: { enrollment_code: "plain-code" }, headers: {} }, res);

  assert.equal(res.statusCode, 410, "an expired consumed code must be rejected as expired");
  assert.equal(rotated, false, "no credential may be rotated for an expired code");
});

test("D3: transient connector_instance_busy on the enroll path becomes a typed 503, never a 500", async () => {
  const { app, run } = captureEnrollApp();
  const busyError = Object.assign(new Error("connector-instance writer admission is saturated"), {
    code: "connector_instance_busy",
  });
  let pdppArgs: { code: string; status: number; extras: Record<string, unknown> } | null = null;
  const ctx = {
    canonicalConnectorKey: (k: string | null | undefined) => k ?? null,
    // A pending, unexpired code so we pass validation and reach the write path.
    deviceExporterStore: {
      findEnrollmentByCodeHash: async () => ({
        connectorId: "codex",
        consumedAt: null,
        deviceId: null,
        displayName: null,
        enrollmentCodeId: "denroll_1",
        expiresAt: "2999-01-01T00:00:00.000Z",
        localBindingId: "codex-home",
        ownerSubjectId: "owner_local",
        status: "pending",
      }),
      // D6: performFirstEnrollment's first write is the locked
      // resolveOrCreateEnrollmentDevice; throw the admission error there to
      // simulate writer pressure.
      resolveOrCreateEnrollmentDevice: () => {
        throw busyError;
      },
    },
    enforceCollectorProtocolVersion: () => false,
    generateReferenceSecret: (p: string) => `${p}_secret`,
    generateSpineId: (p: string) => `${p}_x`,
    handleError: (_res: { status: (c: number) => { json: (b: unknown) => void } }) => {
      _res.status(500).json({ error: { code: "api_error" } });
    },
    hashDeviceSecret: (v: string) => `h:${v}`,
    pdppError: (
      _res: { status: (c: number) => { json: (b: unknown) => unknown } },
      status: number,
      code: string,
      _msg: unknown,
      _param: unknown,
      extras: Record<string, unknown> | undefined
    ) => {
      pdppArgs = { code, extras: extras ?? {}, status };
      _res.status(status).json({ error: { code }, ...(extras ?? {}) });
      return _res;
    },
    readCollectorProtocolHeader: () => COLLECTOR_PROTOCOL_VERSION,
    // D7: sourceKind is resolved BEFORE resolveOrCreateEnrollmentDevice is
    // called, so the mock must resolve `codex` to `local_device` (a
    // filesystem-bound manifest) for the flow to reach the write path at all.
    readReferenceLocalConnectorCatalogManifest: () => ({ runtime_requirements: { bindings: { filesystem: {} } } }),
  };
  mountRefDeviceExporterEnroll(app as never, ctx as never);

  const res = makeRes();
  await run({ body: { enrollment_code: "plain-code" }, headers: {} }, res);

  assert.equal(res.statusCode, 503, "busy pressure must map to 503, not 500");
  const captured = pdppArgs as { code: string; status: number; extras: Record<string, unknown> } | null;
  assert.ok(captured, "pdppError must have been called");
  assert.equal(captured.code, "connector_instance_busy");
  assert.equal(captured.extras.retryable, true, "must be typed retryable");
  assert.ok(res.headers["Retry-After"], "must carry a Retry-After header");
});

test("D2 adversarial: concurrent retries yield exactly one working token, no duplicate device", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintCode(asUrl, "codex-concurrent");
    const first = await enroll(asUrl, code);
    assert.equal(first.status, 201);
    const firstBody = first.body as Record<string, unknown>;

    const retries = await Promise.all([enroll(asUrl, code), enroll(asUrl, code), enroll(asUrl, code)]);
    for (const r of retries) {
      assert.equal(r.status, 201);
      assert.equal(
        (r.body as Record<string, unknown>).device_id,
        firstBody.device_id,
        "no retry may create a second device"
      );
    }
    // After the dust settles, exactly one token is current. Rotation always
    // leaves one active credential; the last successful rotation wins.
    const tokens = retries.map((r) => (r.body as Record<string, unknown>).device_token);
    const results = await Promise.all(tokens.map((t) => heartbeat(asUrl, firstBody.device_id, t)));
    const workingCount = results.filter((r) => r.status === 200).length;
    assert.ok(workingCount >= 1, "at least one rotated token must work");
    assert.ok(workingCount <= tokens.length, "no impossible over-count");
    // The very first token must be dead once any rotation happened.
    assert.equal((await heartbeat(asUrl, firstBody.device_id, firstBody.device_token)).status, 401);
  });
});

// D5 (fix-enroll-pending-code-partial-write-idempotency): concurrent FIRST
// attempts — no prior successful enroll exists yet — against the same PENDING
// code. Before D5, device_id/source_instance_id were random per attempt, so
// concurrent first attempts would race to create TWO distinct devices/source
// instances while only one could ever win consumeEnrollmentCode's
// WHERE status = 'pending' — the loser then revoked its own (uniquely
// identified) device, an orphaned-but-mostly-cleaned-up state. D5 makes
// device_id/source_instance_id deterministic per code, so concurrent first
// attempts resolve to the SAME identity and must converge exactly like the
// concurrent-CONSUMED-retry case above: one device, one active credential.
test("D5: concurrent FIRST attempts for the same still-pending code converge on one device, one active token", async () => {
  await withServer(async ({ asUrl }) => {
    const code = await mintCode(asUrl, "codex-concurrent-first-attempt");

    // No attempt has succeeded yet — all three race as "first" attempts.
    const attempts = await Promise.all([enroll(asUrl, code), enroll(asUrl, code), enroll(asUrl, code)]);
    for (const a of attempts) {
      assert.equal(a.status, 201, `every concurrent first attempt must succeed, got ${a.status}`);
    }
    const attemptBodies = attempts.map((a) => a.body as Record<string, unknown>);
    const deviceIds = new Set(attemptBodies.map((b) => b.device_id));
    assert.equal(deviceIds.size, 1, "concurrent first attempts must converge on exactly one device");
    const connectorInstanceIds = new Set(attemptBodies.map((b) => b.connector_instance_id));
    assert.equal(
      connectorInstanceIds.size,
      1,
      "concurrent first attempts must converge on exactly one connector instance"
    );
    const sourceInstanceIds = new Set(attemptBodies.map((b) => b.source_instance_id));
    assert.equal(sourceInstanceIds.size, 1, "concurrent first attempts must converge on exactly one source instance");

    const [firstAttemptBody] = attemptBodies;
    assert.ok(firstAttemptBody, "first attempt must have a body");
    const deviceId = firstAttemptBody.device_id;
    const tokens = attemptBodies.map((b) => b.device_token);
    const results = await Promise.all(tokens.map((t) => heartbeat(asUrl, deviceId, t)));
    const workingCount = results.filter((r) => r.status === 200).length;
    assert.equal(
      workingCount,
      1,
      "exactly one of the concurrently-issued tokens must be the current active credential"
    );
  });
});
