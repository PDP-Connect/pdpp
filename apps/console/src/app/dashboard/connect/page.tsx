import { buttonVariants, IcButton, IcField, IcInput } from "@pdpp/brand-react";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type CimdClientDocument, listCimdClientDocuments } from "../lib/ref-client.ts";
import { createCimdClientIdentityAction, deleteCimdClientIdentityAction } from "./actions.ts";

export const dynamic = "force-dynamic";

const TRAILING_SLASH_RE = /\/+$/;

interface PageParams {
  client_identity?: string;
  error?: string;
  notice?: string;
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
    pdppCliCommand: `npx -y @pdpp/cli connect ${base}`,
  };
}

function buildCimdCommands(mcpUrl: string, clientId: string) {
  return {
    claudeCodeCimdCommand: `claude mcp add --transport http --client-id ${clientId} pdpp ${mcpUrl}`,
    codexCimdCommand: `codex mcp add pdpp --url ${mcpUrl} --oauth-resource ${mcpUrl} --oauth-client-id ${clientId}`,
  };
}

function CopyRow({ body, label, title, value }: SetupEntry) {
  return (
    <li className="grid gap-2 py-4 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6">
      <div>
        <h3 className="pdpp-title text-foreground">{title}</h3>
        <p className="pdpp-caption mt-1 text-muted-foreground">{body}</p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <code className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border/80 bg-muted/30 px-3 py-2 font-mono text-foreground">
          {value}
        </code>
        <CopyButton ariaLabel={`Copy ${label}`} value={value} />
      </div>
    </li>
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
    <form action={createCimdClientIdentityAction} className="rounded-md border border-border/80 bg-muted/20 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <IcField htmlFor="cimd-client-name" label="Client name">
          <IcInput defaultValue="Claude Code" id="cimd-client-name" name="client_name" />
        </IcField>
        <IcField htmlFor="cimd-redirect-uri" label="Redirect URI">
          <IcInput
            defaultValue="http://localhost:1455/callback"
            id="cimd-redirect-uri"
            name="redirect_uri"
            placeholder="http://localhost:<port>/callback"
          />
        </IcField>
      </div>
      <div className="mt-3 flex justify-end">
        <IcButton size="sm" type="submit" variant="ghost">
          Create identity
        </IcButton>
      </div>
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
                className={buttonVariants({ variant: selected ? "default" : "ghost", size: "sm" })}
                href={`/dashboard/connect?client_identity=${encodeURIComponent(identity.document_id)}`}
              >
                {selected ? "Selected" : "Use"}
              </Link>
              <form action={deleteCimdClientIdentityAction}>
                <input name="document_id" type="hidden" value={identity.document_id} />
                <IcButton size="sm" type="submit" variant="destructive">
                  Revoke
                </IcButton>
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
  try {
    const [resolvedOrigin, resolvedIdentities] = await Promise.all([
      getReferencePublicOrigin(),
      listCimdClientDocuments(),
    ]);
    origin = resolvedOrigin;
    identities = resolvedIdentities.data;
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette build="pdpp 0.1.0" host="this server">
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }
  const targets = buildConnectTargets(origin);
  const selected =
    identities.find((identity) => identity.document_id === params.client_identity) ?? identities[0] ?? null;
  const notice = noticeText(params.notice);
  const primaryEntries: SetupEntry[] = [
    {
      title: "MCP URL",
      body: "Use this for ChatGPT, Claude.ai, and remote MCP clients. Browser clients use PKCE; sandboxed clients can use the advertised device-code flow.",
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
    <RecordroomShellWithPalette build="pdpp 0.1.0" host="this server">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/deployment">
            Deployment readiness
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard", label: "Dashboard" }, { label: "Connect AI apps" }]}
        description="Give AI apps and local agents grant-scoped read access to data already in this instance. To add or manage the data sources that populate it, go to Sources."
        title="Connect AI apps"
      />

      <div className="mb-5 grid gap-2">
        {params.error ? <InlineNotice kind="error" message={params.error} /> : null}
        {notice ? <InlineNotice kind="notice" message={notice} /> : null}
      </div>

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

      <Callout
        action={
          <Link className="underline-offset-2 hover:underline" href={dashboardRoutes.section.addSource}>
            Add a source →
          </Link>
        }
        title="Need more data first?"
        tone="info"
      >
        <p className="pdpp-caption text-callout-info-fg/80">
          Source accounts are managed under Sources. Keep this page for AI app and agent read-access setup.
        </p>
      </Callout>

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
        title="Owner credentials stay out of ordinary MCP setup"
        tone="info"
      >
        <p className="pdpp-caption text-callout-info-fg/80">
          Claude, ChatGPT, Codex, Claude Code, and third-party MCP clients should use the scoped OAuth flow at{" "}
          <code className="font-mono">/mcp</code>. Headless MCP setup still returns a scoped client token, not an owner
          bearer. Trusted local owner automation is a separate flow.
        </p>
      </Callout>
    </RecordroomShellWithPalette>
  );
}
