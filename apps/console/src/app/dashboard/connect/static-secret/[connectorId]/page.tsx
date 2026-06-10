import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { DashboardShell } from "../../../components/shell.tsx";
import {
  isStaticSecretConnector,
  STATIC_SECRET_ADD_MODALITY,
  staticSecretConnectorLabel,
} from "../../../lib/connection-modality.ts";
import { createStaticSecretConnectionAction } from "./actions.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

interface PageSearchParams {
  connection_id?: string;
  error?: string;
  notice?: string;
  run_id?: string;
}

function InlineNotice({ kind, message }: { kind: "error" | "notice"; message: string }) {
  const tone =
    kind === "error"
      ? "border-destructive/30 bg-destructive/5 text-destructive"
      : "border-border/80 bg-muted/30 text-muted-foreground";
  return <div className={`pdpp-caption rounded-md border px-4 py-2.5 ${tone}`}>{message}</div>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function noticeText(params: PageSearchParams): string | null {
  if (params.notice !== "first_sync_started") {
    return null;
  }
  const connectionId = params.connection_id ? ` Connection: ${params.connection_id}.` : "";
  const runId = params.run_id ? ` Run: ${params.run_id}.` : "";
  return `Credential captured and first sync started.${connectionId}${runId} The connection appears after the first accepted ingest.`;
}

export default async function StaticSecretConnectPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);
  if (!isStaticSecretConnector(connectorId)) {
    notFound();
  }
  const resolvedSearchParams = await searchParams;
  const pageParams: PageSearchParams = {
    connection_id: firstValue(resolvedSearchParams.connection_id),
    error: firstValue(resolvedSearchParams.error),
    notice: firstValue(resolvedSearchParams.notice),
    run_id: firstValue(resolvedSearchParams.run_id),
  };
  const label = staticSecretConnectorLabel(connectorId);
  const secretKind = STATIC_SECRET_ADD_MODALITY.secretKindByConnector[connectorId];
  const notice = noticeText(pageParams);

  return (
    <DashboardShell active="records">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/records">
            Back to connections
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard/records", label: "Connections" }, { label: `Add ${label}` }]}
        description="Create one draft connection, seal the provider secret from this owner session, and start the first sync. The connection is hidden until ingest accepts records."
        title={`Add ${label}`}
      />

      <div className="mb-5 grid gap-2">
        {pageParams.error ? <InlineNotice kind="error" message={pageParams.error} /> : null}
        {notice ? <InlineNotice kind="notice" message={notice} /> : null}
      </div>

      <Section
        description="This form is for the owner of this reference instance. The secret is submitted directly to the owner-session capture route and is not returned to agents, MCP clients, REST reads, audit payloads, or the dashboard."
        title={`${label} provider secret`}
      >
        <form action={createStaticSecretConnectionAction} className="grid max-w-2xl gap-4 rounded-md border border-border/80 bg-muted/20 p-4">
          <input name="connector_id" type="hidden" value={connectorId} />
          <label className="grid gap-1" htmlFor="static-secret-value">
            <span className="pdpp-eyebrow">{secretKind}</span>
            <Input
              autoComplete="off"
              id="static-secret-value"
              name="secret"
              placeholder={connectorId === "gmail" ? "Google app password" : "GitHub personal access token"}
              required
              type="password"
            />
          </label>
          <div>
            <Button type="submit">Create connection and start first sync</Button>
          </div>
        </form>
      </Section>

      <Callout
        className="mt-5"
        description="Static-secret setup is still connection-scoped: submit the form again for a second mailbox or account. Each submission creates a separate connection id."
        surface="human"
        title="No deployment env var per account"
      >
        <p className="pdpp-caption text-muted-foreground">
          `PDPP_CREDENTIAL_ENCRYPTION_KEY` is the instance-level prerequisite. Gmail app passwords and GitHub tokens are
          per-connection source credentials, captured here instead of stored in Railway, Docker, or Fly environment
          variables.
        </p>
      </Callout>
    </DashboardShell>
  );
}
