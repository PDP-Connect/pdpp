import { createHash } from "node:crypto";
import { canonicalTerminalRunCommitJson } from "@pdpp/reference-contract/common";
import { readRuntimeCollectionFact } from "../server/runtime-collection-facts.ts";
import type { ResolvedTerminalRunCommit, TerminalRunCommitResult } from "../server/stores/terminal-run-commit-store.ts";
import { TerminalRunCommitConflictError } from "../server/stores/terminal-run-commit-store.ts";

interface TerminalRequest {
  readonly body?: unknown;
  readonly deviceExporter?: { readonly deviceId: string };
  readonly params: Readonly<Record<string, string>>;
}

interface TerminalResponse {
  json: (body: unknown) => unknown;
  status: (code: number) => TerminalResponse;
}

interface AuthorizedSource {
  readonly connectorInstance: { readonly connectorInstanceId: string };
  readonly sourceInstance: { readonly connectorId: string };
}

interface TerminalContext {
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  handleError: (res: unknown, error: unknown) => void;
  pdppError: (res: unknown, status: number, code: string, message: string, param?: string) => void;
}

export interface TerminalRunCommitContext extends TerminalContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  commitTerminalRun: (input: ResolvedTerminalRunCommit) => Promise<TerminalRunCommitResult>;
}

/**
 * Device-authenticated terminal commit boundary. Authorization and canonical
 * connection resolution complete before the durable store can inspect an
 * existing receipt, preventing cross-device/source receipt disclosure.
 */
export async function handleLocalDeviceTerminalRunCommit(input: {
  ctx: TerminalRunCommitContext;
  req: TerminalRequest;
  res: TerminalResponse;
  resolveAuthorizedSource: (deviceId: string, sourceInstanceId: string) => Promise<AuthorizedSource | null>;
}): Promise<void> {
  const { ctx, req, res } = input;
  try {
    const deviceId = decodeURIComponent(req.params.deviceId as string);
    const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
    if (deviceId !== req.deviceExporter?.deviceId) {
      ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
      return;
    }
    // This is the only receipt-lookup gateway. It resolves the complete
    // authenticated device/source/connection binding before store entry.
    const authorized = await input.resolveAuthorizedSource(deviceId, sourceInstanceId);
    if (!authorized) {
      return;
    }
    const body = asObject(req.body);
    const commitId = body && readRequiredString(body.commit_id);
    const reportedDeviceId = body && readRequiredString(body.device_id);
    const reportedSourceId = body && readRequiredString(body.source_instance_id);
    const reportedConnectorId = body && readRequiredString(body.connector_id);
    const reportedConnectorInstanceId = body && readRequiredString(body.connector_instance_id);
    const runId = body && readRequiredString(body.run_id);
    const collectionBoundary = body && readRequiredString(body.collection_boundary);
    const stateDelta = body && asObject(body.state_delta);
    const normalizedFacts =
      body && Array.isArray(body.terminal_facts) ? normalizeTerminalFacts(body.terminal_facts) : null;
    const canonicalConnectorId = ctx.canonicalConnectorKey(authorized.sourceInstance.connectorId);
    if (
      body?.version !== 1 ||
      !commitId ||
      reportedDeviceId !== deviceId ||
      reportedSourceId !== sourceInstanceId ||
      !reportedConnectorId ||
      reportedConnectorInstanceId !== authorized.connectorInstance.connectorInstanceId ||
      !runId ||
      !collectionBoundary ||
      !stateDelta ||
      !normalizedFacts ||
      !canonicalConnectorId ||
      reportedConnectorId !== canonicalConnectorId
    ) {
      ctx.pdppError(res, 400, "invalid_request", "terminal run commit body or binding is invalid");
      return;
    }

    const canonicalEnvelope = {
      collection_boundary: collectionBoundary,
      commit_id: commitId,
      connector_id: canonicalConnectorId,
      connector_instance_id: reportedConnectorInstanceId,
      device_id: deviceId,
      run_id: runId,
      source_instance_id: sourceInstanceId,
      state_delta: stateDelta,
      terminal_facts: body.terminal_facts as Array<{
        coverage_statuses: string[];
        scoped?: boolean;
        stream: string;
      }>,
      version: 1,
    } as const;
    const envelopeHash = createHash("sha256").update(canonicalTerminalRunCommitJson(canonicalEnvelope)).digest("hex");
    const result = await ctx.commitTerminalRun({
      collectionBoundary,
      commitId,
      connectorId: canonicalConnectorId,
      connectorInstanceId: authorized.connectorInstance.connectorInstanceId,
      deviceId,
      envelopeHash,
      normalizedFacts,
      runId,
      sourceInstanceId,
      stateDelta,
    });
    res.status(result.replayed ? 200 : 201).json(result.response);
  } catch (error) {
    if (error instanceof TerminalRunCommitConflictError) {
      ctx.pdppError(
        res,
        409,
        "terminal_run_commit_conflict",
        "Terminal run commit identity conflicts with an existing commit."
      );
      return;
    }
    ctx.handleError(res, error);
  }
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
    if (!authorized) {
      return;
    }
    const body = asObject(req.body);
    const connectorId = body && readRequiredString(body.connector_id);
    const runId = body && readRequiredString(body.run_id);
    const reportedSourceId = body && readRequiredString(body.source_instance_id);
    if (!(body && connectorId && runId) || reportedSourceId !== sourceInstanceId) {
      ctx.pdppError(
        res,
        400,
        "invalid_request",
        "terminal collection requires matching connector_id, run_id, and source_instance_id"
      );
      return;
    }
    if (!(input.sameConnectorType(authorized.sourceInstance.connectorId, connectorId) && Array.isArray(body.streams))) {
      ctx.pdppError(res, 400, "invalid_request", "terminal collection connector or streams is invalid");
      return;
    }
    const streams = normalizeTerminalFacts(body.streams);
    if (!streams) {
      ctx.pdppError(
        res,
        400,
        "invalid_request",
        "terminal collection requires at least one observed stream",
        "streams"
      );
      return;
    }
    await ctx.emitSpineEvent({
      actor_id: deviceId,
      actor_type: "local_device",
      data: {
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams,
        },
        connector_instance_id: authorized.connectorInstance.connectorInstanceId,
        // Durable compatibility telemetry for retiring the split terminal
        // protocol. Operators can count this marker in the existing spine;
        // new collectors never emit it because they use terminal-run-commits.
        legacy_terminal_protocol: {
          protocol: "split_state_and_terminal_collection_v1",
          retirement_not_before: "2026-11-12",
        },
      },
      event_id: `evt_local_device_terminal_${runId}`,
      event_type: "run.completed",
      object_id: runId,
      object_type: "run",
      run_id: runId,
      source_id: authorized.sourceInstance.connectorId,
      source_kind: "connector",
      status: "succeeded",
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

export function normalizeTerminalFacts(rawFacts: readonly unknown[]): readonly Record<string, unknown>[] | null {
  const byStream = new Map<string, Record<string, unknown>>();
  for (const raw of rawFacts) {
    const entry = asObject(raw);
    const coverageStatuses = entry && readCoverageStatuses(entry.coverage_statuses);
    if (!(entry && coverageStatuses)) {
      return null;
    }
    // A successful terminal report proves its coverage checkpoint reached the
    // server, not that every source absence is a gap. Preserve the raw status
    // set and let the canonical manifest-aware policy classify accepted
    // absence. Only these existing collector statuses are true unresolved
    // evidence at this boundary.
    const pendingDetailGaps = coverageStatuses.filter(
      (status) => status === "missing" || status === "unaccounted"
    ).length;
    const fact = readRuntimeCollectionFact({
      checkpoint: "committed",
      collected: 0,
      considered: null,
      coverage_statuses: coverageStatuses,
      covered: null,
      pending_detail_gaps: pendingDetailGaps,
      skipped: null,
      stream: entry.stream,
    });
    if (!fact) {
      return null;
    }
    byStream.set(fact.stream, {
      checkpoint: fact.checkpoint,
      collected: fact.collected,
      considered: fact.considered,
      coverage_statuses: fact.coverage_statuses,
      covered: fact.covered,
      pending_detail_gaps: fact.pending_detail_gaps,
      skipped: fact.skipped,
      stream: fact.stream,
    });
  }
  return byStream.size > 0
    ? [...byStream.values()].sort((left, right) => String(left.stream).localeCompare(String(right.stream)))
    : null;
}

function readCoverageStatuses(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some((status) => typeof status !== "string" || !status)) {
    return null;
  }
  return [...new Set(value)].sort();
}
