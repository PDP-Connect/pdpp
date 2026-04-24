/**
 * Server-only helpers for acting on pending approvals through the existing
 * public approval routes.
 */
import { getAsInternalUrl, ReferenceServerUnreachableError, withOwnerSessionCookie } from "./owner-token.ts";

const PENDING_CONSENT_REQUEST_URI_PREFIX = "urn:pdpp:pending-consent:";

function asForm(body: Record<string, string>): string {
  return new URLSearchParams(body).toString();
}

function readBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

function describeError(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const oauth = body as {
      error?: string | { message?: string };
      error_description?: string;
    };
    if (typeof oauth.error_description === "string" && oauth.error_description) {
      return oauth.error_description;
    }
    if (typeof oauth.error === "string" && oauth.error) {
      return oauth.error;
    }
    if (
      oauth.error &&
      typeof oauth.error === "object" &&
      typeof oauth.error.message === "string" &&
      oauth.error.message
    ) {
      return oauth.error.message;
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return fallback;
}

async function fetchAs(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(
      `${getAsInternalUrl()}${path}`,
      await withOwnerSessionCookie({
        cache: "no-store",
        ...init,
      })
    );
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, err);
  }
}

function buildPendingConsentRequestUri(approvalId: string): string {
  return `${PENDING_CONSENT_REQUEST_URI_PREFIX}${approvalId}`;
}

export async function approveConsentRequest(requestUri: string, subjectId = "owner_local") {
  const response = await fetchAs("/consent/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_uri: requestUri,
      subject_id: subjectId,
    }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `consent approval failed (${response.status})`));
  }
  return body;
}

export async function denyConsentRequest(requestUri: string) {
  const response = await fetchAs("/consent/deny", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_uri: requestUri,
    }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `consent denial failed (${response.status})`));
  }
  return body;
}

export async function approvePendingApproval(input: {
  kind: "consent" | "owner_device";
  approvalId: string;
  userCode?: string | null;
  subjectId?: string;
}) {
  if (input.kind === "consent") {
    return approveConsentRequest(buildPendingConsentRequestUri(input.approvalId), input.subjectId || "owner_local");
  }

  if (!input.userCode) {
    throw new Error("owner-device approval requires user_code");
  }

  const response = await fetchAs("/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: asForm({
      user_code: input.userCode,
      subject_id: input.subjectId || "owner_local",
    }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `device approval failed (${response.status})`));
  }
  return body;
}

export async function denyPendingApproval(input: {
  kind: "consent" | "owner_device";
  approvalId: string;
  userCode?: string | null;
  subjectId?: string;
}) {
  if (input.kind === "consent") {
    return denyConsentRequest(buildPendingConsentRequestUri(input.approvalId));
  }

  if (!input.userCode) {
    throw new Error("owner-device denial requires user_code");
  }

  const response = await fetchAs("/device/deny", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: asForm({
      user_code: input.userCode,
      subject_id: input.subjectId || "owner_local",
    }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `device denial failed (${response.status})`));
  }
  return body;
}
