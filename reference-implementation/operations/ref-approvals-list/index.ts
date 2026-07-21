/**
 * Canonical `ref.approvals.list` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * pending-approvals queue that powers `GET /_ref/approvals`. Host
 * adapters supply pending consent and pending owner-device approvals via
 * the dependency contract; the operation owns the
 * `{object: 'list', data}` envelope, the redaction guarantees
 * (`request_uri` / `user_code` projected as `null`), and the
 * created-at-descending sort across both kinds.
 *
 * Security: `device_code`, `user_code`, and the canonical `request_uri`
 * (which embeds `device_code`) MUST NOT appear in any approval entry the
 * operation emits. Host adapters MUST inject already-redacted entries —
 * the operation re-asserts the invariant defensively but the dependency
 * is the source of truth for the redaction.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must not
 * depend on the response shape.
 *
 * Boundary rules (see openspec/changes/mount-ref-connectors-approvals-operations):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   a raw SQL handle, sandbox modules, `reference-implementation/server/*`
 *   route or auth modules, or `process` / `process.env`.
 * - Pending consent and pending owner-device reads flow in through
 *   dependencies. The host wires the concrete reads (e.g.
 *   `listPendingApprovals` in `server/ref-control.ts`, which already
 *   composes the consent-store and owner-device-auth-store sources).
 */

export interface RefApprovalConsentGrantPreview {
  readonly connector_id: string | null;
  readonly provider_id: string | null;
  readonly access_mode: string | null;
  readonly purpose_code: string | null;
  readonly purpose_description: string | null;
  readonly streams: unknown[];
}

export interface RefApprovalConsent {
  readonly object: "approval";
  readonly approval_id: string;
  readonly kind: "consent";
  readonly client_id: string | null;
  readonly request_uri: null;
  readonly user_code: null;
  readonly created_at: string;
  readonly grant_preview: RefApprovalConsentGrantPreview;
}

export interface RefApprovalOwnerDevice {
  readonly object: "approval";
  readonly approval_id: string;
  readonly kind: "owner_device";
  readonly client_id: string;
  readonly request_uri: null;
  readonly user_code: null;
  readonly created_at: string;
  readonly grant_preview: null;
}

export type RefApproval = RefApprovalConsent | RefApprovalOwnerDevice;

export interface RefApprovalsListDependencies {
  /**
   * Returns the pending approvals to surface in the operator queue. The
   * host implementation owns the substrate read and the redaction (the
   * operation enforces that `request_uri` and `user_code` are `null` so a
   * future regression in the dependency cannot leak the device-code-
   * equivalent secrets).
   */
  listPendingApprovals(): Promise<readonly RefApproval[]> | readonly RefApproval[];
}

export interface RefApprovalsListEnvelope {
  readonly object: "list";
  readonly data: RefApproval[];
}

function compareCreatedAtDesc(left: RefApproval, right: RefApproval): number {
  if (left.created_at === right.created_at) {
    return 0;
  }
  return left.created_at < right.created_at ? 1 : -1;
}

/**
 * Execute the canonical `ref.approvals.list` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation assembles the
 * `{object: 'list', data}` envelope, sorts by `created_at` descending
 * across both kinds, and re-asserts the request_uri/user_code redaction
 * invariant. The operation has no notion of HTTP, owner sessions,
 * headers, or framework.
 */
export async function executeRefApprovalsList(
  dependencies: RefApprovalsListDependencies,
): Promise<RefApprovalsListEnvelope> {
  const approvals = await dependencies.listPendingApprovals();
  const data: RefApproval[] = [...approvals];

  for (const approval of data) {
    if (approval.request_uri !== null || approval.user_code !== null) {
      throw new Error(
        "ref.approvals.list: dependency leaked request_uri or user_code; both MUST be null",
      );
    }
  }

  data.sort(compareCreatedAtDesc);

  return {
    object: "list",
    data,
  };
}
