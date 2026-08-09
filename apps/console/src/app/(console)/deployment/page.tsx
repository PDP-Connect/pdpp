// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import {
  DeploymentDiagnosticsView,
  isDeploymentIndexing,
} from "@pdpp/operator-ui/components/views/deployment-diagnostics-view";
import { retainedBytesFromDatasetSummary } from "@pdpp/operator-ui/lib/storage-footprint";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { loadConnectorSummaryPage } from "../components/connector-summary-page.tsx";
import { DeploymentReadinessPanel } from "../components/deployment-readiness-panel.tsx";
import { extractReadinessInputs } from "../components/deployment-readiness-rows.ts";
import { LivePoller } from "../components/live-poller.tsx";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type DatasetSummaryProjectionMetadata,
  type DeploymentDiagnostics,
  getDatasetSize,
  getDatasetSummary,
  getDatasetTop,
  getDeploymentDiagnostics,
  listConnectorSummaries,
  type RefConnectorSummary,
  type RefRetainedSizeRow,
  type RefRetainedSizeTopRow,
} from "../lib/ref-client.ts";
import { rebuildDatasetSummaryAction } from "./actions.ts";

export const dynamic = "force-dynamic";

interface DeploymentPageParams {
  error?: string;
  notice?: string;
}

// Operator-facing diagnostics for the reference deployment. Not a PDPP
// protocol surface — this page consumes /_ref/deployment and renders the
// report the RS already redacted. The goal is "why isn't retrieval working"
// answered in one glance, without the operator reading logs or SSHing in.
//
// Spec: openspec/changes/make-semantic-retrieval-operational/
//       specs/reference-implementation-architecture/spec.md
export default async function DeploymentPage({ searchParams }: { searchParams: Promise<DeploymentPageParams> }) {
  const params = await searchParams;
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
  //
  // `retainedBytesFromDatasetSummary` gates on the global projection's
  // convergence state — the same fabrication class the per-connection read
  // model already guards against (`connector-summary-read-model.ts`,
  // `retained_bytes_state`): an unconverged projection must render as
  // unknown, never as "0 B".
  //
  // `projection` (the full metadata, not just the derived byte count) is
  // threaded through separately so the storage section can say WHY the
  // number is missing and offer a recovery action, rather than a bare "—".
  let retainedBytes: number | null = null;
  let projection: DatasetSummaryProjectionMetadata | null = null;
  try {
    const summary = await getDatasetSummary();
    retainedBytes = retainedBytesFromDatasetSummary(summary);
    projection = summary.projection ?? null;
  } catch {
    retainedBytes = null;
    projection = null;
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

  // Stream-grain and record/blob top-N retained bytes. Both are already
  // computed by the retained-size projection and already exposed over HTTP
  // (`GET /_ref/dataset/size?grain=stream`, `GET /_ref/dataset/top`) — this
  // is the first console page to read them. `top` responses are already
  // bounded server-side (`MAX_TOP_LIMIT = 25`); rendered as-is, no further
  // pagination or fan-out. Best-effort, in parallel, same posture as the
  // summary/source fetches above: a failed read hides its section rather
  // than failing the page.
  const [streamSizesResult, topRecordsResult, topBlobsResult] = await Promise.allSettled([
    getDatasetSize("stream"),
    getDatasetTop("record", "total_retained_bytes"),
    getDatasetTop("blob", "blob_bytes"),
  ]);
  const streamSizes: readonly RefRetainedSizeRow[] =
    streamSizesResult.status === "fulfilled" ? streamSizesResult.value.rows : [];
  const topRecords: readonly RefRetainedSizeTopRow[] =
    topRecordsResult.status === "fulfilled" ? topRecordsResult.value.rows : [];
  const topBlobs: readonly RefRetainedSizeTopRow[] =
    topBlobsResult.status === "fulfilled" ? topBlobsResult.value.rows : [];

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
          <>
            <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/deployment/provider-apps">
              Provider authorization
            </Link>
            <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/deployment/tokens">
              Tokens
            </Link>
          </>
        }
        beforeDiagnostics={<DeploymentReadinessPanel inputs={extractReadinessInputs(report)} />}
        breadcrumbs={[{ href: "/", label: "Overview" }, { label: "Deployment" }]}
        description="Operator diagnostics for the reference retrieval surfaces. Read-only. Secret environment values are redacted before reaching this page."
        projection={projection}
        projectionActionError={params.error ?? null}
        projectionActionNotice={params.notice === "dataset_summary_rebuilt" ? "Dataset summary rebuilt." : null}
        rebuildDatasetSummaryAction={rebuildDatasetSummaryAction}
        report={report}
        retainedBytes={retainedBytes}
        sources={sources}
        sourcesTruncated={sourcesTruncated}
        streamSizes={streamSizes}
        topBlobs={topBlobs}
        topRecords={topRecords}
      />
    </RecordroomShellWithPalette>
  );
}
