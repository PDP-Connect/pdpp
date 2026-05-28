export interface DashboardCommand {
  description: string;
  href: string;
  id: string;
  keywords: string[];
  kind: "jump" | "action";
  section: "Navigate" | "Quick action" | "Search";
  title: string;
}

const NAVIGATION_COMMANDS: DashboardCommand[] = [
  {
    id: "nav-overview",
    title: "Overview",
    description: "Open the operator overview and current attention queue.",
    href: "/dashboard",
    keywords: ["home", "overview", "dashboard"],
    kind: "jump",
    section: "Navigate",
  },
  {
    id: "nav-traces",
    title: "Traces",
    description: "Inspect trace timelines and recent failures.",
    href: "/dashboard/traces",
    keywords: ["trace", "traces", "timeline", "failure"],
    kind: "jump",
    section: "Navigate",
  },
  {
    id: "nav-grants",
    title: "Grants",
    description: "Review pending approvals and grant lifecycle decisions.",
    href: "/dashboard/grants",
    keywords: ["grant", "grants", "approval", "consent"],
    kind: "jump",
    section: "Navigate",
  },
  {
    id: "nav-runs",
    title: "Runs",
    description: "Inspect connector runs and schedule health.",
    href: "/dashboard/runs",
    keywords: ["run", "runs", "schedule", "connector"],
    kind: "jump",
    section: "Navigate",
  },
  {
    id: "nav-records",
    title: "Connections",
    description: "Drill into your connections, their streams, and retained records.",
    href: "/dashboard/records",
    keywords: ["connections", "records", "stream", "connector", "data"],
    kind: "jump",
    section: "Navigate",
  },
  {
    id: "nav-explore",
    title: "Explore",
    description: "Query, recent, and time-range views across every visible connection.",
    href: "/dashboard/explore",
    keywords: ["explore", "records", "search", "timeline", "activity"],
    kind: "jump",
    section: "Navigate",
  },
  {
    id: "nav-search",
    title: "Jump",
    description: "Jump to a trace, grant, or run by id.",
    href: "/dashboard/search",
    keywords: ["jump", "trace", "grant", "run", "id"],
    kind: "jump",
    section: "Navigate",
  },
];

const QUICK_ACTIONS: DashboardCommand[] = [
  {
    id: "quick-pending-approvals",
    title: "Pending approvals",
    description: "Jump to the live approval queue.",
    href: "/dashboard/grants#pending-approvals",
    keywords: ["approval", "approve", "consent", "pending", "grant"],
    kind: "action",
    section: "Quick action",
  },
  {
    id: "quick-owner-token",
    title: "Issue owner token",
    description: "Mint an owner self-export bearer for your CLI; inspect the device-flow transcript.",
    href: "/dashboard/deployment/tokens",
    keywords: ["owner token", "device flow", "bootstrap", "token", "login", "personal access token"],
    kind: "action",
    section: "Quick action",
  },
  {
    id: "quick-grant-request",
    title: "Grant request workspace",
    description: "Register a client and stage a consent request through PAR.",
    href: "/dashboard/grants/request",
    keywords: ["grant request", "par", "register client", "consent", "dcr"],
    kind: "action",
    section: "Quick action",
  },
  {
    id: "quick-failed-traces",
    title: "Failed traces",
    description: "Open the trace failure queue.",
    href: "/dashboard/traces?status=failed",
    keywords: ["trace", "failure", "failed", "debug"],
    kind: "action",
    section: "Quick action",
  },
  {
    id: "quick-failed-runs",
    title: "Failed runs",
    description: "Open the connector run failure queue.",
    href: "/dashboard/runs?status=failed",
    keywords: ["run", "failure", "failed", "connector"],
    kind: "action",
    section: "Quick action",
  },
  {
    id: "quick-records-timeline",
    title: "Record activity",
    description: "Inspect recent record activity by date window in Explore.",
    href: "/dashboard/explore",
    keywords: ["records", "timeline", "activity", "history", "explore"],
    kind: "action",
    section: "Quick action",
  },
  {
    id: "quick-connector-inventory",
    title: "Connector inventory",
    description: "Open the connector and stream workbench.",
    href: "/dashboard/records",
    keywords: ["connector", "inventory", "streams", "records"],
    kind: "action",
    section: "Quick action",
  },
];

function searchableText(command: DashboardCommand): string {
  return [command.title, command.description, command.href, ...command.keywords].join(" ").toLowerCase();
}

export function listDashboardCommands(): DashboardCommand[] {
  return [...NAVIGATION_COMMANDS, ...QUICK_ACTIONS];
}

export function matchDashboardCommands(query: string): DashboardCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return listDashboardCommands();
  }
  return listDashboardCommands().filter((command) => searchableText(command).includes(needle));
}

export function buildSearchCommand(query: string): DashboardCommand {
  return {
    id: "search-all-records",
    title: `Search record content for "${query}"`,
    description:
      "Run text search across retained record data. Use connector and stream filters when you want structured browsing instead.",
    href: `/dashboard/search?q=${encodeURIComponent(query)}&jump=0`,
    keywords: [query, "search"],
    kind: "jump",
    section: "Search",
  };
}
