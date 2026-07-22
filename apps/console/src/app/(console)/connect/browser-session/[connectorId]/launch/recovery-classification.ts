// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RunSummary } from "../../../../lib/ref-client.ts";

const RECOVERABLE_BROWSER_RUN_STATUSES = new Set([
  "started",
  "in_progress",
  "starting_surface",
  "waiting_for_browser_surface",
]);

export function isRecoverableBrowserSessionRun(run: Pick<RunSummary, "status">): boolean {
  return RECOVERABLE_BROWSER_RUN_STATUSES.has(run.status);
}
