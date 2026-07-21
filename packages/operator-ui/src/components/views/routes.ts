/**
 * Route prefix and helpers for the shared dashboard feature views.
 *
 * Two callers bind their own `Routes`:
 *   - the live console owner pages use `dashboardRoutes`
 *   - the sandbox `/sandbox/**` pages use `sandboxRoutes`
 *
 * The same view components consume this struct, which is why a sandbox
 * page can render the live records table or grants list without any
 * URL-baked-in prefix strings.
 *
 * Clean owner-route topology (`redesign-owner-console-product-experience`
 * §10.B): the live console serves owner sections as clean top-level nouns:
 * root `/`, `/sources`, `/syncs`, `/audit`, `/explore`, `/grants`,
 * `/connect`, `/notifications`, `/schedules`, and clean deployment/admin nouns.
 * The removed legacy console prefix is intentionally not preserved as
 * redirects. The `/sandbox` mirror is deliberately unchanged: it keeps its
 * `/sandbox` base and its legacy
 * `records`/`runs`/`traces` folder segments, so `makeRoutes` takes an optional
 * segment override that defaults to the legacy names.
 */

export interface Routes {
  readonly basePath: string;
  connector(id: string): string;
  /** `/grants/<id>` or `/sandbox/grants/<id>`. */
  grant(id: string): string;
  /** Encoded peek query for the list `?peek=<id>` shortcut. */
  peek(base: string, id: string, extra?: Record<string, string | undefined>): string;
  record(connectorId: string, stream: string, recordId: string): string;
  run(id: string): string;
  readonly section: {
    overview: string;
    /**
     * Top-level Explore canvas. Promoted out of the Records subtree by
     * `promote-explore-to-top-level-ia`; the Sources subnav points its
     * `Explorer` entry at this same destination.
     */
    explore: string;
    addSource: string;
    records: string;
    schedules: string;
    search: string;
    grants: string;
    runs: string;
    traces: string;
    connect: string;
    deployment: string;
    deploymentTokens: string;
    deviceExporters: string;
    eventSubscriptions: string;
    notifications: string;
  };
  stream(connectorId: string, stream: string): string;
  streamHealth(connectorId: string, stream: string): string;
  trace(id: string): string;
}

/**
 * The three owner-route segments whose clean console route differs from the
 * legacy physical folder / sandbox mirror segment. `Sources` serves at
 * `sources` in the console but keeps `records` in the sandbox, etc.
 */
export interface RouteSegments {
  records: string;
  runs: string;
  traces: string;
}

const LEGACY_SEGMENTS: RouteSegments = { records: "records", runs: "runs", traces: "traces" };

/** Clean owner-route segment names for the live console. */
export const CONSOLE_SEGMENTS: RouteSegments = { records: "sources", runs: "syncs", traces: "audit" };

/** The live console owner routes are clean top-level nouns off root. */
export const CONSOLE_BASE_PATH = "";

function makeRoutes(basePath: string, opts: { overview?: string; segments?: RouteSegments } = {}): Routes {
  const enc = (v: string) => encodeURIComponent(v);
  const seg = opts.segments ?? LEGACY_SEGMENTS;
  // An empty base path (the clean console root) has no usable literal overview
  // href, so it maps to `/`. Prefixed mirrors are their own overview.
  const overview = opts.overview ?? (basePath === "" ? "/" : basePath);
  return {
    basePath,
    section: {
      overview,
      explore: `${basePath}/explore`,
      addSource: `${basePath}/${seg.records}/add`,
      records: `${basePath}/${seg.records}`,
      schedules: `${basePath}/schedules`,
      search: `${basePath}/search`,
      grants: `${basePath}/grants`,
      runs: `${basePath}/${seg.runs}`,
      traces: `${basePath}/${seg.traces}`,
      connect: `${basePath}/connect`,
      deployment: `${basePath}/deployment`,
      deploymentTokens: `${basePath}/deployment/tokens`,
      deviceExporters: `${basePath}/device-exporters`,
      eventSubscriptions: `${basePath}/event-subscriptions`,
      notifications: `${basePath}/notifications`,
    },
    grant: (id) => `${basePath}/grants/${enc(id)}`,
    run: (id) => `${basePath}/${seg.runs}/${enc(id)}`,
    trace: (id) => `${basePath}/${seg.traces}/${enc(id)}`,
    connector: (id) => `${basePath}/${seg.records}/${enc(id)}`,
    stream: (cid, s) => `${basePath}/${seg.records}/${enc(cid)}/${enc(s)}`,
    record: (cid, s, rid) => `${basePath}/${seg.records}/${enc(cid)}/${enc(s)}/${enc(rid)}`,
    streamHealth: (cid, s) => `${basePath}/${seg.records}/${enc(cid)}/${enc(s)}/health`,
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

/**
 * Live console owner routes: clean top-level nouns off root, with
 * Sources/Syncs/Audit segments. The overview is `/`.
 */
export const dashboardRoutes: Routes = makeRoutes(CONSOLE_BASE_PATH, { segments: CONSOLE_SEGMENTS });

/**
 * Sandbox routes resolve to `/sandbox/*` and keep the legacy
 * `records`/`runs`/`traces` folder segments. The overview is `/sandbox` itself:
 * the sandbox entrypoint is the mock-owner dashboard, not a separate launcher.
 */
export const sandboxRoutes: Routes = makeRoutes("/sandbox");
