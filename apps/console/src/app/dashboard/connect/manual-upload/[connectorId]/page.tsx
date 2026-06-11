import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { DashboardShell } from "../../../components/shell.tsx";
import { getManualUploadSetup, RefNotFoundError } from "../../../lib/ref-client.ts";
import { createManualUploadConnectionAction } from "./actions.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function InlineNotice({ message }: { message: string }) {
  return (
    <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive">
      {message}
    </div>
  );
}

export default async function ManualUploadConnectPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);
  const setup = await getManualUploadSetup(connectorId).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });
  const resolvedSearchParams = await searchParams;
  const error = firstValue(resolvedSearchParams.error);
  const acceptLabel = setup.accepted_file_names.length > 0 ? setup.accepted_file_names.join(", ") : "JSON export file";

  return (
    <DashboardShell active="records">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/records">
            Back to Sources
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard/records", label: "Sources" }, { label: `Import ${setup.display_name}` }]}
        description="Upload an owner-exported file to start the first sync. The connection stays hidden until the first sync accepts records."
        title={`Import ${setup.display_name}`}
      />

      <div className="mb-5 grid gap-2">{error ? <InlineNotice message={error} /> : null}</div>

      <Section
        description={
          setup.description ??
          "This form is generated from the connector manifest. The uploaded file is stored for this connection and is never returned to agents, MCP clients, REST reads, or audit payloads."
        }
        title={setup.label}
      >
        {setup.acquisition_methods.length > 0 ? (
          <div className="mb-4 grid max-w-2xl gap-2">
            {setup.acquisition_methods.map((method) => (
              <div className="rounded-md border border-border/80 bg-background px-4 py-3" key={method.label}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{method.label}</span>
                  {method.posture ? (
                    <span className="pdpp-caption rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {method.posture}
                    </span>
                  ) : null}
                </div>
                {method.detail ? <p className="pdpp-caption mt-1 text-muted-foreground">{method.detail}</p> : null}
                {method.help_url ? (
                  <a
                    className="pdpp-caption mt-1 inline-flex underline decoration-dotted underline-offset-4"
                    href={method.help_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open instructions
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <form
          action={createManualUploadConnectionAction}
          className="grid max-w-2xl gap-4 rounded-md border border-border/80 bg-muted/20 p-4"
          encType="multipart/form-data"
        >
          <input name="connector_id" type="hidden" value={setup.connector_id} />
          <label className="grid gap-1" htmlFor="manual-upload-file">
            <span className="pdpp-eyebrow">Export file</span>
            <input
              accept={setup.accepted_file_names.length > 0 ? setup.accepted_file_names.join(",") : undefined}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:font-medium file:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              id="manual-upload-file"
              name="import_file"
              required
              type="file"
            />
            <span className="pdpp-caption text-muted-foreground">
              Accepted file names: {acceptLabel}
              {setup.help_url ? (
                <>
                  {". "}
                  <a
                    className="underline decoration-dotted underline-offset-4"
                    href={setup.help_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Export instructions
                  </a>
                </>
              ) : null}
            </span>
            {setup.help_text ? <span className="pdpp-caption text-muted-foreground">{setup.help_text}</span> : null}
          </label>
          {setup.validation_expectations.length > 0 ? (
            <div className="pdpp-caption rounded-md border border-border/80 bg-background px-3 py-2 text-muted-foreground">
              Validation checks: {setup.validation_expectations.join(", ")}.
            </div>
          ) : null}
          <div>
            <Button type="submit">Upload and start first sync</Button>
          </div>
        </form>
        {setup.large_file_fallback ? (
          <p className="pdpp-caption mt-3 max-w-2xl text-muted-foreground">{setup.large_file_fallback}</p>
        ) : null}
      </Section>

      <Callout
        className="mt-5"
        description="After the first import, refresh this source from its status page so new files keep the same source identity and record their own import provenance."
        surface="human"
        title="No deployment changes"
      >
        <p className="pdpp-caption text-muted-foreground">
          This is a file import. No provider account sign-in or deployment change is required.
        </p>
      </Callout>
    </DashboardShell>
  );
}
