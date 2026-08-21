// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Managed-connector scheduled-run routing seam.
 *
 * Concept: builds the callback the scheduler uses to dispatch a scheduled run
 * for a browser-surface-leased (managed) connector through controller.runNow,
 * then project its real terminal outcome.
 *
 * Invariant: receives the controller via DI; no startServer-internal
 * reach-back (no import from index.ts).
 */

import { getRunTerminalEvent } from "../lib/spine.ts";
import type { ConnectorError, SchedulerOptions, TerminalReason } from "../runtime/scheduler.ts";

const SURFACE_UNAVAILABLE_HANDLE_STATUSES = Object.freeze([
  "run_browser_surface_queued",
  "browser_surface_probe_failed",
  "browser_surface_lost",
  "surface_failed",
]);

interface Controller {
  awaitRun: (runId: string) => Promise<string>;
  browserSurfaceLeaseManager?: {
    isManagedConnector: (connectorId: string) => boolean;
  };
  getActiveRun: (connectorId: string, options: { connectorInstanceId: string }) => unknown;
  isNeedsHuman: (connectorId: string, options: { connectorInstanceId: string }) => boolean;
  issueRuntimeOwnerToken: () => Promise<string>;
  markNeedsHuman: (connectorId: string, options: { connectorInstanceId: string }) => void;
  runNow: (
    connectorId: string,
    options: {
      connectorInstanceId: string;
      ownerSubjectId: string;
      ownerToken: string;
      priorityClass: "background";
      recoveryOnly?: boolean;
      triggerKind: "scheduled";
      rsUrl?: string;
      referenceBaseUrl?: string | null;
    }
  ) => Promise<ManagedRunHandle>;
}

interface ManagedRunHandle {
  readonly connector_error?: Record<string, unknown> | null;
  readonly failure_reason?: string | null;
  readonly known_gaps?: readonly Record<string, unknown>[] | null;
  readonly run_id: string;
  readonly status: string;
  readonly terminal_reason?: string | null;
  readonly trace_id: string;
}

interface TerminalEvent {
  readonly data?: unknown;
}

function projectManagedControllerTerminalRun(
  handle: ManagedRunHandle,
  terminalStatus: string,
  terminalEvent: TerminalEvent | null
) {
  const terminalData =
    terminalEvent?.data && typeof terminalEvent.data === "object"
      ? (terminalEvent.data as Record<string, unknown>)
      : {};
  const connectorError =
    terminalData.connector_error && typeof terminalData.connector_error === "object"
      ? (terminalData.connector_error as ConnectorError)
      : null;
  const failureReason = typeof terminalData.reason === "string" ? terminalData.reason : null;
  const knownGaps = Array.isArray(terminalData.known_gaps)
    ? terminalData.known_gaps.filter((gap): gap is Record<string, unknown> => Boolean(gap && typeof gap === "object"))
    : [];
  const terminalReason =
    typeof terminalData.terminal_reason === "string" ? (terminalData.terminal_reason as TerminalReason) : null;
  return {
    connector_error: connectorError,
    failure_reason: failureReason,
    known_gaps: knownGaps,
    run_id: handle.run_id,
    status: terminalStatus,
    terminal_reason: terminalReason,
    trace_id: handle.trace_id,
  };
}

export function createRunManagedConnectorViaController(
  controller: Controller
): SchedulerOptions["runManagedConnectorViaController"] {
  const leaseManager = controller.browserSurfaceLeaseManager;
  if (!leaseManager) {
    return null;
  }

  return async (connectorId, opts) => {
    if (!leaseManager.isManagedConnector(connectorId)) {
      // Not a managed connector — signal launchRun to use the direct
      // runConnector path (no lease needed).
      return null;
    }
    const handle = await controller.runNow(connectorId, {
      connectorInstanceId: opts.connectorInstanceId,
      ownerSubjectId: opts.ownerSubjectId,
      ownerToken: opts.ownerToken,
      priorityClass: opts.priorityClass,
      recoveryOnly: opts.recoveryOnly === true,
      triggerKind: opts.triggerKind,
      ...(opts.rsUrl === undefined ? {} : { rsUrl: opts.rsUrl }),
      ...(opts.referenceBaseUrl === undefined ? {} : { referenceBaseUrl: opts.referenceBaseUrl }),
    });
    // Early-exit statuses (browser_surface_queued, surface_failed, etc.)
    // mean no run was started — return the handle as-is for the scheduler's
    // surface-unavailable skip path.
    if (handle.status && SURFACE_UNAVAILABLE_HANDLE_STATUSES.includes(handle.status)) {
      return handle as Awaited<ReturnType<NonNullable<SchedulerOptions["runManagedConnectorViaController"]>>>;
    }
    // Run was dispatched (status "started"). Await its real terminal
    // outcome so the scheduler records the true succeeded/failed status
    // and its failure-streak / back-off machinery fires correctly.
    // controller.awaitRun races activeRunPromises[runId] (the .finally()
    // cleanup chain) against the run's own watchdog settlement, then reads
    // the spine terminal event — see awaitRun's own doc comment for why
    // that race exists. This call cannot hang even if runConnectorImpl
    // itself never settles: the watchdog (maxRunWallClockMs) force-finalizes
    // the run and resolves the race independently of the raw promise.
    const terminalStatus = await controller.awaitRun(handle.run_id);
    const terminalEvent = (await getRunTerminalEvent(handle.run_id)) as TerminalEvent | null;
    return projectManagedControllerTerminalRun(handle, terminalStatus, terminalEvent);
  };
}

// NOTE: `createReferenceSchedulerManager` used to be defined here as well.
// It was a second, complete copy of the scheduler manager -- including its
// own duplicate of all four dispatch probes and the same
// `reconcileDirtyConnectorSummaryEvidence` write inside the
// forward-evidence-debt probe -- and it was imported by nothing. Production
// calls the definition in server/index.ts; the two importing tests take only
// `createRunManagedConnectorViaController` above.
//
// A parallel copy of the exact subsystem the run-lifecycle machine governs,
// whose divergence no test could see, is D5's masking-pair hazard sitting in
// the tree. It is deleted rather than kept in sync, because keeping two
// copies in sync by intention is the thing that failed.
