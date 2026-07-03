/**
 * Command registry — the single source of truth for the unified command
 * palette's commands, shared by the console (`apps/console`) and the public
 * sandbox (`apps/site`). `mode` scopes the set: `live` includes owner-only
 * navigation and quick actions; `mock-owner` (sandbox) returns navigation only.
 * `basePath` prefixes every href so the sandbox mirror stays under `/sandbox`.
 *
 * `segments` names the three route segments whose owner-facing route diverged
 * from their legacy physical folder when the console adopted clean top-level
 * routes (`redesign-owner-console-product-experience` §10.B): the live console
 * serves Sources/Syncs/Audit at `/sources`, `/syncs`, `/audit`, while the
 * `/sandbox` mirror keeps its legacy `records`/`runs`/`traces` folders. The
 * DEFAULT is the clean owner console (empty `basePath` -> `/` overview, clean
 * `CONSOLE_SEGMENTS`). Sandbox callers must pass `basePath: "/sandbox"` AND
 * `segments: LEGACY_SEGMENTS` explicitly to keep their historical
 * `/sandbox/records...` hrefs.
 *
 * The console re-exports these symbols from
 * `apps/console/src/app/(console)/lib/actions.ts` so existing import paths keep
 * working after the palette was unified.
 */

export type DashboardMode = "live" | "mock-owner";

/**
 * Owner-route segment names for the three sections whose clean route differs
 * from the legacy physical folder. The registry defaults to the clean console
 * segments; the sandbox passes `LEGACY_SEGMENTS` explicitly.
 */
export interface DashboardSegments {
  /** Sources section — clean `sources`, legacy `records`. */
  records: string;
  /** Syncs section — clean `syncs`, legacy `runs`. */
  runs: string;
  /** Audit section — clean `audit`, legacy `traces`. */
  traces: string;
}

/**
 * Legacy folder segments — the `/sandbox` mirror keeps these (its physical
 * routes stay `records`/`runs`/`traces`). Sandbox callers pass this explicitly.
 */
export const LEGACY_SEGMENTS: DashboardSegments = { records: "records", runs: "runs", traces: "traces" };

/** Clean owner-console segments (Sources/Syncs/Audit) for the live console. */
const CONSOLE_SEGMENTS: DashboardSegments = { records: "sources", runs: "syncs", traces: "audit" };

/**
 * Resolve the overview href. An empty `basePath` (the clean console root) maps
 * to `/`, since an empty href is not a usable link; a non-empty base is its own
 * overview.
 */
function overviewHref(basePath: string): string {
  return basePath === "" ? "/" : basePath;
}

export interface DashboardCommand {
  description: string;
  href: string;
  id: string;
  keywords: string[];
  kind: "jump" | "action";
  section: "Navigate" | "Quick action";
  title: string;
}

function buildNavigationCommands(basePath: string, segments: DashboardSegments): DashboardCommand[] {
  return [
    {
      id: "nav-overview",
      title: "Overview",
      description: "Open the operator overview and current attention queue.",
      href: overviewHref(basePath),
      keywords: ["home", "overview", "dashboard"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-explore",
      title: "Explore",
      description: "Query, recent, and time-range views across every visible connection.",
      href: `${basePath}/explore`,
      keywords: ["explore", "records", "search", "timeline", "activity"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-search",
      title: "Jump",
      description: "Jump to a trace, grant, or run by id.",
      href: `${basePath}/search`,
      keywords: ["jump", "trace", "grant", "run", "id"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-traces",
      title: "Audit",
      description: "Inspect the audit trail: who read what, under which grant, and recent failures.",
      href: `${basePath}/${segments.traces}`,
      keywords: ["audit", "trace", "traces", "timeline", "failure", "read", "disclosure"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-grants",
      title: "Grants",
      description: "Review pending approvals and grant lifecycle decisions.",
      href: `${basePath}/grants`,
      keywords: ["grant", "grants", "approval", "consent"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-runs",
      title: "Syncs",
      description: "Inspect recent collection attempts and schedule health.",
      href: `${basePath}/${segments.runs}`,
      keywords: ["sync", "syncs", "run", "runs", "schedule", "connector"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-records",
      title: "Sources",
      description: "Drill into connected data sources, their streams, and retained records.",
      href: `${basePath}/${segments.records}`,
      keywords: ["sources", "connections", "records", "stream", "connector", "data"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-schedules",
      title: "Schedules",
      description: "View and manage connector sync schedules.",
      href: `${basePath}/schedules`,
      keywords: ["schedules", "schedule", "cron", "sync"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-deployment",
      title: "Deployment",
      description: "Deployment overview, owner tokens, and operator settings.",
      href: `${basePath}/deployment`,
      keywords: ["deployment", "deploy", "tokens", "owner", "settings"],
      kind: "jump",
      section: "Navigate",
    },
  ];
}

function buildLiveOnlyNavigationCommands(basePath: string): DashboardCommand[] {
  return [
    {
      id: "nav-connect",
      title: "Connect AI apps",
      description:
        "Give AI apps and local agents grant-scoped read access to data already in this instance: copy MCP/CLI setup for ChatGPT, Claude, Claude Code, Codex. To add data sources, use Sources.",
      href: `${basePath}/connect`,
      keywords: ["connect", "ai apps", "read access", "mcp", "claude", "codex", "chatgpt", "agent", "client", "setup"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-device-exporters",
      title: "Device exporters",
      description: "Manage device-bound exporters for this PDPP instance.",
      href: `${basePath}/device-exporters`,
      keywords: ["device", "exporter", "exporters", "device exporter"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-event-subscriptions",
      title: "Event subscriptions",
      description: "Configure and inspect event subscription webhooks.",
      href: `${basePath}/event-subscriptions`,
      keywords: ["event", "subscription", "subscriptions", "webhook"],
      kind: "jump",
      section: "Navigate",
    },
  ];
}

function buildLiveOnlyQuickActions(basePath: string, segments: DashboardSegments): DashboardCommand[] {
  return [
    {
      id: "quick-pending-approvals",
      title: "Pending approvals",
      description: "Jump to the live approval queue.",
      href: `${basePath}/grants#pending-approvals`,
      keywords: ["approval", "approve", "consent", "pending", "grant"],
      kind: "action",
      section: "Quick action",
    },
    {
      id: "quick-owner-token",
      title: "Issue owner token",
      description: "Mint an owner self-export bearer for your CLI; inspect the device-flow transcript.",
      href: `${basePath}/deployment/tokens`,
      keywords: ["owner token", "device flow", "bootstrap", "token", "login", "personal access token"],
      kind: "action",
      section: "Quick action",
    },
    {
      id: "quick-grant-request",
      title: "Grant request workspace",
      description: "Register a client and stage a consent request through PAR.",
      href: `${basePath}/grants/request`,
      keywords: ["grant request", "par", "register client", "consent", "dcr"],
      kind: "action",
      section: "Quick action",
    },
    {
      id: "quick-failed-traces",
      title: "Failed audit events",
      description: "Open the audit-trail failure queue.",
      href: `${basePath}/${segments.traces}?status=failed`,
      keywords: ["audit", "trace", "failure", "failed", "debug"],
      kind: "action",
      section: "Quick action",
    },
    {
      id: "quick-failed-runs",
      title: "Failed syncs",
      description: "Open the collection failure queue.",
      href: `${basePath}/${segments.runs}?status=failed`,
      keywords: ["sync", "syncs", "run", "failure", "failed", "connector"],
      kind: "action",
      section: "Quick action",
    },
    {
      id: "quick-records-timeline",
      title: "Record activity",
      description: "Inspect recent record activity by date window in Explore.",
      href: `${basePath}/explore`,
      keywords: ["records", "timeline", "activity", "history", "explore"],
      kind: "action",
      section: "Quick action",
    },
    {
      id: "quick-connector-inventory",
      title: "Source inventory",
      description: "Open the connector and stream workbench.",
      href: `${basePath}/${segments.records}`,
      keywords: ["source", "sources", "connector", "inventory", "streams", "records"],
      kind: "action",
      section: "Quick action",
    },
  ];
}

function searchableText(command: DashboardCommand): string {
  return [command.title, command.description, command.href, ...command.keywords].join(" ").toLowerCase();
}

export function listDashboardCommands({
  // Default to the clean owner console: root base path (overview resolves to
  // `/`) with Sources/Syncs/Audit segments. Callers that render the sandbox
  // mirror pass `basePath: "/sandbox"` + the legacy segments explicitly.
  basePath = "",
  mode = "live",
  segments = CONSOLE_SEGMENTS,
}: {
  basePath?: string;
  mode?: DashboardMode;
  segments?: DashboardSegments;
} = {}): DashboardCommand[] {
  const nav = buildNavigationCommands(basePath, segments);
  if (mode === "live") {
    return [...nav, ...buildLiveOnlyNavigationCommands(basePath), ...buildLiveOnlyQuickActions(basePath, segments)];
  }
  return nav;
}

export function matchDashboardCommands(
  query: string,
  options: { basePath?: string; mode?: DashboardMode; segments?: DashboardSegments } = {}
): DashboardCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return listDashboardCommands(options);
  }
  return listDashboardCommands(options).filter((command) => searchableText(command).includes(needle));
}
