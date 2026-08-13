// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the reference-only `POST /_ref/source-webhooks/:sourceId`
// ingress route.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§5.3). This is NOT a PDPP
// protocol endpoint. It accepts source-specific signed callbacks (HMAC-signed
// via per-source secret) and maps them into existing ingest and scheduler
// semantics through the canonical `ref.source-webhook.ingest` and
// `rs.records.ingest` operations.
//
// The signed-callback posture is intentional: this route authenticates via
// `pdpp-webhook-{timestamp,event-id,signature}` headers, not owner or client
// session middleware. The adapter MUST NOT add bearer or session checks.

import {
  executeSourceWebhook,
  SOURCE_WEBHOOK_MAX_BODY_BYTES,
  SourceWebhookError,
  type SourceWebhookResult,
} from "../../operations/ref-source-webhook-ingest/index.ts";
import { executeRecordsIngest } from "../../operations/rs-records-ingest/index.ts";
import { ControllerError, type RunNowResult, type SourceWebhookRunEvent } from "../../runtime/controller.ts";

interface RouteRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: { readonly sourceId: string };
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface RouteOptions {
  readonly bodyLimit?: number;
}

interface AppLike {
  post: (path: string, options: RouteOptions, handler: RouteHandler) => AppLike;
}

export interface SourceWebhookSecret {
  readonly connectorId: string;
  readonly connectorInstanceId?: string | null;
  readonly ownerSubjectId?: string | null;
  readonly secret: string;
}

export type SourceWebhookSecretsMap = ReadonlyMap<string, SourceWebhookSecret>;

interface ConnectorManifestLike {
  readonly streams?: ReadonlyArray<{ readonly name: string }> | null;
}

export interface SourceWebhookSchedulerStore {
  upsertLastRunTime: (
    connectorInstanceId: string,
    timestampMs: number,
    timestampIso: string,
    connectorId?: string
  ) => unknown | Promise<unknown>;
}

export interface SourceWebhookEventStoreLike {
  claimEvent: (event: {
    readonly sourceId: string;
    readonly eventId: string;
    readonly bodyHash: string;
    readonly receivedAt: string;
  }) => boolean | Promise<boolean>;
}

export interface SourceWebhookController {
  runNow: (
    connectorId: string,
    input: {
      readonly connectorInstanceId: string;
      readonly manifest: ConnectorManifestLike;
      readonly ownerSubjectId: string;
      readonly priorityClass: "background";
      readonly sourceWebhookEvent: SourceWebhookRunEvent;
      readonly triggerKind: "webhook";
    }
  ) => RunNowResult | Promise<RunNowResult>;
}

export interface SourceWebhookAutomationPolicy {
  readonly allowed_to_start?: boolean;
  readonly automation_mode?: string;
  readonly reason?: string | null;
  readonly trigger_kind: "webhook";
}

export interface MountRefSourceWebhooksContext {
  readonly controller: SourceWebhookController | null | undefined;
  getManifestRefreshPolicy: (manifest: ConnectorManifestLike) => unknown;
  getSchedulerStore: () => SourceWebhookSchedulerStore;
  getSourceWebhookEventStore: () => SourceWebhookEventStoreLike;
  handleError: (res: unknown, err: unknown) => void;
  ingestRecord: (
    target: { connector_id: string; connector_instance_id: string },
    record: Record<string, unknown>,
    options: { requireConnectionAdmission: true }
  ) => unknown | Promise<unknown>;
  readonly ownerSubjectId: string;
  parseSourceWebhookSecrets: () => SourceWebhookSecretsMap;
  pdppError: (res: unknown, status: number, code: string, message: string | undefined) => unknown;
  projectRunAutomationPolicy: (input: {
    readonly triggerKind: "webhook";
    readonly refreshPolicy: unknown;
  }) => SourceWebhookAutomationPolicy;
  resolveRegisteredConnectorManifest: (connectorId: string) => Promise<ConnectorManifestLike>;
  resolveSourceWebhookTarget: (input: {
    readonly connectorId: string;
    readonly connectorInstanceId?: string | null;
    readonly ownerSubjectId: string;
    readonly sourceId: string;
  }) =>
    | Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }>
    | { connectorId: string; connectorInstanceId: string; ownerSubjectId: string };
}

function readHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string
): string | null | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizeBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }
  return JSON.stringify(body ?? {});
}

export function mountRefSourceWebhooks(app: AppLike, ctx: MountRefSourceWebhooksContext): void {
  app.post("/_ref/source-webhooks/:sourceId", { bodyLimit: SOURCE_WEBHOOK_MAX_BODY_BYTES }, async (req, res) => {
    const secrets = ctx.parseSourceWebhookSecrets();
    const body = normalizeBody(req.body);
    try {
      const result: SourceWebhookResult = await executeSourceWebhook(
        {
          body,
          eventId: readHeader(req.headers, "pdpp-webhook-event-id"),
          signature: readHeader(req.headers, "pdpp-webhook-signature"),
          sourceId: req.params.sourceId,
          timestamp: readHeader(req.headers, "pdpp-webhook-timestamp"),
        },
        {
          claimEvent: (event) => ctx.getSourceWebhookEventStore().claimEvent(event),
          ingestRecords: async ({ connectorId, connectorInstanceId, streamName, body: ingestBody }) => {
            const output = await executeRecordsIngest(
              { body: ingestBody, connectorId, connectorInstanceId, streamName },
              {
                hasManifestStream: async (cid, name) => {
                  const manifest = await ctx.resolveRegisteredConnectorManifest(cid);
                  return Boolean((manifest.streams || []).find((stream) => stream.name === name));
                },
                ingestRecord: (cid, cii, record) =>
                  ctx.ingestRecord({ connector_id: cid, connector_instance_id: cii || connectorInstanceId }, record, {
                    requireConnectionAdmission: true,
                  }),
              }
            );
            return output.envelope;
          },
          nowMs: () => Date.now(),
          projectAutomationPolicy: async ({ connectorId, triggerKind }) => {
            const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
            return ctx.projectRunAutomationPolicy({
              refreshPolicy: ctx.getManifestRefreshPolicy(manifest),
              triggerKind,
            });
          },
          requestRun: async ({
            bodyHash,
            connectorId,
            connectorInstanceId,
            eventId,
            ownerSubjectId,
            receivedAt,
            sourceId,
            triggerKind,
          }) => {
            if (!ctx.controller) {
              return null;
            }
            const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
            // The runtime controller resolves the eventual run handle
            // asynchronously; the source-webhook operation only inspects
            // truthiness of the returned value to decide whether to fall
            // back to `signalScheduler`. We forward the raw controller
            // result unchanged to preserve that behaviour.
            try {
              return await ctx.controller.runNow(connectorId, {
                connectorInstanceId,
                manifest,
                ownerSubjectId,
                priorityClass: "background",
                sourceWebhookEvent: { action: "schedule_run", bodyHash, eventId, receivedAt, sourceId },
                triggerKind,
              });
            } catch (err) {
              if (err instanceof ControllerError && err.code === "source_webhook_event_duplicate") {
                return null;
              }
              throw err;
            }
          },
          resolveSecret: (sourceId) => secrets.get(sourceId)?.secret,
          resolveTarget: (sourceId) => {
            const configured = secrets.get(sourceId);
            if (!configured) {
              throw new SourceWebhookError("unknown_source", "source webhook credential is not configured", 404);
            }
            return ctx.resolveSourceWebhookTarget({
              connectorId: configured.connectorId,
              connectorInstanceId: configured.connectorInstanceId ?? null,
              ownerSubjectId: configured.ownerSubjectId || ctx.ownerSubjectId,
              sourceId,
            });
          },
          signalScheduler: async ({ connectorId, connectorInstanceId, receivedAt }) => {
            await ctx
              .getSchedulerStore()
              .upsertLastRunTime(connectorInstanceId, Date.parse(receivedAt), receivedAt, connectorId);
          },
        }
      );
      res.status(result.duplicate ? 202 : 200).json(result);
    } catch (err) {
      if (err instanceof SourceWebhookError) {
        ctx.pdppError(res, err.status, err.code, err.message);
        return;
      }
      ctx.handleError(res, err);
    }
  });
}
