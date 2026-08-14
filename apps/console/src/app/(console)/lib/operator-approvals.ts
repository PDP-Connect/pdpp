// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import { requireOneClickConsentApproval } from "./pending-consent-review.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readConsentReview(
  body: unknown,
  expectedRequestUri?: string
): { approvalReview: Record<string, unknown>; batch: boolean; requestUri: string; revision: string } {
  if (!isRecord(body)) {
    throw new Error("consent review returned a non-object response");
  }
  if (!isRecord(body.approval_review)) {
    throw new Error("consent review returned without the exact approval artifact");
  }
  if (typeof body.approval_review_revision !== "string" || !body.approval_review_revision) {
    throw new Error("consent review returned without approval_review_revision");
  }
  if (typeof body.request_uri !== "string" || !body.request_uri) {
    throw new Error("consent review returned without canonical request_uri");
  }
  if (expectedRequestUri && body.request_uri !== expectedRequestUri) {
    throw new Error("consent review returned a different request_uri");
  }
  return {
    approvalReview: body.approval_review,
    batch: body.batch === true,
    requestUri: body.request_uri,
    revision: body.approval_review_revision,
  };
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
    // ReferenceServerUnreachableError already threads `err` through to
    // Error's native `cause` (see its constructor in owner-token.ts); Biome's
    // syntactic check doesn't look inside a custom class to see that.
    // biome-ignore lint/style/useErrorCause: see comment above.
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
  const reviewResponse = await fetchAs("/consent/review", {
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const reviewBody = await readBody(reviewResponse);
  if (!reviewResponse.ok) {
    throw new Error(describeError(reviewBody, `consent review failed (${reviewResponse.status})`));
  }
  const review = readConsentReview(reviewBody, requestUri);
  requireOneClickConsentApproval(review);

  const response = await fetchAs("/consent/approve", {
    body: JSON.stringify({
      approval_review_revision: review.revision,
      request_uri: review.requestUri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `consent approval failed (${response.status})`));
  }
  return body;
}

export async function denyConsentRequest(requestUri: string) {
  const response = await fetchAs("/consent/deny", {
    body: JSON.stringify({
      request_uri: requestUri,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
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
  approvalReviewRevision?: string;
  requestUri?: string;
  userCode?: string | null;
  subjectId?: string;
}) {
  if (!input.approvalId) {
    throw new Error(`${input.kind} approval requires approval_id`);
  }
  const subjectId = input.subjectId || "owner_local";

  if (input.kind === "consent") {
    if (!(input.requestUri && input.approvalReviewRevision)) {
      throw new Error("consent approval requires reviewed request_uri and approval_review_revision");
    }
    const response = await fetchAs("/consent/approve", {
      body: JSON.stringify({
        approval_review_revision: input.approvalReviewRevision,
        request_uri: input.requestUri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new Error(describeError(body, `consent approval failed (${response.status})`));
    }
    return body;
  }

  const response = await fetchAs("/device/approve", {
    body: asForm({
      approval_id: input.approvalId,
      subject_id: subjectId,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
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
      body: JSON.stringify({
        approval_id: input.approvalId,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new Error(describeError(body, `consent denial failed (${response.status})`));
    }
    return body;
  }

  const response = await fetchAs("/device/deny", {
    body: asForm({
      approval_id: input.approvalId,
      subject_id: subjectId,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(describeError(body, `device denial failed (${response.status})`));
  }
  return body;
}
