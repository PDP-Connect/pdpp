// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `ref.approvals.detail` operation.
 *
 * This is a reference/operator projection, not a PDPP protocol endpoint. The
 * host supplies a live, allowlisted review object for an opaque approval id;
 * this operation provides a second defensive boundary against raw pending-row
 * material reaching an owner-console response.
 */

export type RefApprovalJson = boolean | null | number | string | RefApprovalJson[] | { [key: string]: RefApprovalJson };

export interface RefApprovalStreamReview {
  readonly client_claims: RefApprovalJson | null;
  readonly connection_id: string | null;
  readonly fields: readonly string[] | null;
  readonly name: string;
  readonly necessity: string | null;
  readonly resources: readonly RefApprovalJson[] | null;
  readonly time_range: { readonly since: string | null } | null;
  readonly view: string | null;
}

export interface RefApprovalConsentDetail {
  readonly approval_id: string;
  readonly client: {
    readonly client_id: string;
    readonly display: {
      readonly name: string | null;
      readonly policy_uri: string | null;
      readonly tos_uri: string | null;
      readonly uri: string | null;
    };
    readonly registration_mode: string;
  };
  readonly created_at: string;
  readonly expires_at: string;
  readonly grant_outcome: { readonly access_mode: string; readonly description: string };
  readonly kind: "consent";
  readonly object: "approval_review";
  readonly purpose: { readonly code: string | null; readonly description: string | null };
  readonly retention: RefApprovalJson | null;
  readonly source: { readonly id: string; readonly kind: "connector" | "provider_native" } | null;
  readonly streams: readonly RefApprovalStreamReview[];
  readonly trust: "unverified";
}

export interface RefApprovalOwnerDeviceDetail {
  readonly approval_id: string;
  readonly client_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly kind: "owner_device";
  readonly object: "approval_review";
}

export type RefApprovalDetail = RefApprovalConsentDetail | RefApprovalOwnerDeviceDetail;

export interface RefApprovalDetailDependencies {
  getPendingApprovalDetail: () => Promise<RefApprovalDetail | null> | RefApprovalDetail | null;
}

const FORBIDDEN_PROPERTY_NAMES = new Set([
  "access_token",
  "api_key",
  "authorization",
  "auth_token",
  "bearer_token",
  "client_secret",
  "device_code",
  "id_token",
  "params_json",
  "password",
  "refresh_token",
  "request_uri",
  "secret",
  "token",
  "user_code",
]);

function normalizedPropertyName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]/g, "_")
    .toLowerCase();
}

function isForbiddenPropertyName(value: string): boolean {
  return FORBIDDEN_PROPERTY_NAMES.has(normalizedPropertyName(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function safeDisplayUri(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    return null;
  }
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

function safeJson(value: unknown): RefApprovalJson | null {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(safeJson).filter((item): item is RefApprovalJson => item !== null);
  }
  if (!isRecord(value)) {
    return null;
  }
  const out: Record<string, RefApprovalJson> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenPropertyName(key)) {
      continue;
    }
    const safe = safeJson(nested);
    if (safe !== null) {
      out[key] = safe;
    }
  }
  return out;
}

function streamReview(value: unknown): RefApprovalStreamReview | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = stringField(value.name);
  if (!name) {
    return null;
  }
  const fields = Array.isArray(value.fields)
    ? value.fields.filter((field): field is string => typeof field === "string")
    : null;
  const resources = Array.isArray(value.resources)
    ? value.resources.map(safeJson).filter((item): item is RefApprovalJson => item !== null)
    : null;
  const timeRange = isRecord(value.time_range) ? { since: stringField(value.time_range.since) } : null;
  return {
    client_claims: safeJson(value.client_claims),
    connection_id: stringField(value.connection_id),
    fields,
    name,
    necessity: stringField(value.necessity),
    resources,
    time_range: timeRange,
    view: stringField(value.view),
  };
}

function grantOutcome(accessMode: string): RefApprovalConsentDetail["grant_outcome"] {
  if (accessMode === "single_use") {
    return {
      access_mode: accessMode,
      description: "One-time access; this reference grant expires 24 hours after approval.",
    };
  }
  return {
    access_mode: accessMode,
    description: "Ongoing access; this reference implementation sets no grant expiry.",
  };
}

export function isPendingApprovalRow(row: { expires_at?: unknown; status?: unknown } | null): boolean {
  return Boolean(
    row &&
      row.status === "pending" &&
      typeof row.expires_at === "string" &&
      Number.isFinite(Date.parse(row.expires_at)) &&
      Date.parse(row.expires_at) > Date.now()
  );
}

export function buildConsentApprovalDetail(
  row: {
    approval_id?: unknown;
    created_at?: unknown;
    expires_at?: unknown;
  },
  request: Record<string, unknown>,
  resolvedStreams: unknown[]
): RefApprovalConsentDetail | null {
  if (typeof row.approval_id !== "string" || typeof row.created_at !== "string" || typeof row.expires_at !== "string") {
    return null;
  }
  if (!(isRecord(request.client) && isRecord(request.selection))) {
    return null;
  }
  const clientId = stringField(request.client.client_id);
  const accessMode = stringField(request.selection.access_mode);
  if (!(clientId && accessMode)) {
    return null;
  }
  const display = isRecord(request.client.client_display) ? request.client.client_display : {};
  const source: RefApprovalConsentDetail["source"] =
    isRecord(request.source_binding) &&
    (request.source_binding.kind === "connector" || request.source_binding.kind === "provider_native") &&
    typeof request.source_binding.id === "string"
      ? { id: request.source_binding.id, kind: request.source_binding.kind }
      : null;
  const streams = resolvedStreams
    .map(streamReview)
    .filter((stream): stream is RefApprovalStreamReview => stream !== null);
  return {
    approval_id: row.approval_id,
    client: {
      client_id: clientId,
      display: {
        name: stringField(display.name),
        policy_uri: safeDisplayUri(display.policy_uri),
        tos_uri: safeDisplayUri(display.tos_uri),
        uri: safeDisplayUri(display.uri),
      },
      registration_mode: stringField(request.client.registration_mode) ?? "unknown",
    },
    created_at: row.created_at,
    expires_at: row.expires_at,
    grant_outcome: grantOutcome(accessMode),
    kind: "consent",
    object: "approval_review",
    purpose: {
      code: stringField(request.selection.purpose_code),
      description: stringField(request.selection.purpose_description),
    },
    retention: safeJson(request.selection.retention),
    source,
    streams,
    trust: "unverified",
  };
}

export function buildLiveConsentApprovalDetail(
  row: {
    approval_id?: unknown;
    created_at?: unknown;
    expires_at?: unknown;
    status?: unknown;
  } | null,
  pending: { request?: unknown; resolvedStreams?: unknown } | null
): RefApprovalConsentDetail | null {
  if (!(row && isPendingApprovalRow(row))) {
    return null;
  }
  if (!isRecord(pending?.request)) {
    return null;
  }
  const resolvedStreams = Array.isArray(pending.resolvedStreams) ? pending.resolvedStreams : [];
  return buildConsentApprovalDetail(row, pending.request, resolvedStreams);
}

export function buildOwnerDeviceApprovalDetail(
  row: {
    approval_id?: unknown;
    client_id?: unknown;
    created_at?: unknown;
    expires_at?: unknown;
    status?: unknown;
  } | null
): RefApprovalOwnerDeviceDetail | null {
  if (
    !(row && isPendingApprovalRow(row)) ||
    typeof row.approval_id !== "string" ||
    typeof row.client_id !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.expires_at !== "string"
  ) {
    return null;
  }
  return {
    approval_id: row.approval_id,
    client_id: row.client_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    kind: "owner_device",
    object: "approval_review",
  };
}

function assertNoForbiddenProperty(value: RefApprovalJson | RefApprovalDetail, path = "approval review"): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoForbiddenProperty(item, path);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenPropertyName(key)) {
      throw new Error(`ref.approvals.detail: dependency leaked forbidden ${key} at ${path}`);
    }
    assertNoForbiddenProperty(nested as RefApprovalJson, `${path}.${key}`);
  }
}

export async function executeRefApprovalDetail(
  dependencies: RefApprovalDetailDependencies
): Promise<RefApprovalDetail | null> {
  const detail = await dependencies.getPendingApprovalDetail();
  if (!detail) {
    return null;
  }
  assertNoForbiddenProperty(detail);
  return detail;
}
