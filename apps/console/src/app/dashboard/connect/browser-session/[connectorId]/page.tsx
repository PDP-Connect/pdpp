/**
 * Browser-session connect/repair page.
 *
 * Entry point for browser-bound connector setup and re-authentication.
 *
 * SETUP (no ?connectionId): creates a fresh browser-enrollment shell
 * (POST /_ref/connectors/:connectorId/browser-enrollment-shell), starts a
 * bounded enrollment run, and redirects the owner to the run's stream page
 * where the embedded neko browser surface lets them log into the provider.
 * Once login is captured the shell transitions to active and collection begins.
 *
 * REPAIR (?connectionId=<existing>): skips shell creation and starts a new run
 * against the existing connection (Plaid update-mode equivalent). The
 * connection_id, history, schedule, and records are unchanged.
 *
 * The page is deliberately minimal — it explains what is about to happen and
 * has one primary CTA. The browser interaction itself happens in the run stream
 * page (apps/console/src/app/dashboard/runs/[runId]/stream/), which already
 * handles neko-embedded login for assisted-refresh runs.
 *
 * Neko availability: if neko is not deployed the enrollment run will surface a
 * "Waiting for a browser surface" error on the stream page. The runbook link
 * on this page gives the owner a fallback so they are never left at a dead end.
 *
 * Design reference: docs/research/slvp-ideal-browser-device-connector-setup-2026-06-14.md §3B/3C
 */

import { buttonVariants } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { formatConnectorKeyForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { BROWSER_BOUND_RUNBOOK_PATH, isBrowserBoundConnector } from "../../../lib/connection-modality.ts";
import { startBrowserEnrollmentAction } from "./actions.ts";

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
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/records">
            Back to sources
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard/records", label: "Sources" }, { label: pageTitle }]}
        description={
          repairMode
            ? `Log in to ${displayName} in the hosted browser below to restore collection. Your existing records and history are preserved.`
            : `Log in to ${displayName} in the hosted browser below. Once your session is captured, collection begins automatically.`
        }
        title={pageTitle}
      />

      <div className="mx-auto max-w-lg space-y-6 px-4 py-8">
        {pageParams.error ? <InlineError message={pageParams.error} /> : null}

        {/* How it works */}
        <div className="rounded-xl border border-border/70 bg-card/60 p-5 shadow-sm">
          <h2 className="pdpp-title text-foreground">How this works</h2>
          <ol className="pdpp-body mt-3 list-inside list-decimal space-y-2 text-muted-foreground">
            <li>
              Click <strong className="text-foreground">Start session</strong> below. A hosted Chromium browser opens in
              a new panel.
            </li>
            <li>
              Log in to <strong className="text-foreground">{displayName}</strong> in that browser, exactly as you would
              on your own machine. PDPP captures the session cookie — no credentials are stored.
            </li>
            <li>
              Once login is detected, the browser closes and collection {repairMode ? "resumes" : "begins"}{" "}
              automatically.
            </li>
          </ol>

          {repairMode && pageParams.connectionId ? (
            <p className="pdpp-caption mt-4 text-muted-foreground">
              Re-authenticating connection{" "}
              <code className="font-mono text-foreground/80">{pageParams.connectionId}</code>. Your existing records and
              history are unchanged.
            </p>
          ) : null}
        </div>

        {/* Primary CTA */}
        <form action={startBrowserEnrollmentAction}>
          <input name="connector_id" type="hidden" value={connectorId} />
          {pageParams.connectionId ? (
            <input name="connection_id" type="hidden" value={pageParams.connectionId} />
          ) : null}
          <button
            className="w-full rounded-full bg-foreground px-6 py-3 font-medium text-background text-sm transition-opacity hover:opacity-90 active:opacity-75"
            type="submit"
          >
            {repairMode ? `Reconnect ${displayName}` : `Start session — log in to ${displayName}`}
          </button>
        </form>

        {/* Fallback: runbook for when neko surface isn't available */}
        <div className="rounded-md border border-border/50 bg-muted/20 px-4 py-3">
          <p className="pdpp-caption text-muted-foreground">
            <strong className="text-foreground">Browser not launching?</strong> The hosted browser requires the neko
            surface service to be running. If the session panel shows "Waiting for a browser surface", follow the{" "}
            browser-collector runbook at <code className="font-mono text-foreground">{BROWSER_BOUND_RUNBOOK_PATH}</code>{" "}
            to run the collector locally instead. Your data is not lost either way.
          </p>
        </div>
      </div>
    </RecordroomShellWithPalette>
  );
}
