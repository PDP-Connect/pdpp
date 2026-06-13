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

interface AcquisitionMethod {
  detail: string | null;
  help_url: string | null;
  label: string;
  platform: string | null;
  posture: string | null;
}

function MethodCard({ method }: { method: AcquisitionMethod }) {
  return (
    <div className="rounded-md border border-border/80 bg-background px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{method.label}</span>
        {method.platform ? (
          <span className="pdpp-caption rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">{method.platform}</span>
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

  // Primary acquisition methods lead; advanced/secondary paths sit behind one
  // disclosure so the recommended path is obvious and the page stays low-noise.
  const primaryMethods = setup.acquisition_methods.filter((method) => method.posture === "primary");
  const advancedMethods = setup.acquisition_methods.filter((method) => method.posture !== "primary");
  const hasValidator = setup.validation_expectations.length > 0;

  return (
    <DashboardShell active="records">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/records">
            Back to Sources
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard/records", label: "Sources" }, { label: `Import ${setup.display_name}` }]}
        description="Bring your exported data in. Pick the file you exported, PDPP validates it before anything is committed, then imports it and shows a durable coverage receipt you can revisit."
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
        {primaryMethods.length > 0 ? (
          <div className="mb-4 grid max-w-2xl gap-2">
            {primaryMethods.map((method) => (
              <MethodCard key={method.label} method={method} />
            ))}
          </div>
        ) : null}
        {advancedMethods.length > 0 ? (
          <details className="mb-4 max-w-2xl">
            <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
              Other ways to export this data
            </summary>
            <div className="mt-2 grid gap-2">
              {advancedMethods.map((method) => (
                <MethodCard key={method.label} method={method} />
              ))}
            </div>
          </details>
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
          {hasValidator ? (
            <div className="pdpp-caption rounded-md border border-border/80 bg-background px-3 py-2 text-muted-foreground">
              PDPP validates before committing anything: {setup.validation_expectations.join(", ")}. If the file does not
              pass, nothing is imported.
            </div>
          ) : null}
          <div>
            <Button type="submit">{hasValidator ? "Validate and import" : "Import file"}</Button>
          </div>
        </form>
        {setup.large_file_fallback ? (
          <p className="pdpp-caption mt-3 max-w-2xl text-muted-foreground">{setup.large_file_fallback}</p>
        ) : null}
      </Section>

      <Callout
        className="mt-5"
        description="After this import, revisit the source from its status page to import another export. Each import keeps the same source identity and records its own coverage provenance."
        surface="human"
        title="This is a file import"
      >
        <p className="pdpp-caption text-muted-foreground">
          You are importing data you already exported. There is no provider account sign-in and no deployment change.
        </p>
      </Callout>
    </DashboardShell>
  );
}
