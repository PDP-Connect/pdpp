import Link from "next/link";
import { buttonVariants } from "@/components/ui/button.tsx";
import { ConnectAgentCard } from "../components/connect-agent-card.tsx";
import { LivePoller } from "../components/live-poller.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { DeploymentDiagnosticsView, isDeploymentIndexing } from "../components/views/deployment-diagnostics-view.tsx";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type DeploymentDiagnostics, getDeploymentDiagnostics } from "../lib/ref-client.ts";

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
  // into the `pdpp connect <provider-url>` command keeps the surface
  // correct-by-construction — operators can copy/paste without inventing
  // the URL.
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

  if (unreachable || !report) {
    return (
      <DashboardShell active="deployment">
        <ServerUnreachable />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell active="deployment">
      <LivePoller enabled={isDeploymentIndexing(report)} />
      <DeploymentDiagnosticsView
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/deployment/tokens">
            Tokens
          </Link>
        }
        afterDiagnostics={<ConnectAgentCard mode="live" providerUrl={providerUrl} />}
        breadcrumbs={[{ href: "/dashboard", label: "Dashboard" }, { label: "Deployment" }]}
        description="Operator diagnostics for the reference retrieval surfaces. Read-only. Secret environment values are redacted before reaching this page."
        report={report}
      />
    </DashboardShell>
  );
}
