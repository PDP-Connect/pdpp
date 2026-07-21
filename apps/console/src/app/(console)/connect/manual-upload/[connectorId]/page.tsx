import { buttonVariants } from "@pdpp/brand-react";
import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  getManualUploadSetup,
  listConnectorSummaries,
  type RefConnectorSummary,
  RefNotFoundError,
} from "../../../lib/ref-client.ts";
import { formatTotalRecordsLabel } from "../../../sources/sources-view-model.ts";
import { ManualUploadForm } from "./manual-upload-form.tsx";

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

function sourceDetail(summary: RefConnectorSummary): string {
  const streamCount = summary.stream_count ?? summary.streams.length;
  const streamLabel = `${streamCount} stream${streamCount === 1 ? "" : "s"}`;
  // Sol fourth-verdict P1.3: another direct RefConnectorSummary.total_records
  // renderer — routed through the centralized state-aware label.
  const recordLabel = formatTotalRecordsLabel(summary.total_records, summary.total_records_state, "records");
  return `${recordLabel}, ${streamLabel}`;
}

function existingSourcesForConnector(summaries: readonly RefConnectorSummary[], connectorId: string) {
  return summaries
    .filter((summary) => {
      if (summary.connector_id !== connectorId) {
        return false;
      }
      if (!summary.connection_id) {
        return false;
      }
      return !(summary.status === "revoked" || summary.revoked_at);
    })
    .map((summary) => ({
      connection_id: summary.connection_id,
      display_name: summary.display_name || summary.connector_display_name || summary.connector_id,
      detail: sourceDetail(summary),
    }));
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
        <span className="font-medium text-foreground text-sm">{method.label}</span>
        {method.platform ? (
          <span className="pdpp-caption rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">
            {method.platform}
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
  const [setup, summaries] = await Promise.all([
    getManualUploadSetup(connectorId).catch((err) => {
      if (err instanceof RefNotFoundError) {
        notFound();
      }
      throw err;
    }),
    listConnectorSummaries().then((page) => page.data),
  ]);
  const resolvedSearchParams = await searchParams;
  const error = firstValue(resolvedSearchParams.error);
  const targetConnectionId = firstValue(resolvedSearchParams.connection_id) ?? null;
  const existingSources = targetConnectionId ? [] : existingSourcesForConnector(summaries, setup.connector_id);

  // Primary acquisition methods lead; advanced/secondary paths sit behind one
  // disclosure so the recommended path is obvious and the page stays low-noise.
  const primaryMethods = setup.acquisition_methods.filter((method) => method.posture === "primary");
  const advancedMethods = setup.acquisition_methods.filter((method) => method.posture !== "primary");

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/sources">
            Back to Sources
          </Link>
        }
        breadcrumbs={[{ href: "/sources", label: "Sources" }, { label: `Import ${setup.display_name}` }]}
        description="Bring your exported data in. Pick the supported file you have. PDPP validates it before anything is committed, then imports it and shows a durable coverage receipt you can revisit."
        title={targetConnectionId ? `Import another ${setup.display_name} file` : `Import ${setup.display_name}`}
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
        <ManualUploadForm existingSources={existingSources} setup={setup} targetConnectionId={targetConnectionId} />
        {setup.large_file_fallback ? (
          <p className="pdpp-caption mt-3 max-w-2xl text-muted-foreground">{setup.large_file_fallback}</p>
        ) : null}
      </Section>

      <Callout
        className="mt-5"
        description="After the first import, revisit the source from its status page to import another export into the same source. Use Add source again only for a different account, profile, device, or source identity."
        surface="human"
        title="This is a file import"
      >
        <p className="pdpp-caption text-muted-foreground">
          You are importing data you already exported. There is no provider account sign-in and no deployment change.
        </p>
      </Callout>
    </RecordroomShellWithPalette>
  );
}
