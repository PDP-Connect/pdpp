/**
 * Route prefix and helpers for the shared dashboard feature views.
 *
 * Two callers bind their own `Routes`:
 *   - the live `/dashboard/**` pages use `dashboardRoutes`
 *   - the sandbox `/sandbox/**` pages use `sandboxRoutes`
 *
 * The same view components consume this struct, which is why a sandbox
 * page can render the live records table or grants list without any
 * URL-baked-in `/dashboard` strings.
 */

export interface Routes {
  readonly basePath: string;
  connector(id: string): string;
  /** `/dashboard/grants/<id>` or `/sandbox/grants/<id>`. */
  grant(id: string): string;
  /** Encoded peek query for the list `?peek=<id>` shortcut. */
  peek(base: string, id: string, extra?: Record<string, string | undefined>): string;
  record(connectorId: string, stream: string, recordId: string): string;
  run(id: string): string;
  readonly section: {
    overview: string;
    records: string;
    recordsTimeline: string;
    search: string;
    grants: string;
    runs: string;
    traces: string;
    deployment: string;
  };
  stream(connectorId: string, stream: string): string;
  streamHealth(connectorId: string, stream: string): string;
  trace(id: string): string;
}

function makeRoutes(basePath: string, opts: { overview?: string } = {}): Routes {
  const enc = (v: string) => encodeURIComponent(v);
  return {
    basePath,
    section: {
      overview: opts.overview ?? basePath,
      records: `${basePath}/records`,
      recordsTimeline: `${basePath}/records/timeline`,
      search: `${basePath}/search`,
      grants: `${basePath}/grants`,
      runs: `${basePath}/runs`,
      traces: `${basePath}/traces`,
      deployment: `${basePath}/deployment`,
    },
    grant: (id) => `${basePath}/grants/${enc(id)}`,
    run: (id) => `${basePath}/runs/${enc(id)}`,
    trace: (id) => `${basePath}/traces/${enc(id)}`,
    connector: (id) => `${basePath}/records/${enc(id)}`,
    stream: (cid, s) => `${basePath}/records/${enc(cid)}/${enc(s)}`,
    record: (cid, s, rid) => `${basePath}/records/${enc(cid)}/${enc(s)}/${enc(rid)}`,
    streamHealth: (cid, s) => `${basePath}/records/${enc(cid)}/${enc(s)}/health`,
    peek: (base, id, extra) => {
      const params = new URLSearchParams();
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          if (v !== undefined && v !== "") {
            params.set(k, v);
          }
        }
      }
      params.set("peek", id);
      return `${base}?${params.toString()}`;
    },
  };
}

export const dashboardRoutes: Routes = makeRoutes("/dashboard");

/**
 * Sandbox routes resolve to `/sandbox/*`. The overview lives at
 * `/sandbox/overview`, not `/sandbox`, because `/sandbox` is the
 * mock-owner launcher that introduces the reference instance and
 * routes the visitor into the dashboard.
 */
export const sandboxRoutes: Routes = makeRoutes("/sandbox", { overview: "/sandbox/overview" });
