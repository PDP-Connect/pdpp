// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
      description: "Open the operator overview and current attention queue.",
      href: overviewHref(basePath),
      id: "nav-overview",
      keywords: ["home", "overview", "dashboard"],
      kind: "jump",
      section: "Navigate",
      title: "Overview",
    },
    {
      description: "Query, recent, and time-range views across every visible connection.",
      href: `${basePath}/explore`,
      id: "nav-explore",
      keywords: ["explore", "records", "search", "timeline", "activity"],
      kind: "jump",
      section: "Navigate",
      title: "Explore",
    },
    {
      description: "Jump to a trace, grant, or run by id.",
      href: `${basePath}/search`,
      id: "nav-search",
      keywords: ["jump", "trace", "grant", "run", "id"],
      kind: "jump",
      section: "Navigate",
      title: "Jump",
    },
    {
      description: "Inspect the audit trail: who read what, under which grant, and recent failures.",
      href: `${basePath}/${segments.traces}`,
      id: "nav-traces",
      keywords: ["audit", "trace", "traces", "timeline", "failure", "read", "disclosure"],
      kind: "jump",
      section: "Navigate",
      title: "Audit",
    },
    {
      description: "Review pending approvals and grant lifecycle decisions.",
      href: `${basePath}/grants`,
      id: "nav-grants",
      keywords: ["grant", "grants", "approval", "consent"],
      kind: "jump",
      section: "Navigate",
      title: "Grants",
    },
    {
      description: "Inspect recent collection attempts and schedule health.",
      href: `${basePath}/${segments.runs}`,
      id: "nav-runs",
      keywords: ["sync", "syncs", "run", "runs", "schedule", "connector"],
      kind: "jump",
      section: "Navigate",
      title: "Syncs",
    },
    {
      description: "Drill into connected data sources, their streams, and retained records.",
      href: `${basePath}/${segments.records}`,
      id: "nav-records",
      keywords: ["sources", "connections", "records", "stream", "connector", "data"],
      kind: "jump",
      section: "Navigate",
      title: "Sources",
    },
    {
      description: "View and manage connector sync schedules.",
      href: `${basePath}/schedules`,
      id: "nav-schedules",
      keywords: ["schedules", "schedule", "cron", "sync"],
      kind: "jump",
      section: "Navigate",
      title: "Schedules",
    },
    {
      description: "Deployment overview, owner tokens, and operator settings.",
      href: `${basePath}/deployment`,
      id: "nav-deployment",
      keywords: ["deployment", "deploy", "tokens", "owner", "settings"],
      kind: "jump",
      section: "Navigate",
      title: "Deployment",
    },
  ];
}

function buildLiveOnlyNavigationCommands(basePath: string): DashboardCommand[] {
  return [
    {
      description: "Enable this browser or installed app for owner-action alerts.",
      href: `${basePath}/notifications`,
      id: "nav-notifications",
      keywords: ["notification", "notifications", "push", "pwa", "browser", "device", "alerts"],
      kind: "jump",
      section: "Navigate",
      title: "Notifications",
    },
    {
      description:
        "Give apps and local agents grant-scoped read access to data already in this instance. To add data sources, use Sources.",
      href: `${basePath}/connect`,
      id: "nav-connect",
      keywords: ["connect", "ai apps", "read access", "mcp", "claude", "codex", "chatgpt", "agent", "client", "setup"],
      kind: "jump",
      section: "Navigate",
      title: "Connect apps",
    },
    {
      description: "Manage device-bound exporters for this PDPP instance.",
      href: `${basePath}/device-exporters`,
      id: "nav-device-exporters",
      keywords: ["device", "exporter", "exporters", "device exporter"],
      kind: "jump",
      section: "Navigate",
      title: "Device exporters",
    },
    {
      description: "Configure and inspect event subscription webhooks.",
      href: `${basePath}/event-subscriptions`,
      id: "nav-event-subscriptions",
      keywords: ["event", "subscription", "subscriptions", "webhook"],
      kind: "jump",
      section: "Navigate",
      title: "Event subscriptions",
    },
  ];
}

function buildLiveOnlyQuickActions(basePath: string, segments: DashboardSegments): DashboardCommand[] {
  return [
    {
      description: "Jump to the live approval queue.",
      href: `${basePath}/grants#pending-approvals`,
      id: "quick-pending-approvals",
      keywords: ["approval", "approve", "consent", "pending", "grant"],
      kind: "action",
      section: "Quick action",
      title: "Pending approvals",
    },
    {
      description: "Mint an owner self-export bearer for your CLI; inspect the device-flow transcript.",
      href: `${basePath}/deployment/tokens`,
      id: "quick-owner-token",
      keywords: ["owner token", "device flow", "bootstrap", "token", "login", "personal access token"],
      kind: "action",
      section: "Quick action",
      title: "Issue owner token",
    },
    {
      description: "Register a client and stage a consent request through PAR.",
      href: `${basePath}/grants/request`,
      id: "quick-grant-request",
      keywords: ["grant request", "par", "register client", "consent", "dcr"],
      kind: "action",
      section: "Quick action",
      title: "Grant request workspace",
    },
    {
      description: "Open the audit-trail failure queue.",
      href: `${basePath}/${segments.traces}?status=failed`,
      id: "quick-failed-traces",
      keywords: ["audit", "trace", "failure", "failed", "debug"],
      kind: "action",
      section: "Quick action",
      title: "Failed audit events",
    },
    {
      description: "Open the collection failure queue.",
      href: `${basePath}/${segments.runs}?status=failed`,
      id: "quick-failed-runs",
      keywords: ["sync", "syncs", "run", "failure", "failed", "connector"],
      kind: "action",
      section: "Quick action",
      title: "Failed syncs",
    },
    {
      description: "Inspect recent record activity by date window in Explore.",
      href: `${basePath}/explore`,
      id: "quick-records-timeline",
      keywords: ["records", "timeline", "activity", "history", "explore"],
      kind: "action",
      section: "Quick action",
      title: "Record activity",
    },
    {
      description: "Open the connector and stream workbench.",
      href: `${basePath}/${segments.records}`,
      id: "quick-connector-inventory",
      keywords: ["source", "sources", "connector", "inventory", "streams", "records"],
      kind: "action",
      section: "Quick action",
      title: "Source inventory",
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
