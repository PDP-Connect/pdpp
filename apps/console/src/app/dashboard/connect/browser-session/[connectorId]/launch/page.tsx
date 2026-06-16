import { buttonVariants } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { formatConnectorKeyForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { isBrowserBoundConnector } from "../../../../lib/connection-modality.ts";
import { BrowserSessionLaunchPanel } from "./launch-panel.tsx";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BrowserSessionLaunchPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  if (!isBrowserBoundConnector(connectorId)) {
    notFound();
  }

  const resolvedSearchParams = await searchParams;
  const connectionId = firstValue(resolvedSearchParams.connection_id)?.trim();
  const draft = firstValue(resolvedSearchParams.draft) === "1";

  if (!connectionId) {
    notFound();
  }

  const displayName = formatConnectorKeyForDisplay(connectorId);

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/records">
            Back to sources
          </Link>
        }
        breadcrumbs={[
          { href: "/dashboard/records", label: "Sources" },
          {
            href: `/dashboard/connect/browser-session/${encodeURIComponent(connectorId)}`,
            label: `Connect ${displayName}`,
          },
          { label: "Starting browser" },
        ]}
        description={`PDPP is starting a secure browser session for ${displayName}.`}
        title="Starting secure browser"
      />

      <div className="mx-auto max-w-lg px-4 py-8">
        <BrowserSessionLaunchPanel connectionId={connectionId} connectorId={connectorId} draft={draft} />
      </div>
    </RecordroomShellWithPalette>
  );
}
