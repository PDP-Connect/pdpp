// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  ResolvedGrant,
  ResolvedGrantStream,
  SourceDeclaration,
  SourceDeclarationStream,
} from "@pdpp/reference-contract/public/source";
import { CoreSourceAuthorizationError, parseCoreResolvedGrant } from "./core-source-authorization.ts";
import { requireSourceDeclaration } from "./source-declaration.ts";

type JsonObject = Record<string, unknown>;

export type ApprovedAuthorizationFailureCode =
  | "auth.source_id_empty"
  | "auth.access_mode_invalid"
  | "auth.streams_empty"
  | "auth.stream_name_empty"
  | "auth.stream_name_duplicate"
  | "auth.instance_ids_empty"
  | "auth.instance_id_empty"
  | "auth.instance_id_duplicate"
  | "auth.fields_empty"
  | "auth.field_empty"
  | "auth.field_duplicate"
  | "auth.time_constraint_invalid"
  | "auth.time_field_changed"
  | "auth.resources_empty"
  | "auth.resource_duplicate"
  | "auth.unknown_member"
  | "auth.widened";

export class ApprovedAuthorizationError extends Error {
  readonly code: ApprovedAuthorizationFailureCode;

  constructor(code: ApprovedAuthorizationFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ApprovedAuthorizationStream {
  fields: string[];
  instance_ids: string[];
  name: string;
  resources?: string[];
  time_constraint?: { field: string; since?: string; until?: string };
}

export interface ApprovedAuthorization {
  access_mode: "continuous" | "single_use";
  source_id: string;
  streams: ApprovedAuthorizationStream[];
}

export interface GrantedAuthorizationDetail {
  access_mode: "continuous" | "single_use";
  purpose_code: string;
  purpose_description?: string;
  retention?: { max_duration: string; on_expiry: "anonymize" | "delete" };
  selection_preset?: string;
  source: ResolvedGrant["source"];
  streams: ApprovedAuthorizationStream[];
  type: "https://pdpp.dev/data-access";
}

const RAR_DETAIL_KEYS = new Set([
  "access_mode",
  "purpose_code",
  "purpose_description",
  "retention",
  "selection_preset",
  "source",
  "streams",
  "type",
]);
const STREAM_KEYS = new Set(["fields", "instance_ids", "name", "resources", "time_constraint"]);
const TIME_CONSTRAINT_KEYS = new Set(["field", "since", "until"]);

function fail(code: ApprovedAuthorizationFailureCode, message: string): never {
  throw new ApprovedAuthorizationError(code, message);
}

function sourceFail(message: string): never {
  throw new CoreSourceAuthorizationError(message);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function rejectUnknownKeys(value: JsonObject, allowed: ReadonlySet<string>, context: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("auth.unknown_member", `${context} has unknown members: ${unknown.join(", ")}`);
  }
}

function requireNonEmptyArray(value: unknown, code: ApprovedAuthorizationFailureCode, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(code, `${label} must be a non-empty array`);
  }
  return value;
}

function requireUniqueStrings(
  value: unknown,
  codes: {
    duplicate: ApprovedAuthorizationFailureCode;
    emptyItem: ApprovedAuthorizationFailureCode;
    emptyList: ApprovedAuthorizationFailureCode;
  },
  label: string
): string[] {
  const items = requireNonEmptyArray(value, codes.emptyList, label);
  const strings: string[] = [];
  for (const item of items) {
    if (!isNonEmptyString(item)) {
      fail(codes.emptyItem, `${label} entries must be non-empty strings`);
    }
    strings.push(item);
  }
  if (new Set(strings).size !== strings.length) {
    fail(codes.duplicate, `${label} entries must be unique`);
  }
  return strings;
}

function requireCanonicalResources(value: unknown, declarationStream: SourceDeclarationStream): string[] | undefined {
  if (value === undefined) {
    return;
  }
  const resources = requireUniqueStrings(
    value,
    {
      duplicate: "auth.resource_duplicate",
      emptyItem: "auth.resources_empty",
      emptyList: "auth.resources_empty",
    },
    "resources"
  );
  if (declarationStream.primary_key.length === 1) {
    return resources;
  }
  for (const resource of resources) {
    let components: unknown;
    try {
      components = JSON.parse(resource);
    } catch {
      fail("auth.resources_empty", "Compound resource identifiers must be minified JSON string arrays");
    }
    if (
      !Array.isArray(components) ||
      components.length !== declarationStream.primary_key.length ||
      !components.every((component) => typeof component === "string") ||
      JSON.stringify(components) !== resource
    ) {
      fail("auth.resources_empty", "Compound resource identifiers must match the declared primary key");
    }
  }
  return resources;
}

function requireTimeConstraint(
  value: unknown,
  declarationStream: SourceDeclarationStream
): ApprovedAuthorizationStream["time_constraint"] {
  if (value === undefined) {
    return;
  }
  if (!isObject(value)) {
    fail("auth.time_constraint_invalid", "time_constraint must be an object");
  }
  rejectUnknownKeys(value, TIME_CONSTRAINT_KEYS, "time_constraint");
  if (!isNonEmptyString(value.field)) {
    fail("auth.time_constraint_invalid", "time_constraint.field must be a non-empty string");
  }
  if (value.field !== declarationStream.consent_time_field) {
    fail("auth.time_field_changed", "time_constraint.field does not match the retained SourceDeclaration");
  }
  const { since, until } = value;
  if (since === undefined && until === undefined) {
    fail("auth.time_constraint_invalid", "time_constraint needs since or until");
  }
  for (const bound of [since, until]) {
    if (bound !== undefined && !(isNonEmptyString(bound) && Number.isFinite(Date.parse(bound)))) {
      fail("auth.time_constraint_invalid", "time_constraint bounds must be ISO-8601 instants");
    }
  }
  if (isNonEmptyString(since) && isNonEmptyString(until) && Date.parse(since) > Date.parse(until)) {
    fail("auth.time_constraint_invalid", "time_constraint.since must not follow until");
  }
  return {
    field: value.field,
    ...(isNonEmptyString(since) ? { since } : {}),
    ...(isNonEmptyString(until) ? { until } : {}),
  };
}

function requireAuthorizationStream(value: unknown, declaration: SourceDeclaration): ApprovedAuthorizationStream {
  if (!isObject(value)) {
    fail("auth.stream_name_empty", "Each stream must be an object with a non-empty name");
  }
  rejectUnknownKeys(value, STREAM_KEYS, "stream");
  if (!isNonEmptyString(value.name)) {
    fail("auth.stream_name_empty", "Stream name must be a non-empty string");
  }
  const declarationStream = declaration.streams.find((stream) => stream.name === value.name);
  if (!declarationStream) {
    sourceFail(`Stream '${value.name}' is not present in the retained SourceDeclaration`);
  }
  const instanceIds = requireUniqueStrings(
    value.instance_ids,
    {
      duplicate: "auth.instance_id_duplicate",
      emptyItem: "auth.instance_id_empty",
      emptyList: "auth.instance_ids_empty",
    },
    `Stream '${value.name}' instance_ids`
  );
  const fields = requireUniqueStrings(
    value.fields,
    {
      duplicate: "auth.field_duplicate",
      emptyItem: "auth.field_empty",
      emptyList: "auth.fields_empty",
    },
    `Stream '${value.name}' fields`
  );
  const resources = requireCanonicalResources(value.resources, declarationStream);
  const timeConstraint = requireTimeConstraint(value.time_constraint, declarationStream);
  return {
    fields,
    instance_ids: instanceIds,
    name: value.name,
    ...(resources ? { resources } : {}),
    ...(timeConstraint ? { time_constraint: timeConstraint } : {}),
  };
}

function requireAuthorizationRights(value: unknown, declaration: SourceDeclaration): ApprovedAuthorization {
  if (!isObject(value)) {
    sourceFail("Approved authorization must be an object");
  }
  const { source } = value;
  const sourceId = isObject(source) ? source.id : null;
  if (!isNonEmptyString(sourceId)) {
    fail("auth.source_id_empty", "source.id must be a non-empty string");
  }
  if (value.access_mode !== "single_use" && value.access_mode !== "continuous") {
    fail("auth.access_mode_invalid", "access_mode must be single_use or continuous");
  }
  if (!Array.isArray(value.streams) || value.streams.length === 0) {
    fail("auth.streams_empty", "streams must be a non-empty array");
  }
  const streams = value.streams.map((stream) => requireAuthorizationStream(stream, declaration));
  if (new Set(streams.map((stream) => stream.name)).size !== streams.length) {
    fail("auth.stream_name_duplicate", "Stream names must be unique");
  }
  return { access_mode: value.access_mode, source_id: sourceId, streams };
}

function requireSourceMetadataMatch(value: unknown, declaration: SourceDeclaration): void {
  if (!(isObject(value) && isObject(value.source))) {
    sourceFail("Approved authorization source metadata is missing");
  }
  if (value.source.id !== declaration.source.id || value.source.kind !== declaration.source.kind) {
    sourceFail("Approved authorization source metadata does not match the retained SourceDeclaration");
  }
}

function retainedDeclaration(value: unknown): SourceDeclaration {
  try {
    return requireSourceDeclaration(value);
  } catch (cause: unknown) {
    const error = new CoreSourceAuthorizationError("Retained SourceDeclaration is invalid");
    error.cause = cause;
    throw error;
  }
}

export function parseResolvedGrantApprovedAuthorization(
  value: unknown,
  retainedDeclarationInput: unknown
): ApprovedAuthorization {
  const declaration = retainedDeclaration(retainedDeclarationInput);
  const projected = requireAuthorizationRights(value, declaration);
  const grant = parseCoreResolvedGrant(value);
  requireSourceMetadataMatch(grant, declaration);
  return projected;
}

function requireGrantedPolicy(value: JsonObject): void {
  if (value.type !== "https://pdpp.dev/data-access" || !isNonEmptyString(value.purpose_code)) {
    sourceFail("Granted authorization detail has invalid type or purpose_code");
  }
  if (value.purpose_description !== undefined && !isNonEmptyString(value.purpose_description)) {
    sourceFail("Granted authorization detail has an invalid purpose_description");
  }
  if (value.selection_preset !== undefined && !isNonEmptyString(value.selection_preset)) {
    sourceFail("Granted authorization detail has an invalid selection_preset");
  }
  if (value.retention !== undefined) {
    const { retention } = value;
    if (
      !isObject(retention) ||
      Object.keys(retention).some((key) => key !== "max_duration" && key !== "on_expiry") ||
      !isNonEmptyString(retention.max_duration) ||
      (retention.on_expiry !== "delete" && retention.on_expiry !== "anonymize")
    ) {
      sourceFail("Granted authorization detail has invalid retention policy");
    }
  }
}

/** Validate the closed RFC 9396 carrier fields without re-resolving Source metadata. */
export function requireGrantedAuthorizationDetailEnvelope(value: unknown): JsonObject {
  if (!isObject(value)) {
    sourceFail("Granted authorization detail must be an object");
  }
  rejectUnknownKeys(value, RAR_DETAIL_KEYS, "Granted authorization detail");
  requireGrantedPolicy(value);
  return value;
}

export function parseGrantedAuthorizationDetail(
  value: unknown,
  retainedDeclarationInput: unknown
): { authorization: ApprovedAuthorization; detail: GrantedAuthorizationDetail } {
  const detail = requireGrantedAuthorizationDetailEnvelope(value);
  const declaration = retainedDeclaration(retainedDeclarationInput);
  const authorization = requireAuthorizationRights(detail, declaration);
  requireSourceMetadataMatch(detail, declaration);
  return { authorization, detail: structuredClone(detail) as unknown as GrantedAuthorizationDetail };
}

export function buildGrantedAuthorizationDetail(value: unknown): GrantedAuthorizationDetail {
  const grant = parseCoreResolvedGrant(value);
  return {
    access_mode: grant.access_mode,
    purpose_code: grant.purpose_code,
    ...(grant.purpose_description ? { purpose_description: grant.purpose_description } : {}),
    ...(grant.retention ? { retention: structuredClone(grant.retention) } : {}),
    ...(grant.selection_preset ? { selection_preset: grant.selection_preset } : {}),
    source: structuredClone(grant.source),
    streams: structuredClone(grant.streams),
    type: "https://pdpp.dev/data-access",
  };
}

function isSubset(actual: readonly string[], ceiling: readonly string[]): boolean {
  const allowed = new Set(ceiling);
  return actual.every((value) => allowed.has(value));
}

function isTimeConstraintNarrower(
  actual: ApprovedAuthorizationStream["time_constraint"],
  ceiling: ApprovedAuthorizationStream["time_constraint"]
): boolean {
  if (!ceiling) {
    return true;
  }
  if (!actual || actual.field !== ceiling.field) {
    return false;
  }
  if (ceiling.since && (!actual.since || Date.parse(actual.since) < Date.parse(ceiling.since))) {
    return false;
  }
  if (ceiling.until && (!actual.until || Date.parse(actual.until) > Date.parse(ceiling.until))) {
    return false;
  }
  return true;
}

export function requireApprovedAuthorizationNarrowing(
  actual: ApprovedAuthorization,
  ceiling: ApprovedAuthorization
): void {
  if (actual.source_id !== ceiling.source_id || actual.access_mode !== ceiling.access_mode) {
    fail("auth.widened", "Approved authorization changed its source or access mode");
  }
  const ceilingStreams = new Map(ceiling.streams.map((stream) => [stream.name, stream]));
  for (const stream of actual.streams) {
    const limit = ceilingStreams.get(stream.name);
    if (
      !(limit && isSubset(stream.instance_ids, limit.instance_ids) && isSubset(stream.fields, limit.fields)) ||
      (limit.resources && !(stream.resources && isSubset(stream.resources, limit.resources))) ||
      !isTimeConstraintNarrower(stream.time_constraint, limit.time_constraint)
    ) {
      fail("auth.widened", `Approved stream '${stream.name}' exceeds the requested authorization`);
    }
  }
}

export function approvedAuthorizationFromStreams(
  sourceId: string,
  accessMode: ApprovedAuthorization["access_mode"],
  streams: readonly ResolvedGrantStream[]
): ApprovedAuthorization {
  return {
    access_mode: accessMode,
    source_id: sourceId,
    streams: streams.map((stream) => structuredClone(stream)),
  };
}
