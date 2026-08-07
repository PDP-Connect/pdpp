// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import {
  DeploymentDiagnosticsView,
  isDeploymentIndexing,
} from "@pdpp/operator-ui/components/views/deployment-diagnostics-view";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { loadConnectorSummaryPage } from "../components/connector-summary-page.tsx";
import { DeploymentReadinessPanel } from "../components/deployment-readiness-panel.tsx";
import { extractReadinessInputs } from "../components/deployment-readiness-rows.ts";
import { LivePoller } from "../components/live-poller.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type DeploymentDiagnostics,
  getDatasetSummary,
  getDeploymentDiagnostics,
  listConnectorSummaries,
  type RefConnectorSummary,
} from "../lib/ref-client.ts";

export const dynamic = "force-dynamic";

// Operator-facing diagnostics for the reference deployment. Not a PDPP
// protocol surface — this page consumes /_ref/deployment and renders the
// report the RS already redacted. The goal is "why isn't retrieval working"
// answered in one glance, without the operator reading logs or SSHing in.
//
// Spec: openspec/changes/make-semantic-retrieval-operational/
//       specs/reference-implementation-architecture/spec.md
export default async function DeploymentPage() {
  let report: DeploymentDiagnostics | null = null;
  let unreachable = false;
  try {
    report = await getDeploymentDiagnostics();
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      unreachable = true;
    } else {
      throw err;
    }
  }

  // The logical retained payload is rendered beside the physical footprint as
  // a labeled comparison. It is a best-effort fetch — a failed summary read
  // hides the comparison line rather than failing the deployment page, which
  // is primarily a retrieval-diagnostics surface.
  let retainedBytes: number | null = null;
  try {
    const summary = await getDatasetSummary();
    retainedBytes = typeof summary.total_retained_bytes === "number" ? summary.total_retained_bytes : null;
  } catch {
    retainedBytes = null;
  }

  // Per-source retained payload. The `database` block answers "how big is the
  // database" and "which tables" but never "which source"; the connector
  // summaries already carry `total_retained_bytes`, `total_records` +
  // `total_records_state`, and the `retained_bytes` breakdown, so this needs
  // no new endpoint or query.
  //
  // ONE bounded page, via the shared primitive — never the unscoped fan-out
  // (`ref-client-pagination.test.ts` route invariant). A failed read leaves the
  // table off rather than failing the page, matching the best-effort summary
  // fetch above.
  //
  // `has_more` is threaded through, NOT discarded: one page may not hold every
  // configured source, and a truncated list rendered as if it were the whole
  // fleet is the same class of defect as fabricating a `0` — it implies a
  // completeness the read does not have. The view states the bound instead.
  const sourcePage = await loadConnectorSummaryPage({ cursor: undefined }, (opts) => listConnectorSummaries(opts));
  const sources: readonly RefConnectorSummary[] = sourcePage.kind === "ok" ? sourcePage.items : [];
  const sourcesTruncated = sourcePage.kind === "ok" && sourcePage.hasMore;

  if (unreachable || !report) {
    return (
      <RecordroomShellWithPalette>
        <ServerUnreachable />
      </RecordroomShellWithPalette>
    );
  }

  return (
    <RecordroomShellWithPalette>
      <LivePoller enabled={isDeploymentIndexing(report)} />
      <DeploymentDiagnosticsView
        actions={
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/deployment/tokens">
            Tokens
          </Link>
        }
        beforeDiagnostics={<DeploymentReadinessPanel inputs={extractReadinessInputs(report)} />}
        breadcrumbs={[{ href: "/", label: "Dashboard" }, { label: "Deployment" }]}
        description="Operator diagnostics for the reference retrieval surfaces. Read-only. Secret environment values are redacted before reaching this page."
        report={report}
        retainedBytes={retainedBytes}
        sources={sources}
        sourcesTruncated={sourcesTruncated}
      />
    </RecordroomShellWithPalette>
  );
}
