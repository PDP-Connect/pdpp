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
import { DataList, PageHeader, Pager, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
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

interface Params {
  cursor?: string;
}

interface PackageGroup {
  clientCaption: string;
  clientId: string;
  packages: GrantPackageSummary[];
  subjectId: string;
}

export default async function GrantPackagesIndex({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  let result: ListResponse<GrantPackageSummary>;
  try {
    result = await listGrantPackages({ cursor: params.cursor, limit: 50 });
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
  const currentItems = items.filter((pkg) => pkg.status === "active");
  const historicalItems = items.filter((pkg) => pkg.status !== "active");
  const neverUsed = currentItems.filter((pkg) => !pkg.last_used_at).length;
  const nextHref =
    result.has_more && result.next_cursor ? `/grants/packages?cursor=${encodeURIComponent(result.next_cursor)}` : null;
  return (
    <RecordroomShellWithPalette>
      <PageHeader
        count={result.has_more ? `${items.length} on this page` : `${items.length} shown`}
        description="Current access is grouped by the authoritative client authorization relationship. Each package wraps source-bounded child grants; historical and revoked packages remain available below. Client names appear only when registered metadata resolves."
        title="Grant packages"
      />
      <Section
        description="The current view is lifecycle-authoritative. It does not guess which clients are probes from their names, so active access remains visible here."
        title={`Current access (${currentItems.length})`}
      >
        {items.length === 0 ? (
          <EmptyState
            hint="Grant packages appear here after a hosted-MCP OAuth flow approves more than one source in a single ceremony, or after a single-source MCP package ceremony."
            title="No grant packages yet"
          />
        ) : (
          <>
            {currentItems.length === 0 ? (
              <p className="pdpp-caption text-muted-foreground">No active packages on this page.</p>
            ) : null}
            {neverUsed > 0 && currentItems.length > 0 ? (
              <p className="pdpp-caption mb-3 text-foreground">
                <span className="font-medium">
                  {neverUsed} package{neverUsed === 1 ? " has" : "s have"} never been read
                </span>{" "}
                — every child grant still holds live access. Listed first.
              </p>
            ) : null}
            <AuthorizationGroups groups={groupPackages(currentItems)} />
          </>
        )}
      </Section>
      {historicalItems.length > 0 ? (
        <details className="mt-7">
          <summary className="cursor-pointer font-medium text-foreground text-sm underline-offset-2 hover:underline">
            Historical and revoked ({historicalItems.length} on this page)
          </summary>
          <p className="pdpp-caption mt-2 text-muted-foreground">
            Includes revoked and other non-active package evidence. Probe/test residue is not classified by name; use
            the all grants view for the complete child-grant evidence set.
          </p>
          <div className="mt-3">
            <AuthorizationGroups groups={groupPackages(historicalItems)} view="all" />
          </div>
        </details>
      ) : null}
      <Pager countLabel={result.has_more ? `${items.length} on this page` : `${items.length} shown`} next={nextHref} />
    </RecordroomShellWithPalette>
  );
}

function groupPackages(items: readonly GrantPackageSummary[]): PackageGroup[] {
  const groups = new Map<string, PackageGroup>();
  for (const pkg of items) {
    const key = `${pkg.client_id}\u0000${pkg.subject_id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.packages.push(pkg);
      continue;
    }
    groups.set(key, {
      clientCaption: clientCaption(pkg),
      clientId: pkg.client_id,
      packages: [pkg],
      subjectId: pkg.subject_id,
    });
  }
  return [...groups.values()];
}

function clientCaption(pkg: GrantPackageSummary): string {
  if (!pkg.client) {
    return "Unknown registered client";
  }
  const name = pkg.client?.client_name?.trim();
  if (name) {
    return name;
  }
  return "Unnamed registered client";
}

function AuthorizationGroups({
  groups,
  view = "current",
}: {
  groups: readonly PackageGroup[];
  view?: "all" | "current";
}) {
  if (groups.length === 0) {
    return null;
  }
  return (
    <div className="space-y-6">
      {groups.map((group) => {
        const headingId = `grant-package-client-${encodeURIComponent(group.clientId)}-${encodeURIComponent(group.subjectId)}`;
        return (
          <section aria-labelledby={headingId} key={group.clientId + group.subjectId}>
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <div className="min-w-0">
                <h2 className="font-medium text-foreground" id={headingId}>
                  {group.clientCaption}
                </h2>
                <div className="pdpp-caption mt-0.5 flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                  <code className="break-all font-mono" title={group.clientId}>
                    {group.clientId}
                  </code>
                  <span aria-hidden>·</span>
                  <span>subject {group.subjectId}</span>
                </div>
              </div>
              <Link
                className="pdpp-caption shrink-0 underline-offset-2 hover:text-foreground hover:underline"
                href={`/grants?client_id=${encodeURIComponent(group.clientId)}${view === "all" ? "&view=all" : ""}`}
              >
                {view === "all" ? "all grants →" : "current grants →"}
              </Link>
            </div>
            <DataList>
              {group.packages.map((pkg) => (
                <li key={pkg.package_id}>
                  <PackageRow pkg={pkg} />
                </li>
              ))}
            </DataList>
          </section>
        );
      })}
    </div>
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
        <code className="pdpp-caption break-all font-medium font-mono text-foreground" title={pkg.package_id}>
          {pkg.package_id}
        </code>
        <div className="flex items-center gap-2">
          <StatusBadge status={pkg.status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          <span className="pdpp-caption text-muted-foreground">
            issued <IcTimestamp value={pkg.created_at} />
          </span>
        </div>
      </div>
      <div className="pdpp-caption mt-1 flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
        <span>{memberLabel}</span>
        <span aria-hidden>·</span>
        <LastUsed value={pkg.last_used_at} />
        <span aria-hidden>·</span>
        {pkg.client?.registration_mode ? <span>registration {pkg.client.registration_mode}</span> : null}
      </div>
    </Link>
  );
}
