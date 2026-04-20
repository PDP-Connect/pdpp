export function isDashboardEnabled() {
  if (process.env.PDPP_ENABLE_DASHBOARD === '1') return true;

  // Keep the dashboard local-only by default. Any Vercel deployment can opt
  // back in explicitly with PDPP_ENABLE_DASHBOARD=1.
  return process.env.VERCEL !== '1';
}
