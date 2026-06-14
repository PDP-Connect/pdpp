import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { DetailLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the deployment status page.
 *
 * `/dashboard/deployment` resolves the reference public origin and runs a
 * deployment diagnostics probe, which can be slow when the reference is cold or
 * remote. Keep the shell stable and animate a detail skeleton while it resolves.
 */
export default function DeploymentLoading() {
  return (
    <RecordroomShellWithPalette>
      <DetailLoadingSkeleton label="deployment status" />
    </RecordroomShellWithPalette>
  );
}
