import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { DetailLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Route-level loading state for the deployment status page.
 *
 * `/deployment` resolves the reference public origin and runs a
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
