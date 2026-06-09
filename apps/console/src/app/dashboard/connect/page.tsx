import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button.tsx";
import { DashboardShell } from "../components/shell.tsx";
import { getReferencePublicOrigin } from "../lib/owner-token.ts";

export const dynamic = "force-dynamic";

interface SetupEntry {
  body: string;
  label: string;
  title: string;
  value: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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

export default async function ConnectPage() {
  const origin = await getReferencePublicOrigin();
  const targets = buildConnectTargets(origin);
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
        description="One place to copy the grant-scoped entrypoints for AI apps and local agents. No owner bearer is needed for ordinary MCP setup."
        title="Connect an AI app"
      />

      <Section title="Start here">
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {primaryEntries.map((entry) => (
            <CopyRow key={entry.title} {...entry} />
          ))}
        </ul>
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
