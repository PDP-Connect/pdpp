// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

  // Cleanup order, matching the tokens page: never-used first (highest risk —
  // live access across every child grant, zero reads), then least-recently
  // used. Issuance order is the wrong default for a page whose job is finding
  // packages worth revoking.
  const items = [...result.data].sort(byCleanupPriority);
  const neverUsed = items.filter((pkg) => !pkg.last_used_at).length;
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
          <>
            {neverUsed > 0 ? (
              <p className="pdpp-caption mb-3 text-foreground">
                <span className="font-medium">
                  {neverUsed} package{neverUsed === 1 ? " has" : "s have"} never been read
                </span>{" "}
                — every child grant still holds live access. Listed first.
              </p>
            ) : null}
            <DataList>
              {items.map((pkg) => (
                <li key={pkg.package_id}>
                  <PackageRow pkg={pkg} />
                </li>
              ))}
            </DataList>
          </>
        )}
      </Section>
    </RecordroomShellWithPalette>
  );
}

/**
 * Last-read cell. A package that has never served a read still holds its full
 * grant set, so "never used" is called out rather than left blank — a blank
 * cell reads as "no data" instead of "no reads", and hides the packages most
 * worth revoking.
 */
function LastUsed({ value }: { value: string | null }) {
  if (!value) {
    return (
      <span
        className="font-medium text-[color:var(--warning,inherit)]"
        title="No child grant of this package has ever served a read"
      >
        never used
      </span>
    );
  }
  return (
    <span>
      last used <IcTimestamp value={value} />
    </span>
  );
}

function byCleanupPriority(a: GrantPackageSummary, b: GrantPackageSummary): number {
  if (!(a.last_used_at || b.last_used_at)) {
    return a.created_at.localeCompare(b.created_at);
  }
  if (!a.last_used_at) {
    return -1;
  }
  if (!b.last_used_at) {
    return 1;
  }
  return a.last_used_at.localeCompare(b.last_used_at);
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
      <div className="pdpp-caption mt-1 flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
        <span>{memberLabel}</span>
        <span aria-hidden>·</span>
        <LastUsed value={pkg.last_used_at} />
        <span aria-hidden>·</span>
        <span>client {pkg.client_id}</span>
        <span aria-hidden>·</span>
        <span>subject {pkg.subject_id}</span>
      </div>
    </Link>
  );
}
