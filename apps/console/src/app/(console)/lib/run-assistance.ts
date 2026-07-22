// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SpineEvent } from "./ref-client.ts";

export type AssistanceProgressPosture = "blocked" | "running" | "waiting_retry";
export type AssistanceOwnerAction = "act_elsewhere" | "none" | "operate_attachment" | "provide_value";
export type AssistanceResponseContract = "none" | "response_required";

export interface AssistanceAttachment {
  kind: string;
  label: string | null;
  ref: string | null;
  status: string | null;
}

export interface AssistanceField {
  format: "password" | "text";
  label: string | null;
  name: string;
  required: boolean;
}

export interface CurrentRunAssistance {
  attachments: AssistanceAttachment[];
  fields: AssistanceField[];
  id: string;
  isLegacyInteraction: boolean;
  kind: string;
  message: string;
  ownerAction: AssistanceOwnerAction;
  progressPosture: AssistanceProgressPosture;
  responseContract: AssistanceResponseContract;
  timeoutLabel: string | null;
}

const ASSISTANCE_TERMINAL_EVENTS = new Set([
  "run.assistance_cancelled",
  "run.assistance_escalated",
  "run.assistance_resolved",
  "run.assistance_timed_out",
]);
const BROWSER_SURFACE_TERMINAL_STATUSES = new Set(["cancelled", "deferred", "expired", "released", "surface_failed"]);

export function getCurrentRunAssistance(events: SpineEvent[]): CurrentRunAssistance | null {
  const completedLegacyInteractions = getCompletedLegacyInteractions(events);
  const terminalState = getTerminalAssistanceState(events);

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }

    if (event.event_type === "run.assistance_requested") {
      const id = getEventAssistanceId(event);
      if (!id || terminalState.ids.has(id)) {
        continue;
      }
      if (terminalState.unidentifiedCount > 0) {
        terminalState.unidentifiedCount -= 1;
        continue;
      }
      return assistanceFromEvent(event, id);
    }

    if (event.event_type === "run.interaction_required") {
      const id = getEventAssistanceId(event);
      if (!id || completedLegacyInteractions.has(id)) {
        continue;
      }
      return assistanceFromLegacyInteraction(event, id);
    }
  }

  return null;
}

export function getCurrentBrowserSurfaceAssistance(events: SpineEvent[]): CurrentRunAssistance | null {
  const terminalState = getTerminalAssistanceState(events);
  const structured = findCurrentStructuredAssistance(events, terminalState, isStreamableBrowserSurfaceAssistance);
  if (structured) {
    return structured;
  }
  const completedLegacyInteractions = getCompletedLegacyInteractions(events);
  return findCurrentLegacyInteraction(events, completedLegacyInteractions, isStreamableBrowserSurfaceAssistance);
}

export function hasActiveBrowserSurface(events: SpineEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event?.event_type.startsWith("run.browser_surface_")) {
      continue;
    }
    const status = readBrowserSurfaceStatus(event);
    return status ? !BROWSER_SURFACE_TERMINAL_STATUSES.has(status) : false;
  }
  return false;
}

function getCompletedLegacyInteractions(events: SpineEvent[]): Set<string> {
  return new Set(
    events
      .filter((event) => event.event_type === "run.interaction_completed")
      .map(getEventAssistanceId)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
}

function findCurrentStructuredAssistance(
  events: SpineEvent[],
  terminalState: { ids: Set<string>; unidentifiedCount: number },
  predicate: (assistance: CurrentRunAssistance) => boolean
): CurrentRunAssistance | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.event_type !== "run.assistance_requested") {
      continue;
    }
    const id = getEventAssistanceId(event);
    if (!id || terminalState.ids.has(id)) {
      continue;
    }
    if (terminalState.unidentifiedCount > 0) {
      terminalState.unidentifiedCount -= 1;
      continue;
    }
    const assistance = assistanceFromEvent(event, id);
    if (predicate(assistance)) {
      return assistance;
    }
  }
  return null;
}

function findCurrentLegacyInteraction(
  events: SpineEvent[],
  completedLegacyInteractions: Set<string>,
  predicate: (assistance: CurrentRunAssistance) => boolean
): CurrentRunAssistance | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.event_type !== "run.interaction_required") {
      continue;
    }
    const id = getEventAssistanceId(event);
    if (!id || completedLegacyInteractions.has(id)) {
      continue;
    }
    const assistance = assistanceFromLegacyInteraction(event, id);
    if (predicate(assistance)) {
      return assistance;
    }
  }
  return null;
}

function getTerminalAssistanceState(events: SpineEvent[]): { ids: Set<string>; unidentifiedCount: number } {
  const ids = new Set<string>();
  let unidentifiedCount = 0;
  for (const event of events) {
    if (!ASSISTANCE_TERMINAL_EVENTS.has(event.event_type)) {
      continue;
    }
    const id = getEventAssistanceId(event);
    if (id) {
      ids.add(id);
    } else {
      unidentifiedCount += 1;
    }
  }
  return { ids, unidentifiedCount };
}

export function hasBrowserSurfaceAttachment(assistance: CurrentRunAssistance): boolean {
  return assistance.attachments.some((attachment) => attachment.kind === "browser_surface");
}

export function hasAvailableBrowserSurfaceAttachment(assistance: CurrentRunAssistance): boolean {
  return assistance.attachments.some(isAvailableBrowserSurfaceAttachment);
}

export function requiresBrowserSurfaceAssistance(assistance: CurrentRunAssistance): boolean {
  return (
    assistance.progressPosture === "blocked" &&
    assistance.ownerAction === "operate_attachment" &&
    hasBrowserSurfaceAttachment(assistance)
  );
}

function isStreamableBrowserSurfaceAssistance(assistance: CurrentRunAssistance): boolean {
  return requiresBrowserSurfaceAssistance(assistance) && hasAvailableBrowserSurfaceAttachment(assistance);
}

function assistanceFromEvent(event: SpineEvent, id: string): CurrentRunAssistance {
  const data = event.data ?? {};
  return {
    id,
    isLegacyInteraction: false,
    kind: stringField(data.kind) ?? "assistance",
    message: stringField(data.message) ?? "Waiting for the requested run assistance.",
    progressPosture: progressPostureField(data.progress_posture) ?? "blocked",
    ownerAction: ownerActionField(data.owner_action) ?? "provide_value",
    responseContract: responseContractField(data.response_contract) ?? "response_required",
    attachments: parseAttachments(data.attachments),
    fields: parseFields(data.input_schema ?? data.schema),
    timeoutLabel: timeoutLabel(data.timeout_seconds),
  };
}

function assistanceFromLegacyInteraction(event: SpineEvent, id: string): CurrentRunAssistance {
  const data = event.data ?? {};
  const kind = stringField(data.kind) ?? "interaction";
  const isManualAction = kind === "manual_action";
  return {
    id,
    isLegacyInteraction: true,
    kind,
    message: stringField(data.message) ?? "Awaiting operator response.",
    progressPosture: "blocked",
    ownerAction: isManualAction ? "operate_attachment" : "provide_value",
    responseContract: "response_required",
    attachments: isManualAction ? [{ kind: "browser_surface", label: null, ref: null, status: null }] : [],
    fields: parseFields(data.schema),
    timeoutLabel: timeoutLabel(data.timeout_seconds),
  };
}

function getEventAssistanceId(event: SpineEvent): string | null {
  return (
    stringField(event.data?.assistance_request_id) ??
    stringField(event.data?.assistance_id) ??
    stringField(event.data?.interaction_id) ??
    stringField(event.interaction_id)
  );
}

function readBrowserSurfaceStatus(event: SpineEvent): string | null {
  const browserSurface = event.data?.browser_surface;
  if (browserSurface && typeof browserSurface === "object" && !Array.isArray(browserSurface)) {
    return stringField((browserSurface as Record<string, unknown>).browser_surface_status) ?? stringField(event.status);
  }
  return stringField(event.status);
}

function parseAttachments(value: unknown): AssistanceAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((raw): AssistanceAttachment | null => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
      }
      const item = raw as Record<string, unknown>;
      const kind = stringField(item.kind ?? item.type);
      if (!kind) {
        return null;
      }
      return {
        kind,
        label: stringField(item.label ?? item.title),
        ref: stringField(item.ref ?? item.id ?? item.surface_id),
        status: stringField(item.status ?? item.availability),
      };
    })
    .filter((attachment): attachment is AssistanceAttachment => attachment !== null);
}

function isAvailableBrowserSurfaceAttachment(attachment: AssistanceAttachment): boolean {
  if (attachment.kind !== "browser_surface") {
    return false;
  }
  if (attachment.ref) {
    return true;
  }
  if (!attachment.status) {
    return true;
  }
  return attachment.status === "available" || attachment.status === "current" || attachment.status === "registered";
}

function parseFields(schema: unknown): AssistanceField[] {
  const requiredFields = new Set(
    schema &&
      typeof schema === "object" &&
      !Array.isArray(schema) &&
      Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required: unknown[] }).required.filter((value) => typeof value === "string") as string[])
      : []
  );
  const properties =
    schema && typeof schema === "object" && !Array.isArray(schema) && "properties" in schema
      ? (schema as { properties?: unknown }).properties
      : null;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.entries(properties as Record<string, unknown>)
        .map(([name, rawDef]): AssistanceField => {
          const def = rawDef && typeof rawDef === "object" ? (rawDef as Record<string, unknown>) : {};
          return {
            name,
            label: stringField(def.title),
            format: def.format === "password" ? "password" : "text",
            required: requiredFields.has(name),
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];
}

function progressPostureField(value: unknown): AssistanceProgressPosture | null {
  return value === "blocked" || value === "running" || value === "waiting_retry" ? value : null;
}

function ownerActionField(value: unknown): AssistanceOwnerAction | null {
  return value === "act_elsewhere" || value === "none" || value === "operate_attachment" || value === "provide_value"
    ? value
    : null;
}

function responseContractField(value: unknown): AssistanceResponseContract | null {
  return value === "none" || value === "response_required" ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timeoutLabel(value: unknown): string | null {
  if (typeof value !== "number" || value <= 0) {
    return null;
  }
  if (value < 60) {
    return `${value}s`;
  }
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
