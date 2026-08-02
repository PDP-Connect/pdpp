// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RunInboxEnvelope, SpineEvent } from "./ref-client.ts";

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

const LEGACY_INTERACTION_KINDS = new Set(["credentials", "manual_action", "otp"]);
const LEGACY_LIST_MAX = 50;
const LEGACY_NAME_MAX = 160;
const LEGACY_UNSAFE_FIELD_NAME_RE = /^(?:__proto__|constructor|prototype)$/;

export function currentRunAssistanceFromInbox(pending: RunInboxEnvelope["data"] | null): CurrentRunAssistance | null {
  if (!pending) {
    return null;
  }
  return {
    attachments:
      pending.kind === "manual_action" ? [{ kind: "browser_surface", label: null, ref: null, status: null }] : [],
    fields: [...pending.fields],
    id: pending.interaction_id,
    isLegacyInteraction: true,
    kind: pending.kind,
    message: pending.message,
    ownerAction: pending.kind === "manual_action" ? "operate_attachment" : "provide_value",
    progressPosture: "blocked",
    responseContract: "response_required",
    timeoutLabel: timeoutLabel(pending.timeout_seconds),
  };
}

export function resolveCurrentRunAssistance(
  events: SpineEvent[],
  pending: RunInboxEnvelope["data"] | null
): CurrentRunAssistance | null {
  return currentRunAssistanceFromInbox(pending) ?? getCurrentRunAssistance(events);
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

    const legacyAssistance = legacyAssistanceForEvent(event, completedLegacyInteractions);
    if (legacyAssistance) {
      return legacyAssistance;
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
    if (event?.event_type !== "run.assistance_requested") {
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
    const assistance = event ? legacyAssistanceForEvent(event, completedLegacyInteractions) : null;
    if (assistance && predicate(assistance)) {
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
  const { data } = event;
  return {
    attachments: parseAttachments(data.attachments),
    fields: parseFields(data.input_schema ?? data.schema),
    id,
    isLegacyInteraction: false,
    kind: stringField(data.kind) ?? "assistance",
    message: stringField(data.message) ?? "Waiting for the requested run assistance.",
    ownerAction: ownerActionField(data.owner_action) ?? "provide_value",
    progressPosture: progressPostureField(data.progress_posture) ?? "blocked",
    responseContract: responseContractField(data.response_contract) ?? "response_required",
    timeoutLabel: timeoutLabel(data.timeout_seconds),
  };
}

function assistanceFromLegacyInteraction(event: SpineEvent, id: string): CurrentRunAssistance | null {
  const { data } = event;
  if (!isRecord(data)) {
    return null;
  }
  const kind = legacyInteractionKind(data.kind);
  if (!kind) {
    return null;
  }
  const isManualAction = kind === "manual_action";
  return {
    attachments: isManualAction ? [{ kind: "browser_surface", label: null, ref: null, status: null }] : [],
    fields: parseFields(projectLegacyInteractionSchema(data.schema)),
    id,
    isLegacyInteraction: true,
    kind,
    message: sanitizeLegacyInteractionString(data.message) ?? "Awaiting operator response.",
    ownerAction: isManualAction ? "operate_attachment" : "provide_value",
    progressPosture: "blocked",
    responseContract: "response_required",
    timeoutLabel: timeoutLabel(data.timeout_seconds),
  };
}

function legacyAssistanceForEvent(
  event: SpineEvent,
  completedLegacyInteractions: Set<string>
): CurrentRunAssistance | null {
  if (event.event_type !== "run.interaction_required") {
    return null;
  }
  const id = getEventAssistanceId(event);
  return id && !completedLegacyInteractions.has(id) ? assistanceFromLegacyInteraction(event, id) : null;
}

function legacyInteractionKind(value: unknown): string | null {
  return typeof value === "string" && LEGACY_INTERACTION_KINDS.has(value) ? value : null;
}

/**
 * Legacy interaction rows were written before the owner-safe assistance
 * projection existed. Keep the fallback useful for known-safe prompt text,
 * but never pass connector-authored raw strings or schema branches through to
 * the page when the inbox projection is absent.
 */
function sanitizeLegacyInteractionString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const bounded = value.trim().slice(0, maxLength);
  if (!bounded) {
    return null;
  }
  const sanitized = bounded
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, "[REDACTED_URL]")
    .replace(
      /\b((?:qr[_-]?)?(?:secret|token|password|passwd|cookie|otp|bearer))\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /\b((?:cdp|playwright|webrtc|neko)[_-]?(?:url|uri|endpoint|token|secret))\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/\b\d{6}\b/g, "[REDACTED_OTP]");
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength - 1)}…`;
}

function safeLegacyFieldName(value: string): boolean {
  return Boolean(value) && value.length <= LEGACY_NAME_MAX && !LEGACY_UNSAFE_FIELD_NAME_RE.test(value);
}

function projectLegacyInteractionSchema(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const result = projectLegacySchemaMetadata(value);
  const properties = projectLegacySchemaProperties(value.properties);
  if (properties) {
    result.properties = properties;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectLegacySchemaMetadata(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof schema.type === "string" && schema.type.length <= 40) {
    result.type = schema.type;
  }
  const required = Array.isArray(schema.required)
    ? schema.required
        .filter((entry): entry is string => typeof entry === "string" && safeLegacyFieldName(entry))
        .slice(0, LEGACY_LIST_MAX)
    : [];
  if (required.length > 0) {
    result.required = required;
  }
  return result;
}

function projectLegacySchemaProperties(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const projected: Record<string, unknown> = {};
  for (const [name, rawDefinition] of Object.entries(value).slice(0, LEGACY_LIST_MAX)) {
    const definition = projectLegacySchemaField(name, rawDefinition);
    if (definition) {
      projected[name] = definition;
    }
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

function projectLegacySchemaField(name: string, value: unknown): Record<string, unknown> | null {
  if (!(safeLegacyFieldName(name) && isRecord(value))) {
    return null;
  }
  const definition: Record<string, unknown> = {};
  if (typeof value.type === "string" && value.type.length <= 40) {
    definition.type = value.type;
  }
  if (value.format === "password") {
    definition.format = "password";
  }
  const title = sanitizeLegacyInteractionString(value.title, 160);
  if (title) {
    definition.title = title;
  }
  return Object.keys(definition).length > 0 ? definition : null;
}

function getEventAssistanceId(event: SpineEvent): string | null {
  return (
    stringField(event.data.assistance_request_id) ??
    stringField(event.data.assistance_id) ??
    stringField(event.data.interaction_id) ??
    stringField(event.interaction_id)
  );
}

function readBrowserSurfaceStatus(event: SpineEvent): string | null {
  const browserSurface = event.data.browser_surface;
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
            format: def.format === "password" ? "password" : "text",
            label: stringField(def.title),
            name,
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
