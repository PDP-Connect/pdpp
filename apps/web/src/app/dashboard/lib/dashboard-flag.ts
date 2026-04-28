/**
 * Whether the dashboard surface is mounted in the current deployment.
 *
 * Local-only by default: any Vercel deployment can opt in with
 * `PDPP_ENABLE_DASHBOARD=1`. The dashboard is a live operator surface for
 * a single reference instance, not a marketing page; defaulting to "off"
 * outside local-dev avoids surprising public exposure.
 */
export function isDashboardEnabled(): boolean {
  if (process.env.PDPP_ENABLE_DASHBOARD === "1") {
    return true;
  }
  return process.env.VERCEL !== "1";
}
