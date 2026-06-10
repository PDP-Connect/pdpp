import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { buildConnectorCatalog, type ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type CimdClientDocument, listCimdClientDocuments } from "../lib/ref-client.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { createCimdClientIdentityAction, deleteCimdClientIdentityAction } from "./actions.ts";

export const dynamic = "force-dynamic";

const TRAILING_SLASH_RE = /\/+$/;

interface PageParams {
  client_identity?: string;
  error?: string;
  notice?: string;
  source_q?: string;
}

interface SetupEntry {
  body: string;
  label: string;
  title: string;
  value: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(TRAILING_SLASH_RE, "");
}

function buildConnectTargets(origin: string) {
  const base = trimTrailingSlash(origin);
  const mcpUrl = `${base}/mcp`;
  return {
    agentEntrypoint: `${base}/llms.txt`,
    claudeCodeCommand: `claude mcp add --transport http pdpp ${mcpUrl}`,
    codexCommand: `codex mcp add pdpp --url ${mcpUrl}`,
    mcpUrl,
    pdppCliCommand: `npx -y @pdpp/cli@beta connect ${base}`,
  };
}

function buildCimdCommands(mcpUrl: string, clientId: string) {
  return {
    claudeCodeCimdCommand: `claude mcp add --transport http --client-id ${clientId} pdpp ${mcpUrl}`,
    codexCimdCommand: `codex mcp add pdpp --url ${mcpUrl} --oauth-resource ${mcpUrl} --oauth-client-id ${clientId}`,
  };
}

function sourceSetupRank(entry: ConnectorCatalogEntry): number {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return 0;
    case "browser_collector_manual":
      return 1;
    case "static_secret_connect":
      return 2;
    case "provider_auth_deployment_blocked":
      return 3;
    case "browser_bound_runbook":
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      return 4;
    case "api_network_unsupported":
    case "unknown_unsupported":
      return 5;
    default:
      return 6;
  }
}

function sortSourceCatalog(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return [...catalog].sort((a, b) => {
    const rank = sourceSetupRank(a) - sourceSetupRank(b);
    return rank !== 0 ? rank : a.displayName.localeCompare(b.displayName);
  });
}

function filterSourceCatalog(catalog: readonly ConnectorCatalogEntry[], query: string): ConnectorCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  const sorted = sortSourceCatalog(catalog);
  if (!needle) {
    return sorted;
  }
  return sorted.filter((entry) =>
    [entry.displayName, entry.connectorKey, entry.disposition, entry.setupModality, entry.supportState]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
}

function sourceSetupStatus(entry: ConnectorCatalogEntry): { label: string; tone: string } {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return { label: "Ready", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" };
    case "browser_collector_manual":
      return { label: "Manual setup", tone: "border-amber-500/30 bg-amber-500/10 text-amber-700" };
    case "static_secret_connect":
      return { label: "Ready with provider secret", tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700" };
    case "provider_auth_deployment_blocked":
      return { label: "Deployment needed", tone: "border-amber-500/30 bg-amber-500/10 text-amber-700" };
    case "browser_bound_runbook":
      return { label: "Needs browser proof", tone: "border-border bg-muted/30 text-muted-foreground" };
    case "local_collector_unproven":
    case "provider_auth_proof_gated":
      return { label: "Not ready yet", tone: "border-border bg-muted/30 text-muted-foreground" };
    default:
      return { label: "No setup path yet", tone: "border-border bg-muted/30 text-muted-foreground" };
  }
}

function sourceSetupGuidance(entry: ConnectorCatalogEntry): string {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return "Set up the local collector on the machine that has this data. Repeat setup to add another device or account.";
    case "browser_collector_manual":
      return "Start browser setup, then finish from an owner-logged-in browser. Repeat setup for another account.";
    case "static_secret_connect":
      return "Enter the provider secret in the protected setup form. Submit again to add another mailbox or account.";
    case "provider_auth_deployment_blocked":
      return `Configure instance-level provider app material first: ${entry.deploymentReadiness.blockers
        .map((blocker) => blocker.label || blocker.key)
        .join(", ")}.`;
    case "browser_bound_runbook":
      return entry.runbookPath
        ? `This source needs a completed browser setup proof before one-click setup is advertised. Manual path: ${entry.runbookPath}.`
        : "This source needs a completed browser setup proof before one-click setup is advertised.";
    case "local_collector_unproven":
      return "This local-source connector needs a committed collector setup proof before it can be started here.";
    case "provider_auth_proof_gated":
      return entry.runbookPath
        ? `Provider authorization is not fully wired yet. Tracking runbook: ${entry.runbookPath}.`
        : "Provider authorization is not fully wired yet.";
    case "api_network_unsupported":
      return "This source has no owner-mediated setup path in this build. It is visible so unsupported does not look like omission.";
    default:
      return "This connector is registered without a setup path the reference can classify.";
  }
}

function sourceSetupAction(entry: ConnectorCatalogEntry): { href: string; label: string } | null {
  switch (entry.disposition) {
    case "local_collector_enroll":
      return {
        href: `/dashboard/device-exporters?connector=${encodeURIComponent(entry.enrollmentKey ?? entry.connectorKey)}`,
        label: "Set up collector",
      };
    case "browser_collector_manual":
      return {
        href: `/dashboard/device-exporters?connector=${encodeURIComponent(entry.enrollmentKey ?? entry.connectorKey)}`,
        label: "Start browser setup",
      };
    case "static_secret_connect":
      return {
        href: `/dashboard/connect/static-secret/${encodeURIComponent(entry.connectorKey)}`,
        label: "Add account",
      };
    case "provider_auth_deployment_blocked":
      return { href: "/dashboard/deployment", label: "Open deployment" };
    default:
      return null;
  }
}

function connectorExplainCommand(entry: ConnectorCatalogEntry): string {
  return `pdpp owner-agent connectors explain ${entry.connectorKey}`;
}

function CopyRow({ body, label, title, value }: SetupEntry) {
  return (
    <li className="grid gap-2 py-4 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-5">
      <div>
        <h3 className="pdpp-title text-foreground">{title}</h3>
        <p className="pdpp-caption mt-0.5 text-muted-foreground">{body}</p>
      </div>
      <div className="flex min-w-0 items-start gap-2">
        <code className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border/80 bg-muted/30 px-3 py-2 font-mono text-foreground">
          {value}
        </code>
        <CopyButton ariaLabel={`Copy ${label}`} value={value} />
      </div>
    </li>
  );
}

function SourceSetupCard({ entry }: { entry: ConnectorCatalogEntry }) {
  const status = sourceSetupStatus(entry);
  const action = sourceSetupAction(entry);
  const cliCommand = connectorExplainCommand(entry);
  return (
    <li
      className="grid gap-3 rounded-md border border-border/80 bg-card p-4 lg:grid-cols-[minmax(0,1fr)_auto]"
      data-testid={`source-setup-${entry.connectorKey}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="pdpp-title text-foreground">{entry.displayName}</h3>
          <span className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${status.tone}`}>{status.label}</span>
        </div>
        <p className="pdpp-caption mt-1 text-muted-foreground">{sourceSetupGuidance(entry)}</p>
        <div className="pdpp-caption mt-3 flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
          <span>CLI preview</span>
          <code className="max-w-full overflow-x-auto rounded border border-border/70 bg-muted/30 px-2 py-1 font-mono text-foreground">
            {cliCommand}
          </code>
          <CopyButton ariaLabel={`Copy CLI preview for ${entry.displayName}`} value={cliCommand} />
        </div>
      </div>
      <div className="flex items-start justify-end gap-2">
        {action ? (
          <Link className={buttonVariants({ variant: "default", size: "sm" })} href={action.href}>
            {action.label}
          </Link>
        ) : (
          <span className="pdpp-caption rounded-md border border-border/70 bg-muted/20 px-2.5 py-1 text-muted-foreground">
            Track only
          </span>
        )}
      </div>
    </li>
  );
}

function SourceSetupSection({
  catalog,
  query,
}: {
  catalog: readonly ConnectorCatalogEntry[];
  query: string;
}) {
  const filtered = filterSourceCatalog(catalog, query);
  return (
    <Section
      description="Search every connector this build knows about. Each source shows one status and one next action; repeat the same setup to add another account."
      title="Add data sources"
    >
      <form action="/dashboard/connect" className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="sr-only" htmlFor="source_q">
          Search data sources
        </label>
        <Input
          defaultValue={query}
          id="source_q"
          name="source_q"
          placeholder="Search Amazon, Gmail, Slack, ChatGPT..."
        />
        <Button size="sm" type="submit" variant="outline">
          Search
        </Button>
      </form>
      {filtered.length > 0 ? (
        <ul className="grid gap-3">
          {filtered.map((entry) => (
            <SourceSetupCard entry={entry} key={entry.connectorKey} />
          ))}
        </ul>
      ) : (
        <p className="pdpp-caption rounded-md border border-border/80 border-dashed p-4 text-muted-foreground">
          No connector matched <span className="font-medium text-foreground">{query}</span>. Try the provider name or
          connector key.
        </p>
      )}
    </Section>
  );
}

function InlineNotice({ kind, message }: { kind: "error" | "notice"; message: string }) {
  const tone =
    kind === "error"
      ? "border-destructive/30 bg-destructive/5 text-destructive"
      : "border-border/80 bg-muted/30 text-muted-foreground";
  return <div className={`pdpp-caption rounded-md border px-4 py-2.5 ${tone}`}>{message}</div>;
}

function noticeText(code?: string): string | null {
  if (code === "client_identity_created") {
    return "Client identity created. Copy the explicit command for the MCP client you are configuring.";
  }
  if (code === "client_identity_deleted") {
    return "Client identity revoked. Its metadata URL is gone and issued access was revoked server-side.";
  }
  return null;
}

function ClientIdentityForm() {
  return (
    <form
      action={createCimdClientIdentityAction}
      className="grid gap-3 rounded-md border border-border/80 bg-muted/20 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] lg:items-end"
    >
      <label className="grid gap-1" htmlFor="cimd-client-name">
        <span className="pdpp-eyebrow">Client name</span>
        <Input defaultValue="Claude Code" id="cimd-client-name" name="client_name" />
      </label>
      <label className="grid gap-1" htmlFor="cimd-redirect-uri">
        <span className="pdpp-eyebrow">Redirect URI</span>
        <Input
          defaultValue="http://localhost:1455/callback"
          id="cimd-redirect-uri"
          name="redirect_uri"
          placeholder="http://localhost:<port>/callback"
        />
      </label>
      <Button size="sm" type="submit" variant="outline">
        Create identity
      </Button>
    </form>
  );
}

function ClientIdentityList({
  identities,
  selectedId,
}: {
  identities: CimdClientDocument[];
  selectedId: string | null;
}) {
  if (!identities.length) {
    return (
      <p className="pdpp-caption rounded-md border border-border/80 border-dashed p-4 text-muted-foreground">
        No stable client identities yet. Create one when a local MCP client supports an explicit URL-shaped{" "}
        <code className="font-mono">client_id</code>.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border/70 rounded-md border border-border/80">
      {identities.map((identity) => {
        const selected = identity.document_id === selectedId;
        return (
          <li
            className={`grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] ${selected ? "bg-muted/30" : ""}`}
            key={identity.document_id}
          >
            <div className="min-w-0">
              <div className="pdpp-body font-medium">{identity.client_name ?? "Custom MCP client"}</div>
              <div className="pdpp-caption mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                <code className="max-w-full overflow-x-auto font-mono text-xs">{identity.client_id}</code>
                <span aria-hidden>·</span>
                <span>{identity.redirect_uris[0] ?? "no redirect URI"}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                className={buttonVariants({ variant: selected ? "secondary" : "outline", size: "sm" })}
                href={`/dashboard/connect?client_identity=${encodeURIComponent(identity.document_id)}`}
              >
                {selected ? "Selected" : "Use"}
              </Link>
              <form action={deleteCimdClientIdentityAction}>
                <input name="document_id" type="hidden" value={identity.document_id} />
                <Button size="sm" type="submit" variant="destructive">
                  Revoke
                </Button>
              </form>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SelectedIdentityCommands({
  mcpUrl,
  selected,
  targets,
}: {
  mcpUrl: string;
  selected: CimdClientDocument | null;
  targets: ReturnType<typeof buildConnectTargets>;
}) {
  if (!selected) {
    return null;
  }
  const cimd = buildCimdCommands(mcpUrl, selected.client_id);
  const entries: SetupEntry[] = [
    {
      title: "Claude Code",
      body: "Default discovery; use this unless the client asks for an explicit client_id.",
      label: "Claude Code default command",
      value: targets.claudeCodeCommand,
    },
    {
      title: "Claude Code + CIMD",
      body: "Pins this local client to the selected stable metadata URL.",
      label: "Claude Code CIMD command",
      value: cimd.claudeCodeCimdCommand,
    },
    {
      title: "Codex",
      body: "Default discovery for the hosted MCP endpoint.",
      label: "Codex default command",
      value: targets.codexCommand,
    },
    {
      title: "Codex + CIMD",
      body: "Pins Codex to the selected stable metadata URL.",
      label: "Codex CIMD command",
      value: cimd.codexCimdCommand,
    },
  ];
  return (
    <div className="mt-5">
      <div className="mb-2">
        <p className="pdpp-eyebrow">Selected identity</p>
        <p className="pdpp-caption text-muted-foreground">
          {selected.client_name ?? "Custom MCP client"} · <code className="font-mono">{selected.document_id}</code>
        </p>
      </div>
      <ul className="divide-y divide-border/70 border-border/70 border-y">
        {entries.map((entry) => (
          <CopyRow key={entry.title} {...entry} />
        ))}
      </ul>
    </div>
  );
}

export default async function ConnectPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  let origin: string;
  let identities: CimdClientDocument[] = [];
  let catalog: ConnectorCatalogEntry[] = [];
  try {
    const [resolvedOrigin, resolvedIdentities, manifests] = await Promise.all([
      getReferencePublicOrigin(),
      listCimdClientDocuments(),
      listConnectorManifests(),
    ]);
    origin = resolvedOrigin;
    identities = resolvedIdentities.data;
    catalog = buildConnectorCatalog(manifests);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="connect">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }
  const sourceQuery = typeof params.source_q === "string" ? params.source_q.trim() : "";
  const targets = buildConnectTargets(origin);
  const selected =
    identities.find((identity) => identity.document_id === params.client_identity) ?? identities[0] ?? null;
  const notice = noticeText(params.notice);
  const primaryEntries: SetupEntry[] = [
    {
      title: "MCP URL",
      body: "Use this for ChatGPT, Claude.ai, and any remote MCP custom connector flow.",
      label: "MCP server URL",
      value: targets.mcpUrl,
    },
    {
      title: "Claude Code",
      body: "Adds the remote Streamable HTTP MCP server.",
      label: "Claude Code command",
      value: targets.claudeCodeCommand,
    },
    {
      title: "Codex",
      body: "Adds the same remote MCP endpoint without a bearer-token env var.",
      label: "Codex command",
      value: targets.codexCommand,
    },
  ];
  const secondaryEntries: SetupEntry[] = [
    {
      title: "PDPP CLI",
      body: "For a shell agent that will use scoped REST reads instead of hosted MCP.",
      label: "PDPP CLI connect command",
      value: targets.pdppCliCommand,
    },
    {
      title: "Agent skill",
      body: "For agents that discover instructions before choosing MCP or CLI.",
      label: "agent-readable entrypoint URL",
      value: targets.agentEntrypoint,
    },
  ];

  return (
    <DashboardShell active="connect">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/deployment">
            Deployment readiness
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard", label: "Dashboard" }, { label: "Connect" }]}
        description="Add data sources to populate this instance, then connect AI apps and local agents to the grant-scoped read surface."
        title="Connect"
      />

      <div className="mb-5 grid gap-2">
        {params.error ? <InlineNotice kind="error" message={params.error} /> : null}
        {notice ? <InlineNotice kind="notice" message={notice} /> : null}
      </div>

      <SourceSetupSection catalog={catalog} query={sourceQuery} />

      <Section
        description="Use these when an AI app or local agent needs read access to records already collected in this PDPP instance."
        title="Connect AI apps"
      >
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {primaryEntries.map((entry) => (
            <CopyRow key={entry.title} {...entry} />
          ))}
        </ul>
      </Section>

      <Section
        description="Create one only when a local client needs an explicit URL-shaped client_id. The redirect URI must match the client callback exactly."
        title="Stable local client identity"
      >
        <div className="grid gap-4">
          <ClientIdentityForm />
          <ClientIdentityList identities={identities} selectedId={selected?.document_id ?? null} />
        </div>
        <SelectedIdentityCommands mcpUrl={targets.mcpUrl} selected={selected} targets={targets} />
      </Section>

      <Section
        description="Use these only when the agent is running locally or reading the public agent instructions."
        title="Other agent entrypoints"
      >
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {secondaryEntries.map((entry) => (
            <CopyRow key={entry.title} {...entry} />
          ))}
        </ul>
      </Section>

      <Callout
        action={
          <Link className="underline-offset-2 hover:underline" href="/dashboard/deployment/tokens">
            Owner-agent access →
          </Link>
        }
        surface="human"
        title="Owner credentials stay out of ordinary MCP setup"
      >
        <p className="pdpp-caption text-muted-foreground">
          Claude, ChatGPT, Codex, Claude Code, and third-party MCP clients should use the scoped OAuth flow at{" "}
          <code className="font-mono">/mcp</code>. Trusted local owner automation is a separate flow.
        </p>
      </Callout>
    </DashboardShell>
  );
}
