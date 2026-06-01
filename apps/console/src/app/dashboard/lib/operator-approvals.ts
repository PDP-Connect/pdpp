/**
 * Server-only helpers for acting on pending approvals through the existing
 * public approval routes.
 *
 * Both consent and owner-device approve/deny POST `approval_id`, the
 * non-redeemable opaque public id projected by `/_ref/approvals`. The AS
 * resolves it to the live `device_code` / `user_code` internally behind
 * the existing owner-session + CSRF gate; the dashboard never sees those
 * bearer-equivalent values.
 */
import { describeError } from "./describe-error.ts";
import { getAsInternalUrl, ReferenceServerUnreachableError, withOwnerSessionCookie } from "./owner-token.ts";

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

/**
 * Used by the staged-request workspace (operator-grant-request) where the
 * dashboard itself initiated a PAR call and already holds the canonical
 * `request_uri` it received back. Distinct from the /_ref/approvals path,
 * which projects only the opaque `approval_id`.
 */
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
  if (!input.approvalId) {
    throw new Error(`${input.kind} approval requires approval_id`);
  }
  const subjectId = input.subjectId || "owner_local";

  if (input.kind === "consent") {
    const response = await fetchAs("/consent/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approval_id: input.approvalId,
        subject_id: subjectId,
      }),
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new Error(describeError(body, `consent approval failed (${response.status})`));
    }
    return body;
  }

  const response = await fetchAs("/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: asForm({
      approval_id: input.approvalId,
      subject_id: subjectId,
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
  if (!input.approvalId) {
    throw new Error(`${input.kind} denial requires approval_id`);
  }
  const subjectId = input.subjectId || "owner_local";

  if (input.kind === "consent") {
    const response = await fetchAs("/consent/deny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approval_id: input.approvalId,
      }),
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new Error(describeError(body, `consent denial failed (${response.status})`));
    }
    return body;
  }

  const response = await fetchAs("/device/deny", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: asForm({
      approval_id: input.approvalId,
      subject_id: subjectId,
    }),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `device denial failed (${response.status})`));
  }
  return body;
}
