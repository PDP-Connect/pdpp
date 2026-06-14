/**
 * Operator detail surface for a single hosted-MCP grant package.
 *
 * Renders the package metadata, the full child-grant table (active and
 * revoked rows both shown so the operator can see the cascade after
 * revocation), and a server-action revoke form. Revocation is a
 * confirmed POST through `revokePackageAction`; the page itself never
 * calls `_ref/grant-packages/:id/revoke` directly. No secret material
 * is rendered.
 *
 * Spec: openspec/changes/add-grant-package-operator-visibility/
 *       specs/reference-implementation-architecture/spec.md
 */

import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { GRANT_LIFECYCLE_VOCABULARY } from "@pdpp/operator-ui/components/status-vocabularies";
import { formatSourceWithConnectionForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import { IcButton, RecordroomShell } from "@pdpp/brand-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Timestamp } from "@pdpp/operator-ui/ui/timestamp";
import { ServerUnreachable } from "../../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../../lib/owner-token.ts";
import {
  type CumulativeClientAccess,
  type GrantPackageChild,
  getCumulativeClientAccess,
  getGrantPackage,
} from "../../../lib/ref-client.ts";
import { revokePackageAction } from "./revoke-action.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Grant package",
};

interface DetailParams {
  revoke_error?: string;
  revoked?: string;
}

export default async function GrantPackageDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ packageId: string }>;
  searchParams: Promise<DetailParams>;
}) {
  const { packageId: raw } = await params;
  const packageId = decodeURIComponent(raw);
  const sp = await searchParams;

  let pkg: Awaited<ReturnType<typeof getGrantPackage>>;
  try {
    pkg = await getGrantPackage(packageId);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShell>
          <PageHeader title="Grant package" />
          <ServerUnreachable />
        </RecordroomShell>
      );
    }
    throw err;
  }

  if (!pkg) {
    notFound();
  }

  // Reference-experimental cumulative per-client view across the lineage this
  // package belongs to (linked by parent_package_id). Best-effort: a failure
  // here must not break the package detail page.
  let cumulative: CumulativeClientAccess | null = null;
  try {
    cumulative = await getCumulativeClientAccess(packageId);
  } catch {
    cumulative = null;
  }
  // Only render the lineage section when the package actually participates in a
  // multi-package lineage; a lone package needs no cumulative pivot.
  const hasLineage = cumulative !== null && (cumulative.package_count > 1 || pkg.parent_package_id !== null);

  const isActive = pkg.status === "active";
  const childCount = pkg.children.length;
  const subscriptionsHref = "/dashboard/event-subscriptions";

  return (
    <RecordroomShell>
      <div className="pdpp-caption mb-2 text-muted-foreground">
        <Link className="underline-offset-2 hover:underline" href="/dashboard/grants/packages">
          ← Grant packages
        </Link>
      </div>
      <PageHeader title="Grant package" />

      {sp.revoke_error ? (
        <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
          <span className="font-medium text-destructive">Revoke error:</span> <span>{sp.revoke_error}</span>
        </div>
      ) : null}

      {sp.revoked === "yes" ? (
        <div className="pdpp-caption mb-6 rounded-md border border-emerald-500/30 border-l-4 border-l-emerald-500/60 bg-emerald-500/5 px-4 py-2.5">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">Package revoked.</span>{" "}
          <span>Every child grant has been cascaded to revoked. The package's MCP refresh token is invalidated.</span>
        </div>
      ) : null}

      <Section title="Identity">
        <dl className="pdpp-caption grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-muted-foreground">
          <dt>Package id</dt>
          <dd className="break-all font-mono text-foreground">{pkg.package_id}</dd>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={pkg.status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          </dd>
          <dt>Client</dt>
          <dd className="break-all font-mono text-foreground">{pkg.client_id}</dd>
          {pkg.parent_package_id ? (
            <>
              <dt>Extends</dt>
              <dd className="break-all font-mono text-foreground">
                <Link
                  className="underline-offset-2 hover:underline"
                  href={`/dashboard/grants/packages/${encodeURIComponent(pkg.parent_package_id)}`}
                >
                  {pkg.parent_package_id}
                </Link>
              </dd>
            </>
          ) : null}
          <dt>Subject</dt>
          <dd className="break-all font-mono text-foreground">{pkg.subject_id}</dd>
          <dt>Created</dt>
          <dd>
            <Timestamp value={pkg.created_at} />
          </dd>
          {pkg.approved_at ? (
            <>
              <dt>Approved</dt>
              <dd>
                <Timestamp value={pkg.approved_at} />
              </dd>
            </>
          ) : null}
          {pkg.revoked_at ? (
            <>
              <dt>Revoked</dt>
              <dd>
                <Timestamp value={pkg.revoked_at} />
              </dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section
        description={childCount === 1 ? "1 source-bounded child grant." : `${childCount} source-bounded child grants.`}
        title="Children"
      >
        {childCount === 0 ? (
          <p className="pdpp-caption text-muted-foreground">No child grants on file.</p>
        ) : (
          <DataList>
            {pkg.children.map((child) => (
              <li key={child.grant_id}>
                <ChildRow child={child} />
              </li>
            ))}
          </DataList>
        )}
      </Section>

      {hasLineage && cumulative ? (
        <Section
          description={`Reference-experimental. This client holds ${cumulative.active_child_count} active child grant(s) across ${cumulative.package_count} linked package(s) (incremental add-source lineage). Each child grant remains independently revocable; the link carries no source authority.`}
          title="Cumulative client access"
        >
          <DataList>
            {cumulative.packages.map((member) => (
              <li key={member.package_id}>
                <Link
                  className="block px-3 py-2.5 transition-colors hover:bg-muted/40"
                  href={`/dashboard/grants/packages/${encodeURIComponent(member.package_id)}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="pdpp-caption break-all font-medium font-mono text-foreground">
                      {member.package_id}
                      {member.package_id === pkg.package_id ? " (this package)" : ""}
                      {member.package_id === cumulative.root_package_id ? " · root" : ""}
                    </code>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={member.status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
                      <span className="pdpp-caption text-muted-foreground">
                        {member.member_count === 1 ? "1 child" : `${member.member_count} children`}
                      </span>
                    </div>
                  </div>
                  {member.parent_package_id ? (
                    <div className="pdpp-caption mt-1 break-all text-muted-foreground">
                      extends {member.parent_package_id}
                    </div>
                  ) : null}
                </Link>
              </li>
            ))}
          </DataList>
        </Section>
      ) : null}

      <Section title="Related">
        <p className="pdpp-caption text-muted-foreground">
          <Link className="underline-offset-2 hover:underline" href={subscriptionsHref}>
            Event subscriptions across this deployment →
          </Link>
        </p>
      </Section>

      {isActive ? (
        <Section
          description="Revoking the package dispatches one revoke per active child grant and invalidates the package's MCP refresh token only after every child succeeds. If one child fails, the page reports which child did not revoke and leaves the package active."
          title="Revoke"
        >
          <form action={revokePackageAction} className="flex flex-wrap items-center gap-3">
            <input name="package_id" type="hidden" value={pkg.package_id} />
            <label className="pdpp-caption flex items-center gap-2 text-muted-foreground">
              <input name="confirm_revoke" type="checkbox" value="yes" />
              <span>
                Confirm revoke of package <code className="font-mono">{pkg.package_id}</code> and all {childCount} child
                grants.
              </span>
            </label>
            <IcButton type="submit" variant="destructive">
              Revoke package
            </IcButton>
          </form>
        </Section>
      ) : null}
    </RecordroomShell>
  );
}

function ChildRow({ child }: { child: GrantPackageChild }) {
  const grantHref = `/dashboard/grants/${encodeURIComponent(child.grant_id)}`;
  const sourceLabel = describeSource(child.source);
  const memberStatus = child.member_status === child.grant_status ? null : child.member_status;
  return (
    <Link className="block px-3 py-2.5 transition-colors hover:bg-muted/40" href={grantHref}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code className="pdpp-caption break-all font-medium font-mono text-foreground">{child.grant_id}</code>
        <div className="flex items-center gap-2">
          <StatusBadge status={child.grant_status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          {memberStatus ? (
            <StatusBadge status={`member · ${memberStatus}`} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          ) : null}
          <span className="pdpp-caption text-muted-foreground">
            <Timestamp value={child.added_at} />
          </span>
        </div>
      </div>
      <div className="pdpp-caption mt-1 text-muted-foreground">
        {sourceLabel}
        {child.revoked_at ? (
          <>
            {" · revoked "}
            <Timestamp value={child.revoked_at} />
          </>
        ) : null}
      </div>
    </Link>
  );
}

function describeSource(source: GrantPackageChild["source"]): string {
  if (!source) {
    return "source —";
  }
  return `source ${formatSourceWithConnectionForDisplay(source)}`;
}
