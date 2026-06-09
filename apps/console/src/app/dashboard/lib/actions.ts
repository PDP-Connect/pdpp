export type DashboardMode = "live" | "mock-owner";

export interface DashboardCommand {
  description: string;
  href: string;
  id: string;
  keywords: string[];
  kind: "jump" | "action";
  section: "Navigate" | "Quick action";
  title: string;
}

function buildNavigationCommands(basePath: string): DashboardCommand[] {
  return [
    {
      id: "nav-overview",
      title: "Overview",
      description: "Open the operator overview and current attention queue.",
      href: basePath,
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
      title: "Traces",
      description: "Inspect trace timelines and recent failures.",
      href: `${basePath}/traces`,
      keywords: ["trace", "traces", "timeline", "failure"],
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
      title: "Runs",
      description: "Inspect connector runs and schedule health.",
      href: `${basePath}/runs`,
      keywords: ["run", "runs", "schedule", "connector"],
      kind: "jump",
      section: "Navigate",
    },
    {
      id: "nav-records",
      title: "Connections",
      description: "Drill into your connections, their streams, and retained records.",
      href: `${basePath}/records`,
      keywords: ["connections", "records", "stream", "connector", "data"],
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
      title: "Connect",
      description: "Copy MCP setup commands for ChatGPT, Claude, Claude Code, Codex, and local agents.",
      href: `${basePath}/connect`,
      keywords: ["connect", "mcp", "claude", "codex", "chatgpt", "agent", "setup"],
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

function buildLiveOnlyQuickActions(basePath: string): DashboardCommand[] {
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
      title: "Failed traces",
      description: "Open the trace failure queue.",
      href: `${basePath}/traces?status=failed`,
      keywords: ["trace", "failure", "failed", "debug"],
      kind: "action",
      section: "Quick action",
    },
    {
      id: "quick-failed-runs",
      title: "Failed runs",
      description: "Open the connector run failure queue.",
      href: `${basePath}/runs?status=failed`,
      keywords: ["run", "failure", "failed", "connector"],
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
      title: "Connector inventory",
      description: "Open the connector and stream workbench.",
      href: `${basePath}/records`,
      keywords: ["connector", "inventory", "streams", "records"],
      kind: "action",
      section: "Quick action",
    },
  ];
}

function searchableText(command: DashboardCommand): string {
  return [command.title, command.description, command.href, ...command.keywords].join(" ").toLowerCase();
}

export function listDashboardCommands({
  basePath = "/dashboard",
  mode = "live",
}: {
  basePath?: string;
  mode?: DashboardMode;
} = {}): DashboardCommand[] {
  const nav = buildNavigationCommands(basePath);
  if (mode === "live") {
    return [...nav, ...buildLiveOnlyNavigationCommands(basePath), ...buildLiveOnlyQuickActions(basePath)];
  }
  return nav;
}

export function matchDashboardCommands(
  query: string,
  options: { basePath?: string; mode?: DashboardMode } = {}
): DashboardCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return listDashboardCommands(options);
  }
  return listDashboardCommands(options).filter((command) => searchableText(command).includes(needle));
}
