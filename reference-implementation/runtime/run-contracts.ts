// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runtime run contracts.
//
// Type-only leaf holding the pure contract shapes shared across the runtime
// controller and the browser-surface run-coordinator. Extracted out of
// `controller.ts` to break the import cycle
//   browser-surface/index.ts -> run-coordinator.ts -> controller.ts
//     -> browser-surface/index.ts
// by giving both sides a value-free module to import these types from.
//
// This module MUST stay type-only: no value/const/function/helper/validation,
// and it imports NOTHING from `controller.ts` or any `runtime/browser-surface/*`
// module (no back-edge).

import type { BrowserSurfaceProjection } from "@opendatalabs/remote-surface/leases";
import type { SpineTraceContext } from "../lib/spine.ts";
import type { RunAutomationMode, RunTriggerKind } from "./run-automation-policy.ts";

export type ConnectorManifest = Record<string, unknown>;

export interface RunNowOptions {
  connectorInstanceId?: string;
  /**
   * Explicit force-override: bypass provider-pressure cooldown for this run.
   * Ordinary `Sync now` must NOT set this flag. It is reserved for a separate,
   * explicitly-named "force run despite pressure" action so the default owner
   * button cannot accidentally re-hit a hot account that is cooling off.
   */
  force?: boolean;
  manifest?: ConnectorManifest;
  ownerToken?: string;
  priorityClass?: "interactive" | "background";
  resources?: Readonly<Record<string, readonly string[]>>;
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  traceContext?: SpineTraceContext;
  triggerKind?: Extract<RunTriggerKind, "manual" | "webhook" | "scheduled">;
}

export interface RunNowResult {
  readonly automation_mode?: RunAutomationMode;
  readonly automation_summary?: string;
  readonly browser_surface?: BrowserSurfaceProjection;
  readonly run_id: string;
  readonly status?: "started" | BrowserSurfaceProjection["browser_surface_status"];
  readonly trace_id: string;
  readonly trigger_kind?: RunTriggerKind;
}
