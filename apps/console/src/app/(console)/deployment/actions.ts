"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { rebuildDatasetSummary } from "../lib/ref-client.ts";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected operator action failure";
}

/**
 * Owner recovery path for a dataset-summary projection that is not `fresh`
 * (never converged, or auto-heal gave up after its bounded consecutive-
 * failure cap — see `ensureDatasetSummaryProjectionHealthy` in
 * `dataset-summary-read-model.ts`). Calls the same owner-authenticated
 * `POST /_ref/dataset/summary/rebuild` route the operator console already
 * exposed, but until now only reachable by hand-crafting the request —
 * there was no button. Redirects back to the deployment page with a
 * `notice`/`error` query param the storage section reads to confirm the
 * outcome.
 */
export async function rebuildDatasetSummaryAction() {
  await requireDashboardAccess("/deployment");
  let target = "/deployment?notice=dataset_summary_rebuilt";
  try {
    await rebuildDatasetSummary();
  } catch (err) {
    target = `/deployment?error=${encodeURIComponent(errorMessage(err))}`;
  }
  redirect(target);
}
