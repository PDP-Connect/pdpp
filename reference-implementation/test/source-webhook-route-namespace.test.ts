// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { SourceWebhookError } from "../operations/ref-source-webhook-ingest/index.ts";
import { type MountRefSourceWebhooksContext, mountRefSourceWebhooks } from "../server/routes/source-webhooks.ts";

const SECRET = "webhook-secret";

type Handler = Parameters<Parameters<typeof mountRefSourceWebhooks>[0]["post"]>[1];

function sign(eventId: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(`${eventId}.${timestamp}.${body}`).digest("hex")}`;
}

function makeResponse() {
  const out: { body?: unknown; statusCode?: number } = {};
  return {
    out,
    res: {
      json(body: unknown) {
        out.body = body;
      },
      status(code: number) {
        out.statusCode = code;
        return this;
      },
    },
  };
}

function mountHandler(ctx: MountRefSourceWebhooksContext): Handler {
  let handler: Handler | null = null;
  mountRefSourceWebhooks(
    {
      post(_path, registered) {
        handler = registered;
        return this;
      },
    },
    ctx
  );
  assert.ok(handler);
  return handler;
}

function makeContext(overrides: Partial<MountRefSourceWebhooksContext> = {}): MountRefSourceWebhooksContext {
  return {
    controller: null,
    getManifestRefreshPolicy: () => ({}),
    getSchedulerStore: () => ({
      upsertLastRunTime: () => undefined,
    }),
    getSourceWebhookEventStore: () => ({
      claimEvent: () => true,
    }),
    handleError: (_res, err) => {
      throw err;
    },
    ingestRecord: () => undefined,
    ownerSubjectId: "owner_custom",
    parseSourceWebhookSecrets: () =>
      new Map([
        [
          "source-second",
          {
            connectorId: "gmail",
            connectorInstanceId: "cin_gmail_owner_custom_second",
            ownerSubjectId: "owner_custom",
            secret: SECRET,
          },
        ],
      ]),
    pdppError: (res, status, code, message) =>
      (res as ReturnType<typeof makeResponse>["res"]).status(status).json({ error: { code, message } }),
    projectRunAutomationPolicy: ({ triggerKind }) => ({ allowed_to_start: true, trigger_kind: triggerKind }),
    resolveRegisteredConnectorManifest: async () => ({ streams: [{ name: "messages" }] }),
    resolveSourceWebhookTarget: ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
      connectorId,
      connectorInstanceId: connectorInstanceId || "cin_gmail_owner_custom_default",
      ownerSubjectId,
    }),
    ...overrides,
  };
}

async function post(handler: Handler, sourceId: string, eventId: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { out, res } = makeResponse();
  await handler(
    {
      body,
      headers: {
        "pdpp-webhook-event-id": eventId,
        "pdpp-webhook-signature": sign(eventId, timestamp, body),
        "pdpp-webhook-timestamp": timestamp,
      },
      params: { sourceId },
    },
    res
  );
  return out;
}

test("source webhook route ingests into the configured owner connection with admission", async () => {
  const writes: Array<{
    options: { requireConnectionAdmission: true };
    target: { connector_id: string; connector_instance_id: string };
  }> = [];
  const handler = mountHandler(
    makeContext({
      ingestRecord: (target, _record, options) => {
        writes.push({ options, target });
      },
    })
  );
  const body = JSON.stringify({
    action: "ingest_records",
    records: [{ data: { id: "m1" }, key: "m1" }],
    stream: "messages",
  });

  const out = await post(handler, "source-second", "evt-ingest-second", body);

  assert.equal(out.statusCode, 200);
  assert.deepEqual(writes, [
    {
      options: { requireConnectionAdmission: true },
      target: { connector_id: "gmail", connector_instance_id: "cin_gmail_owner_custom_second" },
    },
  ]);
});

test("source webhook route passes the configured owner connection to runNow", async () => {
  let captured:
    | {
        connectorId: string;
        connectorInstanceId?: string;
        ownerSubjectId?: string;
        triggerKind?: string;
      }
    | undefined;
  const handler = mountHandler(
    makeContext({
      controller: {
        runNow: (connectorId, options) => {
          captured = {
            connectorId,
            connectorInstanceId: options.connectorInstanceId,
            ownerSubjectId: options.ownerSubjectId,
            triggerKind: options.triggerKind,
          };
          return { run_id: "run_webhook", status: "started", trace_id: "trc_webhook", trigger_kind: "webhook" };
        },
      },
    })
  );

  const out = await post(handler, "source-second", "evt-run-second", '{"action":"schedule_run"}');

  assert.equal(out.statusCode, 200);
  assert.deepEqual(captured, {
    connectorId: "gmail",
    connectorInstanceId: "cin_gmail_owner_custom_second",
    ownerSubjectId: "owner_custom",
    triggerKind: "webhook",
  });
});

test("source webhook route scheduler fallback is instance scoped", async () => {
  let captured:
    | { connectorId: string | undefined; connectorInstanceId: string; timestampIso: string; timestampMs: number }
    | undefined;
  const handler = mountHandler(
    makeContext({
      getSchedulerStore: () => ({
        upsertLastRunTime: (connectorInstanceId, timestampMs, timestampIso, connectorId) => {
          captured = { connectorId, connectorInstanceId, timestampIso, timestampMs };
        },
      }),
    })
  );

  const out = await post(handler, "source-second", "evt-schedule-second", '{"action":"schedule_run"}');

  assert.equal(out.statusCode, 200);
  assert.ok(captured);
  assert.equal(captured.connectorId, "gmail");
  assert.equal(captured.connectorInstanceId, "cin_gmail_owner_custom_second");
});

for (const rejection of [
  {
    code: "invalid_source_target",
    eventId: "evt-missing-before-claim",
    message: "source target is missing",
    name: "missing",
    status: 404,
  },
  {
    code: "invalid_source_target",
    eventId: "evt-revoked-before-claim",
    message: "source target is revoked or wrong-owner",
    name: "revoked/wrong-owner",
    status: 404,
  },
  {
    code: "ambiguous_source_target",
    eventId: "evt-ambiguous-before-claim",
    message: "source target is ambiguous",
    name: "ambiguous",
    status: 409,
  },
] as const) {
  test(`source webhook route rejects ${rejection.name} targets before claim or mutation`, async () => {
    let claimed = false;
    let mutated = false;
    const handler = mountHandler(
      makeContext({
        getSourceWebhookEventStore: () => ({
          claimEvent: () => {
            claimed = true;
            return true;
          },
        }),
        ingestRecord: () => {
          mutated = true;
        },
        resolveSourceWebhookTarget: () => {
          throw new SourceWebhookError(rejection.code, rejection.message, rejection.status);
        },
      })
    );
    const body = JSON.stringify({
      action: "ingest_records",
      records: [{ data: { id: "m1" }, key: "m1" }],
      stream: "messages",
    });

    const out = await post(handler, "source-second", rejection.eventId, body);

    assert.equal(out.statusCode, rejection.status);
    assert.equal(claimed, false);
    assert.equal(mutated, false);
    assert.deepEqual(out.body, {
      error: { code: rejection.code, message: rejection.message },
    });
  });
}
