// Contributor-only routes (component galleries, palette samplers) that exist
// to support development. They are not part of the public surface topology.
// Hidden on hosted (Vercel) builds unless explicitly opted in, mirroring the
// owner-console gating pattern.
export function isContributorSurfaceEnabled(): boolean {
  if (process.env.PDPP_ENABLE_CONTRIBUTOR_SURFACES === "1") {
    return true;
  }
  return process.env.VERCEL !== "1";
}
