import { readRuntimeCollectionFact } from "../server/runtime-collection-facts.ts";

interface TerminalRequest {
  readonly body?: unknown;
  readonly deviceExporter?: { readonly deviceId: string };
  readonly params: Readonly<Record<string, string>>;
}

interface TerminalResponse {
  json(body: unknown): unknown;
  status(code: number): TerminalResponse;
}

interface AuthorizedSource {
  readonly connectorInstance: { readonly connectorInstanceId: string };
  readonly sourceInstance: { readonly connectorId: string };
}

interface TerminalContext {
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  handleError(res: unknown, error: unknown): void;
  pdppError(res: unknown, status: number, code: string, message: string, param?: string): void;
}

/**
 * Turns an explicit local collector terminal report into the existing
 * terminal-event/fold contract. The report carries raw collector coverage
 * statuses through the canonical fact normalizer; policy stays in the
 * manifest-aware read-side coverage authority.
 */
export async function handleLocalDeviceTerminalCollection(input: {
  ctx: TerminalContext;
  req: TerminalRequest;
  res: TerminalResponse;
  resolveAuthorizedSource: (deviceId: string, sourceInstanceId: string) => Promise<AuthorizedSource | null>;
  sameConnectorType: (left: string, right: string) => boolean;
}): Promise<void> {
  const { ctx, req, res } = input;
  try {
    const deviceId = decodeURIComponent(req.params.deviceId as string);
    const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
    if (deviceId !== req.deviceExporter?.deviceId) {
      ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
      return;
    }
    const authorized = await input.resolveAuthorizedSource(deviceId, sourceInstanceId);
    if (!authorized) return;
    const body = asObject(req.body);
    const connectorId = body && readRequiredString(body.connector_id);
    const runId = body && readRequiredString(body.run_id);
    const reportedSourceId = body && readRequiredString(body.source_instance_id);
    if (!(body && connectorId && runId) || reportedSourceId !== sourceInstanceId) {
      ctx.pdppError(res, 400, "invalid_request", "terminal collection requires matching connector_id, run_id, and source_instance_id");
      return;
    }
    if (!(input.sameConnectorType(authorized.sourceInstance.connectorId, connectorId) && Array.isArray(body.streams))) {
      ctx.pdppError(res, 400, "invalid_request", "terminal collection connector or streams is invalid");
      return;
    }
    const streams = normalizeTerminalFacts(body.streams);
    if (!streams) {
      ctx.pdppError(res, 400, "invalid_request", "terminal collection requires at least one observed stream", "streams");
      return;
    }
    await ctx.emitSpineEvent({
      event_id: `evt_local_device_terminal_${runId}`,
      event_type: "run.completed",
      actor_type: "local_device",
      actor_id: deviceId,
      object_type: "run",
      object_id: runId,
      run_id: runId,
      source_kind: "connector",
      source_id: authorized.sourceInstance.connectorId,
      status: "succeeded",
      data: {
        connector_instance_id: authorized.connectorInstance.connectorInstanceId,
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams,
        },
      },
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    ctx.handleError(res, error);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeTerminalFacts(rawFacts: readonly unknown[]): readonly Record<string, unknown>[] | null {
  const byStream = new Map<string, Record<string, unknown>>();
  for (const raw of rawFacts) {
    const entry = asObject(raw);
    const coverageStatuses = entry && readCoverageStatuses(entry.coverage_statuses);
    if (!entry || !coverageStatuses) {
      return null;
    }
    // A successful terminal report proves its coverage checkpoint reached the
    // server, not that every source absence is a gap. Preserve the raw status
    // set and let the canonical manifest-aware policy classify accepted
    // absence. Only these existing collector statuses are true unresolved
    // evidence at this boundary.
    const pendingDetailGaps = coverageStatuses.filter((status) => status === "missing" || status === "unaccounted").length;
    const fact = readRuntimeCollectionFact({
      stream: entry.stream,
      checkpoint: "committed",
      collected: 0,
      considered: null,
      covered: null,
      pending_detail_gaps: pendingDetailGaps,
      skipped: null,
      coverage_statuses: coverageStatuses,
    });
    if (!fact) {
      return null;
    }
    byStream.set(fact.stream, {
      stream: fact.stream,
      checkpoint: fact.checkpoint,
      collected: fact.collected,
      considered: fact.considered,
      covered: fact.covered,
      pending_detail_gaps: fact.pending_detail_gaps,
      skipped: fact.skipped,
      coverage_statuses: fact.coverage_statuses,
    });
  }
  return byStream.size > 0 ? [...byStream.values()].sort((left, right) => String(left.stream).localeCompare(String(right.stream))) : null;
}

function readCoverageStatuses(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some((status) => typeof status !== "string" || !status)) {
    return null;
  }
  return [...new Set(value)].sort();
}
