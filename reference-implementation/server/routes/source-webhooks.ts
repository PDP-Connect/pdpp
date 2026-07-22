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
  SourceWebhookError,
  type SourceWebhookResult,
} from "../../operations/ref-source-webhook-ingest/index.ts";
import { executeRecordsIngest } from "../../operations/rs-records-ingest/index.ts";
import type { RunNowResult } from "../../runtime/controller.ts";

interface RouteRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: { readonly sourceId: string };
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  post(path: string, ...handlers: RouteHandler[]): AppLike;
}

export interface SourceWebhookSecret {
  readonly connectorId: string;
  readonly secret: string;
}

export type SourceWebhookSecretsMap = ReadonlyMap<string, SourceWebhookSecret>;

interface ConnectorManifestLike {
  readonly streams?: ReadonlyArray<{ readonly name: string }> | null;
}

export interface SourceWebhookSchedulerStore {
  upsertLastRunTime(connectorId: string, timestampMs: number, timestampIso: string): unknown | Promise<unknown>;
}

export interface SourceWebhookEventStoreLike {
  claimEvent(event: {
    readonly sourceId: string;
    readonly eventId: string;
    readonly bodyHash: string;
    readonly receivedAt: string;
  }): boolean | Promise<boolean>;
}

export interface SourceWebhookController {
  runNow(
    connectorId: string,
    input: {
      readonly manifest: ConnectorManifestLike;
      readonly priorityClass: "background";
      readonly triggerKind: "webhook";
    }
  ): RunNowResult | Promise<RunNowResult>;
}

export interface SourceWebhookAutomationPolicy {
  readonly allowed_to_start?: boolean;
  readonly automation_mode?: string;
  readonly reason?: string | null;
  readonly trigger_kind: "webhook";
}

export interface MountRefSourceWebhooksContext {
  readonly controller: SourceWebhookController | null | undefined;
  getManifestRefreshPolicy(manifest: ConnectorManifestLike): unknown;
  getSchedulerStore(): SourceWebhookSchedulerStore;
  getSourceWebhookEventStore(): SourceWebhookEventStoreLike;
  handleError(res: unknown, err: unknown): void;
  ingestRecord(connectorId: string, record: Record<string, unknown>): unknown | Promise<unknown>;
  parseSourceWebhookSecrets(): SourceWebhookSecretsMap;
  pdppError(res: unknown, status: number, code: string, message: string | undefined): unknown;
  projectRunAutomationPolicy(input: {
    readonly triggerKind: "webhook";
    readonly refreshPolicy: unknown;
  }): SourceWebhookAutomationPolicy;
  resolveRegisteredConnectorManifest(connectorId: string): Promise<ConnectorManifestLike>;
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
  app.post("/_ref/source-webhooks/:sourceId", async (req, res) => {
    const secrets = ctx.parseSourceWebhookSecrets();
    const body = normalizeBody(req.body);
    try {
      const result: SourceWebhookResult = await executeSourceWebhook(
        {
          sourceId: req.params.sourceId,
          body,
          timestamp: readHeader(req.headers, "pdpp-webhook-timestamp"),
          eventId: readHeader(req.headers, "pdpp-webhook-event-id"),
          signature: readHeader(req.headers, "pdpp-webhook-signature"),
        },
        {
          nowMs: () => Date.now(),
          resolveSecret: (sourceId) => secrets.get(sourceId)?.secret,
          resolveConnectorId: (sourceId) => secrets.get(sourceId)?.connectorId,
          claimEvent: (event) => ctx.getSourceWebhookEventStore().claimEvent(event),
          ingestRecords: async ({ connectorId, streamName, body: ingestBody }) => {
            const output = await executeRecordsIngest(
              { connectorId, streamName, body: ingestBody },
              {
                hasManifestStream: async (cid, name) => {
                  const manifest = await ctx.resolveRegisteredConnectorManifest(cid);
                  return Boolean((manifest.streams || []).find((stream) => stream.name === name));
                },
                ingestRecord: (cid, _connectorInstanceId, record) => ctx.ingestRecord(cid, record),
              }
            );
            return output.envelope;
          },
          signalScheduler: async ({ connectorId, receivedAt }) => {
            await ctx.getSchedulerStore().upsertLastRunTime(connectorId, Date.parse(receivedAt), receivedAt);
          },
          projectAutomationPolicy: async ({ connectorId, triggerKind }) => {
            const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
            return ctx.projectRunAutomationPolicy({
              triggerKind,
              refreshPolicy: ctx.getManifestRefreshPolicy(manifest),
            });
          },
          requestRun: async ({ connectorId, triggerKind }) => {
            if (!ctx.controller) {
              return null;
            }
            const manifest = await ctx.resolveRegisteredConnectorManifest(connectorId);
            // The runtime controller resolves the eventual run handle
            // asynchronously; the source-webhook operation only inspects
            // truthiness of the returned value to decide whether to fall
            // back to `signalScheduler`. We forward the raw controller
            // result unchanged to preserve that behaviour.
            return ctx.controller.runNow(connectorId, {
              manifest,
              priorityClass: "background",
              triggerKind,
            });
          },
        }
      );
      res.status(result.duplicate ? 202 : 200).json(result);
      return;
    } catch (err) {
      if (err instanceof SourceWebhookError) {
        ctx.pdppError(res, err.status, err.code, err.message);
        return;
      }
      ctx.handleError(res, err);
    }
  });
}
