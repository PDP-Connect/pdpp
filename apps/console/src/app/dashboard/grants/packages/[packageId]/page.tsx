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
import { formatSourceWithConnectionForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DashboardShell, ServerUnreachable } from "../../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../../lib/owner-token.ts";
import { type GrantPackageChild, getGrantPackage } from "../../../lib/ref-client.ts";
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
        <DashboardShell active="grants">
          <PageHeader title="Grant package" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  if (!pkg) {
    notFound();
  }

  const isActive = pkg.status === "active";
  const childCount = pkg.children.length;
  const subscriptionsHref = "/dashboard/event-subscriptions";

  return (
    <DashboardShell active="grants">
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
            <StatusBadge status={pkg.status} />
          </dd>
          <dt>Client</dt>
          <dd className="break-all font-mono text-foreground">{pkg.client_id}</dd>
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

      <Section title="Related">
        <p className="pdpp-caption text-muted-foreground">
          <Link className="underline-offset-2 hover:underline" href={subscriptionsHref}>
            Event subscriptions across this deployment →
          </Link>
        </p>
      </Section>

      {isActive ? (
        <Section
          description="Revoking the package cascades to every active child grant in one storage transaction and invalidates the package's MCP refresh token. Individual child grants can still be revoked from their own detail pages without affecting siblings."
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
            <Button type="submit" variant="destructive">
              Revoke package
            </Button>
          </form>
        </Section>
      ) : null}
    </DashboardShell>
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
          <StatusBadge status={child.grant_status} />
          {memberStatus ? <StatusBadge status={`member · ${memberStatus}`} /> : null}
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
