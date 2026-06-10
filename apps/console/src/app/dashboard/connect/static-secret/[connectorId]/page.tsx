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
  error?: string;
}

function InlineNotice({ message }: { message: string }) {
  return (
    <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive">
      {message}
    </div>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
    error: firstValue(resolvedSearchParams.error),
  };
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
        description="Seal the provider secret from this owner session and start the first sync. The account keeps its own connection identity and credentials."
        title={`Add ${setup.display_name}`}
      />

      <div className="mb-5 grid gap-2">
        {pageParams.error ? <InlineNotice message={pageParams.error} /> : null}
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
                        <a
                          className="underline decoration-dotted underline-offset-4"
                          href={field.help_url}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open provider setup page in a new tab
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
        description="Submit the form again for a second mailbox or account. Each submission creates a separate connection with its own stored credential."
        surface="human"
        title="Add another account without changing deployment settings"
      >
        <p className="pdpp-caption text-muted-foreground">
          The deployment only needs an instance-level credential key provider. Account credentials are captured here for
          one connection at a time.
        </p>
      </Callout>
    </DashboardShell>
  );
}
