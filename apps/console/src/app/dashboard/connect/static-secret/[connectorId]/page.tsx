import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { DashboardShell } from "../../../components/shell.tsx";
import { getStaticSecretSetup, RefNotFoundError, type StaticSecretSetupField } from "../../../lib/ref-client.ts";
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

function inputType(field: StaticSecretSetupField): "email" | "password" | "text" {
  return field.type === "email" || field.type === "password" ? field.type : "text";
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
  const setup = await getStaticSecretSetup(connectorId).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });
  const resolvedSearchParams = await searchParams;
  const pageParams: PageSearchParams = {
    connection_id: firstValue(resolvedSearchParams.connection_id),
    error: firstValue(resolvedSearchParams.error),
    notice: firstValue(resolvedSearchParams.notice),
    run_id: firstValue(resolvedSearchParams.run_id),
  };
  const notice = noticeText(pageParams);
  const readinessBlocked = setup.deployment_readiness.state !== "ready";

  return (
    <DashboardShell active="records">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/records">
            Back to connections
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard/records", label: "Sources" }, { label: `Add ${setup.display_name}` }]}
        description="Create one draft connection, seal the provider secret from this owner session, and start the first sync. The connection is hidden until ingest accepts records."
        title={`Add ${setup.display_name}`}
      />

      <div className="mb-5 grid gap-2">
        {pageParams.error ? <InlineNotice kind="error" message={pageParams.error} /> : null}
        {notice ? <InlineNotice kind="notice" message={notice} /> : null}
      </div>

      <Section
        description={
          setup.credential_capture.description ??
          "This form is generated from the connector manifest. Secrets are submitted to the owner-session capture route and are not returned to agents, MCP clients, REST reads, audit payloads, or the dashboard."
        }
        title={setup.credential_capture.label}
      >
        {readinessBlocked ? (
          <Callout
            description={
              setup.deployment_readiness.guidance ??
              "Configure the instance-level credential key provider before entering a provider credential."
            }
            surface="human"
            title="Credential storage is not ready"
          >
            <ul className="pdpp-caption mt-3 grid gap-1 text-muted-foreground">
              {setup.deployment_readiness.blockers.map((blocker) => (
                <li key={blocker.key}>
                  Set <code>{blocker.key}</code>
                </li>
              ))}
            </ul>
          </Callout>
        ) : (
          <form
            action={createStaticSecretConnectionAction}
            className="grid max-w-2xl gap-4 rounded-md border border-border/80 bg-muted/20 p-4"
          >
            <input name="connector_id" type="hidden" value={setup.connector_id} />
            {setup.credential_capture.fields.map((field) => (
              <label className="grid gap-1" htmlFor={`static-secret-${field.name}`} key={field.name}>
                <span className="pdpp-eyebrow">{field.label}</span>
                <Input
                  autoComplete={field.autocomplete ?? (field.secret ? "off" : undefined)}
                  id={`static-secret-${field.name}`}
                  name={field.name}
                  placeholder={field.placeholder ?? undefined}
                  required={field.required}
                  type={inputType(field)}
                />
                {field.description || field.help_text || field.help_url ? (
                  <span className="pdpp-caption text-muted-foreground">
                    {field.description ?? field.help_text}
                    {field.help_url ? (
                      <>
                        {" "}
                        <a className="underline decoration-dotted underline-offset-4" href={field.help_url}>
                          Open setup page
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </label>
            ))}
            <div>
              <Button type="submit">
                {setup.credential_capture.submit_label ?? "Create connection and start first sync"}
              </Button>
            </div>
          </form>
        )}
      </Section>

      <Callout
        className="mt-5"
        description="Static-secret setup is still connection-scoped: submit the form again for a second mailbox or account. Each submission creates a separate connection id."
        surface="human"
        title="No deployment env var per account"
      >
        <p className="pdpp-caption text-muted-foreground">
          The credential key provider is the instance-level prerequisite. Provider credentials are per-connection source
          credentials, captured here instead of stored in deployment variables.
        </p>
      </Callout>
    </DashboardShell>
  );
}
