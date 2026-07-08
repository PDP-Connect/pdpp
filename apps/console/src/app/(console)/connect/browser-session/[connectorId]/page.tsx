/**
 * Browser-session connect/repair page.
 *
 * Entry point for browser-bound connector setup and re-authentication.
 *
 * SETUP (no ?connectionId): intentionally unavailable from this generic route.
 * Browser-backed add-new is not packaged safely enough to mint a new source
 * without an explicit owner choice, label, and add-another/account context.
 * Direct visits therefore show honest guidance instead of creating a silent
 * unnamed connection.
 *
 * REPAIR (?connectionId=<existing>): skips shell creation and starts a new run
 * against the existing connection (Plaid update-mode equivalent). The
 * connection_id, history, schedule, and records are unchanged.
 *
 * The page is deliberately minimal — it explains what is about to happen and
 * has one primary CTA. The browser interaction itself happens in the run stream
 * page (apps/console/src/app/(console)/syncs/[runId]/stream/).
 *
 * Design reference: docs/research/slvp-ideal-browser-device-connector-setup-2026-06-14.md §3B/3C
 */

import { buttonVariants } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { formatConnectorKeyForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { isBrowserBoundConnector } from "../../../lib/connection-modality.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

interface PageSearchParams {
  /** Repair mode: existing connection_id to re-authenticate (Plaid update-mode). */
  connectionId?: string;
  /** Error from a prior start attempt. */
  error?: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive">
      {message}
    </div>
  );
}

function UnavailableSetupCard({ displayName }: { displayName: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-5 shadow-sm">
      <h2 className="pdpp-title text-foreground">Adding a new {displayName} source is not packaged here yet</h2>
      <p className="pdpp-body mt-3 text-muted-foreground">
        Browser-backed sources need an explicit add-another flow so PDPP does not create an unnamed duplicate account by
        accident. Open an existing source to reconnect it, or return to Add source to see what this dashboard can add
        now.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link className={buttonVariants({ variant: "default", size: "sm" })} href="/sources">
          Open sources
        </Link>
        <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/sources/add">
          Add source
        </Link>
      </div>
    </div>
  );
}

export default async function BrowserSessionConnectPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);

  // Only browser-bound connectors belong here.
  if (!isBrowserBoundConnector(connectorId)) {
    notFound();
  }

  const resolvedSearchParams = await searchParams;
  const pageParams: PageSearchParams = {
    connectionId: firstValue(resolvedSearchParams.connectionId),
    error: firstValue(resolvedSearchParams.error),
  };

  const repairMode = Boolean(pageParams.connectionId);
  const displayName = formatConnectorKeyForDisplay(connectorId);
  const pageTitle = repairMode ? `Reconnect ${displayName}` : `Connect ${displayName}`;

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/sources">
            Back to sources
          </Link>
        }
        breadcrumbs={[{ href: "/sources", label: "Sources" }, { label: pageTitle }]}
        description={
          repairMode
            ? `Log in to ${displayName} in the secure browser to restore collection. Your existing records and history are preserved.`
            : `This dashboard can repair an existing ${displayName} source, but it will not create a new browser-backed source from this generic page.`
        }
        title={pageTitle}
      />

      <div className="mx-auto max-w-lg space-y-6 px-4 py-8">
        {pageParams.error ? <InlineError message={pageParams.error} /> : null}

        {repairMode ? null : <UnavailableSetupCard displayName={displayName} />}

        {/* How it works */}
        {repairMode ? (
          <div className="rounded-xl border border-border/70 bg-card/60 p-5 shadow-sm">
            <h2 className="pdpp-title text-foreground">How this works</h2>
            <ol className="pdpp-body mt-3 list-inside list-decimal space-y-2 text-muted-foreground">
              <li>
                Click <strong className="text-foreground">Start session</strong> below. PDPP opens a secure browser
                panel.
              </li>
              <li>
                Log in to <strong className="text-foreground">{displayName}</strong> in that browser, exactly as you
                would on your own machine. PDPP stores the browser session state needed for this source; it does not
                store the password you type into the provider page.
              </li>
              <li>Once login is detected, the browser closes and collection resumes automatically.</li>
            </ol>

            {pageParams.connectionId ? (
              <p className="pdpp-caption mt-4 text-muted-foreground">
                Re-authenticating connection{" "}
                <code className="font-mono text-foreground/80">{pageParams.connectionId}</code>. Your existing records
                and history are unchanged.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Primary CTA */}
        {repairMode ? (
          <form action={`/connect/browser-session/${encodeURIComponent(connectorId)}/start`} method="post">
            {pageParams.connectionId ? (
              <input name="connection_id" type="hidden" value={pageParams.connectionId} />
            ) : null}
            <button
              className={buttonVariants({ variant: "default", size: "lg", className: "w-full justify-center" })}
              type="submit"
            >
              Reconnect {displayName}
            </button>
          </form>
        ) : null}

        {/* Fallback guidance for when the browser panel cannot start. */}
        <div className="rounded-md border border-border/50 bg-muted/20 px-4 py-3">
          <p className="pdpp-caption text-muted-foreground">
            <strong className="text-foreground">Browser not launching?</strong> Try again, or return to Sources and
            retry from this source. If PDPP cannot start the secure browser, it will show the reason before any data is
            changed.
          </p>
        </div>
      </div>
    </RecordroomShellWithPalette>
  );
}
