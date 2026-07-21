import { buttonVariants } from "@pdpp/brand-react";
import { ConnectAgentCard } from "@pdpp/operator-ui/components/connect-agent-card";
import {
  DeploymentDiagnosticsView,
  isDeploymentIndexing,
} from "@pdpp/operator-ui/components/views/deployment-diagnostics-view";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { DeploymentReadinessPanel } from "../components/deployment-readiness-panel.tsx";
import { extractReadinessInputs } from "../components/deployment-readiness-rows.ts";
import { LivePoller } from "../components/live-poller.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type DeploymentDiagnostics, getDatasetSummary, getDeploymentDiagnostics } from "../lib/ref-client.ts";

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
  // The operator console renders against the running deployment, so the
  // provider URL is the deployment's own public origin. Auto-populating it
  // into the connect card keeps the MCP URL correct-by-construction —
  // operators can copy/paste without inventing the URL.
  const providerUrl = await getReferencePublicOrigin();
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
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/deployment/tokens">
            Tokens
          </Link>
        }
        afterDiagnostics={<ConnectAgentCard connectHref="/connect" mode="live" providerUrl={providerUrl} />}
        beforeDiagnostics={<DeploymentReadinessPanel inputs={extractReadinessInputs(report)} />}
        breadcrumbs={[{ href: "/", label: "Dashboard" }, { label: "Deployment" }]}
        description="Operator diagnostics for the reference retrieval surfaces. Read-only. Secret environment values are redacted before reaching this page."
        report={report}
        retainedBytes={retainedBytes}
      />
    </RecordroomShellWithPalette>
  );
}
