// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { formatConnectorKeyForDisplay } from "@pdpp/display";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

interface PageSearchParams {
  error?: string;
}

export default async function ProviderAuthPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<PageSearchParams>;
}) {
  const [{ connectorId }, query] = await Promise.all([params, searchParams]);
  const displayName = formatConnectorKeyForDisplay(connectorId);
  return (
    <RecordroomShellWithPalette>
      <PageHeader
        breadcrumbs={[
          { href: "/sources", label: "Sources" },
          { href: "/sources/add", label: "Add source" },
          { label: `Authorize ${displayName}` },
        ]}
        description="Authorize this account in the provider's browser. The connection activates after authorization and account inventory succeed."
        title={`Authorize ${displayName}`}
      />
      <section className="grid max-w-2xl gap-4 rounded-xl border border-border/70 bg-card p-5 shadow-sm">
        {query.error ? (
          <p className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive">
            {query.error}
          </p>
        ) : null}
        <p className="pdpp-body text-muted-foreground">
          Continue to the provider to grant access for this account. Credentials stay with the provider. PDPP activates
          the source after the provider confirms access.
        </p>
        <form action={`/connect/provider-auth/${encodeURIComponent(connectorId)}/start`} method="post">
          <button className={buttonVariants({ size: "sm", variant: "default" })} type="submit">
            Authorize account
          </button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources/add">
            Back to add source
          </Link>
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources">
            Open sources
          </Link>
        </div>
      </section>
    </RecordroomShellWithPalette>
  );
}
