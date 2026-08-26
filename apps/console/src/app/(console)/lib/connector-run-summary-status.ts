// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isActiveSourceRunStatus } from "@pdpp/display";

/**
 * Connector-summary liveness from ref-control's `isActiveRunSummaryStatus`.
 *
 * The status set itself lives in `@pdpp/display` because the source-status
 * ranking branches on it (`running` outranks the verdict) and the
 * `sources-report` CLI must reach the same answer. This keeps the
 * console-facing name that several route modules and invariant tests pin.
 */
export function isActiveConnectorRunSummaryStatus(status: string): boolean {
  return isActiveSourceRunStatus(status);
}

/** Synthetic scheduler gate decisions have no run id and are not navigable syncs. */
export function connectorRunSummaryId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
