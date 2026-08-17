// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure link-shape helpers for the connection setup-status page.
 *
 * Extracted from page.tsx so the retry/setup href logic is unit-testable
 * without importing a Next.js page module (JSX, `notFound()`, etc.) into
 * `node:test`. See connect-status-links.test.ts for the regression coverage
 * this closes: `setupHref` for a static-secret connection MUST carry
 * `connection_id` so the "Re-enter credential and retry" CTA lands on the
 * existing connection's REPLACE flow, not a brand-new draft.
 */

export interface ConnectStatusLinkStatus {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly setup_kind: string;
  readonly status: string;
}

export function setupHref(status: ConnectStatusLinkStatus): string {
  const encoded = encodeURIComponent(status.connector_id);
  if (status.setup_kind === "manual_upload") {
    return `/connect/manual-upload/${encoded}?connection_id=${encodeURIComponent(status.connection_id)}`;
  }
  if (status.setup_kind === "browser_session") {
    // A revoked browser-session shell can't be relaunched — send the owner
    // back to the connect form to start a fresh enrollment instead of the
    // launch route, which requires a live (draft or active) connection.
    if (status.status === "revoked") {
      return `/connect/browser-session/${encoded}`;
    }
    const params = new URLSearchParams({
      connection_id: status.connection_id,
      draft: status.status === "draft" ? "1" : "0",
    });
    return `/connect/browser-session/${encoded}/launch?${params.toString()}`;
  }
  // Static-secret retry MUST target the existing connection (connection_id
  // present) so the static-secret page renders `replaceStaticSecretCredentialAction`
  // (preserves connection_id, history, schedule, records, and — critically —
  // admits a run against a draft row via runAdmission: "setup"). Omitting
  // connection_id here sends the owner to `createStaticSecretConnectionAction`
  // instead, which mints an unrelated second draft and orphans this one
  // forever — the exact deadlock this helper exists to prevent.
  const params = new URLSearchParams({ connection_id: status.connection_id });
  return `/connect/static-secret/${encoded}?${params.toString()}`;
}

export function sourceDetailHref(status: ConnectStatusLinkStatus): string {
  const params = new URLSearchParams({ connection_id: status.connection_id });
  return `/sources/${encodeURIComponent(status.connector_id)}?${params.toString()}`;
}

export function sourceRecordsHref(status: ConnectStatusLinkStatus): string {
  const params = new URLSearchParams({ connection: status.connection_id });
  return `/explore?${params.toString()}`;
}
