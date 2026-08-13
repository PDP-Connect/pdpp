// SPDX-FileCopyrightText: The PDP-Connect Contributors
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers that exercise the current thin PDPP reference provider-connect
 * flow:
 *
 *   POST /oauth/register      (public-client self-registration)
 *   POST /oauth/par           (PAR request staging)
 *   POST /consent/review      (finalize and inspect the approval artifact)
 *   POST /consent/approve     (approve the reviewed artifact)
 *   POST /consent/deny        (reference-local inline denial shortcut)
 *   GET  {rs}/v1/streams      (owner/client RS read)
 *
 * This is **not** a generic OAuth authorization-code redirect client. It is a
 * small harness that mirrors the exact contract the reference AS currently
 * advertises so the example app can illustrate it end to end against a local
 * reference server.
 */

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface JsonObject {
  [key: string]: JsonValue;
}
type ResponseBody = { kind: "json"; value: unknown } | { kind: "text"; value: string };
type SourceKind = "connector" | "provider_native";
type RegistrationMetadata = { client_name: string; token_endpoint_auth_method: "none" } & JsonObject;
type RegisteredClient = JsonObject & { client_id: string };
type ParResponse = JsonObject & { request_uri: string; authorization_url?: string };
interface StreamsResponse {
  streams?: unknown[];
  [key: string]: unknown;
}
interface ParRequest {
  authorization_details: Array<{
    access_mode?: string;
    purpose_code?: string;
    purpose_description?: string;
    source: { id: string; kind: SourceKind };
    streams: Array<{ name: string }>;
    type: string;
  }>;
  client_display?: { name: string };
  client_id: string;
}
function jsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function registeredClient(value: unknown): RegisteredClient {
  const object = jsonObject(value, "registration response");
  if (typeof object.client_id !== "string" || !object.client_id) {
    throw new Error("registration response did not include client_id");
  }
  return object as RegisteredClient;
}

function parResponse(value: unknown): ParResponse {
  const object = jsonObject(value, "PAR response");
  if (typeof object.request_uri !== "string" || !object.request_uri) {
    throw new Error("PAR response did not include request_uri");
  }
  return object as ParResponse;
}
class RequestError extends Error {
  status?: number;
  ownerAuthEnabled?: boolean;
}

function asForm(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

async function readJsonOrText(response: Response): Promise<ResponseBody> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return { kind: "json", value: await response.json() };
  }
  const text = await response.text();
  return { kind: "text", value: text };
}

function describeFailure(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object") {
    const objectBody = body as Record<string, unknown>;
    if (typeof objectBody.error_description === "string" && objectBody.error_description) {
      return objectBody.error_description;
    }
    if (typeof objectBody.error === "string" && objectBody.error) {
      return objectBody.error;
    }
    if (
      objectBody.error &&
      typeof objectBody.error === "object" &&
      "message" in objectBody.error &&
      typeof objectBody.error.message === "string"
    ) {
      return objectBody.error.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return fallback;
}

export async function registerClient({
  asUrl,
  initialAccessToken,
  metadata,
}: {
  asUrl: string;
  initialAccessToken: string;
  metadata: RegistrationMetadata;
}): Promise<RegisteredClient> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (initialAccessToken) {
    headers.Authorization = `Bearer ${initialAccessToken}`;
  }
  const response = await fetch(`${asUrl}/oauth/register`, {
    body: JSON.stringify(metadata),
    headers,
    method: "POST",
  });
  const body = await readJsonOrText(response);
  if (!response.ok || body.kind !== "json") {
    const err = new RequestError(describeFailure(body.value, `client registration failed (${response.status})`));
    err.status = response.status;
    throw err;
  }
  return registeredClient(body.value);
}

export function buildParRequest({
  clientId,
  clientName,
  sourceKind,
  sourceId,
  streamName,
  purposeCode,
  purposeDescription,
  accessMode,
}: {
  clientId: string;
  clientName?: string;
  sourceKind: SourceKind;
  sourceId: string;
  streamName: string;
  purposeCode?: string;
  purposeDescription?: string;
  accessMode?: string;
}): ParRequest {
  if (!clientId) {
    throw new Error("clientId is required");
  }
  if (sourceKind !== "connector" && sourceKind !== "provider_native") {
    throw new Error("sourceKind must be 'connector' or 'provider_native'");
  }
  if (!sourceId) {
    throw new Error("sourceId is required");
  }
  if (!streamName) {
    throw new Error("streamName is required");
  }
  return {
    client_id: clientId,
    ...(clientName ? { client_display: { name: clientName } } : {}),
    authorization_details: [
      {
        source: { id: sourceId, kind: sourceKind },
        type: "https://pdpp.dev/data-access",
        ...(purposeCode ? { purpose_code: purposeCode } : {}),
        ...(purposeDescription ? { purpose_description: purposeDescription } : {}),
        ...(accessMode ? { access_mode: accessMode } : {}),
        streams: [{ name: streamName }],
      },
    ],
  };
}

export async function stageParRequest({
  asUrl,
  request,
}: {
  asUrl: string;
  request: ParRequest;
}): Promise<ParResponse> {
  const response = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readJsonOrText(response);
  if (!response.ok || body.kind !== "json") {
    const err = new RequestError(describeFailure(body.value, `PAR staging failed (${response.status})`));
    err.status = response.status;
    throw err;
  }
  return parResponse(body.value);
}

export function buildHostedApprovalUrl({ asUrl, requestUri }: { asUrl: string; requestUri: string }): string {
  const url = new URL(`${asUrl}/consent`);
  url.searchParams.set("request_uri", requestUri);
  return url.toString();
}

/**
 * Finalize the exact approval artifact before approval. The returned artifact
 * is the server's reviewable projection. The revision binds the final approval
 * to those facts, so the caller must not submit selection choices again.
 */
export async function reviewInline({
  asUrl,
  requestUri,
  subjectId,
}: {
  asUrl: string;
  requestUri: string;
  subjectId: string;
}): Promise<{ requestUri: string; review: unknown; revision: string }> {
  const response = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readJsonOrText(response);
  if (!response.ok || body.kind !== "json") {
    const err = new RequestError(describeFailure(body.value, `approval review failed (${response.status})`));
    err.status = response.status;
    if (response.status === 401 || response.status === 403) {
      err.ownerAuthEnabled = true;
    }
    throw err;
  }
  const reviewBody = jsonObject(body.value, "approval review response");
  const revision = reviewBody.approval_review_revision;
  if (typeof revision !== "string" || !revision) {
    throw new Error("approval review returned without approval_review_revision");
  }
  if (
    !reviewBody.approval_review ||
    typeof reviewBody.approval_review !== "object" ||
    Array.isArray(reviewBody.approval_review)
  ) {
    throw new Error("approval review returned without the exact approval artifact");
  }
  const canonicalRequestUri = reviewBody.request_uri;
  if (typeof canonicalRequestUri !== "string" || canonicalRequestUri !== requestUri) {
    throw new Error("approval review returned a different canonical request_uri");
  }
  return { requestUri: canonicalRequestUri, review: reviewBody.approval_review, revision };
}

/**
 * Reference-local JSON approval flow. It reviews the exact artifact first,
 * then submits only its revision for final approval.
 */
export async function approveInline({
  asUrl,
  requestUri,
  subjectId,
}: {
  asUrl: string;
  requestUri: string;
  subjectId: string;
}): Promise<{ token: string; grantId: string | null; grant: unknown }> {
  const reviewed = await reviewInline({ asUrl, requestUri, subjectId });
  const response = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ approval_review_revision: reviewed.revision, request_uri: reviewed.requestUri }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    const err = new RequestError(
      "Inline approval redirected — the reference server appears to have owner authentication enabled. Use the hosted consent page instead."
    );
    err.status = response.status;
    err.ownerAuthEnabled = true;
    throw err;
  }
  if (response.status === 401) {
    const err = new RequestError(
      "Inline approval was rejected with 401 — the reference server appears to have owner authentication enabled. Use the hosted consent page instead."
    );
    err.status = 401;
    err.ownerAuthEnabled = true;
    throw err;
  }
  const body = await readJsonOrText(response);
  if (!response.ok) {
    const err = new RequestError(describeFailure(body.value, `approval failed (${response.status})`));
    err.status = response.status;
    throw err;
  }
  if (body.kind !== "json" || !body.value || typeof body.value !== "object") {
    const err = new RequestError(
      "Inline approval returned a non-JSON response — the reference server appears to have owner authentication enabled. Use the hosted consent page instead."
    );
    err.status = response.status;
    err.ownerAuthEnabled = true;
    throw err;
  }
  const approval = jsonObject(body.value, "approval response");
  const { token, grant_id, grant } = approval;
  if (typeof token !== "string" || !token) {
    throw new Error("approval returned without a token");
  }
  const grantId = typeof grant_id === "string" && grant_id ? grant_id : null;
  return { grant: grant ?? null, grantId, token };
}

export async function denyInline({ asUrl, requestUri }: { asUrl: string; requestUri: string }): Promise<{ ok: true }> {
  const response = await fetch(`${asUrl}/consent/deny`, {
    body: asForm({ request_uri: requestUri }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    const err = new RequestError(
      "Inline denial redirected — the reference server appears to have owner authentication enabled. Use the hosted consent page instead."
    );
    err.status = response.status;
    err.ownerAuthEnabled = true;
    throw err;
  }
  if (response.status === 401) {
    const err = new RequestError(
      "Inline denial was rejected with 401 — the reference server appears to have owner authentication enabled. Use the hosted consent page instead."
    );
    err.status = 401;
    err.ownerAuthEnabled = true;
    throw err;
  }
  if (!response.ok) {
    const body = await readJsonOrText(response);
    throw new Error(describeFailure(body.value, `denial failed (${response.status})`));
  }
  return { ok: true };
}

export async function queryStreams({ rsUrl, token }: { rsUrl: string; token: string }): Promise<StreamsResponse> {
  const response = await fetch(`${rsUrl}/v1/streams`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new Error(describeFailure(body.value, `streams query failed (${response.status})`));
  }
  return jsonObject(body.value, "streams response") as StreamsResponse;
}

export async function queryStreamRecords({
  rsUrl,
  token,
  streamName,
  limit = 10,
}: {
  rsUrl: string;
  token: string;
  streamName: string;
  limit?: number;
}): Promise<unknown> {
  const url = new URL(`${rsUrl}/v1/streams/${encodeURIComponent(streamName)}/records`);
  if (limit) {
    url.searchParams.set("limit", String(limit));
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new Error(describeFailure(body.value, `records query failed (${response.status})`));
  }
  return body.value;
}
