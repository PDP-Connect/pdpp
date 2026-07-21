/**
 * Operator visibility surface for hosted-MCP grant packages.
 *
 * Lists every grant package the deployment has issued (`_ref/grant-packages`).
 * Each row is a Link into `/grants/packages/[packageId]` where
 * the operator can see the child cascade and revoke the package.
 *
 * Spec: openspec/changes/add-grant-package-operator-visibility/
 *       specs/reference-implementation-architecture/spec.md
 */

import { IcTimestamp } from "@pdpp/brand-react";
import { EmptyState } from "@pdpp/operator-ui/components/empty-state";
import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { GRANT_LIFECYCLE_VOCABULARY } from "@pdpp/operator-ui/components/status-vocabularies";
import type { Metadata } from "next";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { type GrantPackageSummary, type ListResponse, listGrantPackages } from "../../lib/ref-client.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Grant packages",
};

export default async function GrantPackagesIndex() {
  let result: ListResponse<GrantPackageSummary>;
  try {
    result = await listGrantPackages();
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Grant packages" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  const items = result.data;
  return (
    <RecordroomShellWithPalette>
      <PageHeader
        description="Hosted-MCP multi-source consent ceremonies issued one package per approval. Each package wraps one or more source-bounded child grants and a single bearer-token lifecycle. Revoke from the detail page to cascade across every child."
        title="Grant packages"
      />
      <Section title={`Packages (${items.length})`}>
        {items.length === 0 ? (
          <EmptyState
            hint="Grant packages appear here after a hosted-MCP OAuth flow approves more than one source in a single ceremony, or after a single-source MCP package ceremony."
            title="No grant packages yet"
          />
        ) : (
          <DataList>
            {items.map((pkg) => (
              <li key={pkg.package_id}>
                <PackageRow pkg={pkg} />
              </li>
            ))}
          </DataList>
        )}
      </Section>
    </RecordroomShellWithPalette>
  );
}

function PackageRow({ pkg }: { pkg: GrantPackageSummary }) {
  const href = `/grants/packages/${encodeURIComponent(pkg.package_id)}`;
  const memberLabel = pkg.member_count === 1 ? "1 source" : `${pkg.member_count} sources`;
  return (
    <Link className="block px-3 py-2.5 transition-colors hover:bg-muted/40" href={href}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="pdpp-caption break-all font-medium font-mono text-foreground">{pkg.package_id}</code>
        <div className="flex items-center gap-2">
          <StatusBadge status={pkg.status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          <span className="pdpp-caption text-muted-foreground">
            <IcTimestamp value={pkg.created_at} />
          </span>
        </div>
      </div>
      <div className="pdpp-caption mt-1 text-muted-foreground">
        {memberLabel}
        {" · "}client {pkg.client_id}
        {" · subject "}
        {pkg.subject_id}
      </div>
    </Link>
  );
}
