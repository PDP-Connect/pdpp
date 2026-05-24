import type { DeploymentDiagnostics } from "../../lib/ref-client.ts";

export function isDeploymentIndexing(report: DeploymentDiagnostics): boolean {
  return Boolean(
    report.lexical.index.backfill_progress ||
      report.semantic.index.backfill_progress ||
      report.semantic.index.state === "building"
  );
}
