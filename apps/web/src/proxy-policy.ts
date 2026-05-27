export type DashboardProxyEnv = Record<string, string | undefined> & {
  readonly PDPP_DASHBOARD_AUTH_REDIRECT?: string;
};

export function isDashboardAuthRedirectEnabled(env: DashboardProxyEnv = process.env): boolean {
  if (env.PDPP_DASHBOARD_AUTH_REDIRECT === "0") {
    return false;
  }
  return true;
}
