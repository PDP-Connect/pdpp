export type DashboardProxyEnv = Partial<
  Pick<NodeJS.ProcessEnv, "NODE_ENV" | "PDPP_DASHBOARD_AUTH_REDIRECT" | "PDPP_OWNER_PASSWORD">
>;

export function isDashboardAuthRedirectEnabled(env: DashboardProxyEnv = process.env): boolean {
  if (env.PDPP_DASHBOARD_AUTH_REDIRECT === "0") {
    return false;
  }
  if (env.NODE_ENV === "production") {
    return true;
  }
  return typeof env.PDPP_OWNER_PASSWORD === "string" && env.PDPP_OWNER_PASSWORD.length > 0;
}
