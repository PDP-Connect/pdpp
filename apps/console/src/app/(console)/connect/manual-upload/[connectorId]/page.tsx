// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { existingSourcesForConnector as fetchExistingSourcesForConnector } from "../../../components/existing-sources-by-connector.ts";
import { getManualUploadSetup, RefNotFoundError } from "../../../lib/ref-client.ts";
import { formatTotalRecordsLabel } from "../../../lib/total-records-label.ts";
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

/**
 * EXACT per-connector existing-sources lookup (`existing-sources-by-connector.ts`
 * — one `GET /_ref/connections?connector_id=` call, plus a scoped
 * per-connection `listConnectorSummaries` backfill for record counts /
 * latest-import facts). Replaces the rejected one-arbitrary-fleet-page
 * stopgap: this connector's existing sources are exact by construction,
 * never a partial slice that happens to look complete because it landed on
 * the global final page.
 */
async function existingSourcesForManualUpload(connectorId: string) {
  const links = await fetchExistingSourcesForConnector(connectorId);
  return links.map((link) => ({
    connection_id: link.connectionId,
    detail: `${formatTotalRecordsLabel(link.totalRecords, link.totalRecordsState, "records")}${
      link.latestImportStatus ? ` · ${link.latestImportStatus}` : ""
    }`,
    display_name: link.displayName,
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
          Open instructions in a new tab
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
  const resolvedSearchParams = await searchParams;
  const setup = await getManualUploadSetup(connectorId).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });
  const error = firstValue(resolvedSearchParams.error);
  const targetConnectionId = firstValue(resolvedSearchParams.connection_id) ?? null;

  // EXACT per-connector lookup (existing-sources-by-connector.ts) — never a
  // fleet page filtered client-side. No incompleteness signal to surface:
  // this connector's existing sources are exact by construction.
  const existingSources = targetConnectionId ? [] : await existingSourcesForManualUpload(setup.connector_id);

  // Primary acquisition methods lead; advanced/secondary paths sit behind one
  // disclosure so the recommended path is obvious and the page stays low-noise.
  const primaryMethods = setup.acquisition_methods.filter((method) => method.posture === "primary");
  const advancedMethods = setup.acquisition_methods.filter((method) => method.posture !== "primary");

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources">
            Back to Sources
          </Link>
        }
        breadcrumbs={[{ href: "/sources", label: "Sources" }, { label: `Import ${setup.display_name}` }]}
        description="Pick a supported export file. PDPP validates it, imports it, and gives you a coverage receipt you can revisit."
        title={targetConnectionId ? `Import another ${setup.display_name} file` : `Import ${setup.display_name}`}
      />

      <div className="mb-5 grid gap-2">{error ? <InlineNotice message={error} /> : null}</div>

      <Section
        description={
          setup.description ??
          "The uploaded file is stored for this source and is not exposed to connected apps or clients."
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
