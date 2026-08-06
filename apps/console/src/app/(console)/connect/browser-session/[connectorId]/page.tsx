// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-session connect/repair page.
 *
 * Entry point for browser-bound connector setup and re-authentication.
 *
 * SETUP (no ?connectionId): supported browser-collector connectors show a new
 * account form with an optional source label and a clear link back to Sources
 * for owners who need to reconnect an existing source. Unsupported
 * browser-bound connectors still fail closed on this route.
 *
 * REPAIR (?connectionId=<existing>): skips shell creation and starts a new run
 * against the existing connection (Plaid update-mode equivalent). The
 * connection_id, history, schedule, and records are unchanged.
 *
 * The page is deliberately minimal — setup mode presents a clear new-account
 * vs reconnect choice, and repair mode keeps the single primary CTA. The
 * browser interaction itself happens in the run stream page
 * (apps/console/src/app/(console)/syncs/[runId]/stream/).
 *
 * Design reference: docs/research/slvp-ideal-browser-device-connector-setup-2026-06-14.md §3B/3C
 */

import { buttonVariants, IcInput } from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { formatConnectorKeyForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { isBrowserBoundConnector, isSupportedBrowserCollectorConnector } from "../../../lib/connection-modality.ts";
import { getStaticSecretSetup, type StaticSecretSetup, type StaticSecretSetupField } from "../../../lib/ref-client.ts";

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

function inputType(field: StaticSecretSetupField): "email" | "password" | "text" {
  return field.type === "email" || field.type === "password" ? field.type : "text";
}

function OptionalStoredCredentialFields({
  searchParams,
  setup,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  setup: StaticSecretSetup;
}) {
  return (
    <fieldset
      className="grid gap-3 rounded-lg border border-border/70 bg-muted/20 p-4"
      data-testid="browser-optional-credentials"
    >
      <legend className="pdpp-eyebrow px-1 text-foreground">
        Remember my sign-in details for automatic reconnection (optional)
      </legend>
      <p className="pdpp-caption text-muted-foreground">
        These manifest-defined details are encrypted and may help with initial sign-in or repair. CAPTCHA, OTP,
        passkeys, and other human steps always stay in the secure browser; unattended reconnection is not guaranteed.
      </p>
      <label className="flex items-start gap-2" htmlFor="browser-remember-sign-in">
        <input
          className="mt-0.5 size-4 rounded border-border accent-primary"
          id="browser-remember-sign-in"
          name="remember_sign_in_details"
          type="checkbox"
          value="1"
        />
        <span className="pdpp-caption text-foreground">Save these details to assist future sign-in or repair.</span>
      </label>
      <div className="grid gap-3 border-border/60 border-t pt-3" data-testid="browser-credential-fields">
        {setup.credential_capture.fields.map((field) => (
          <label className="grid gap-1" htmlFor={`browser-credential-${field.name}`} key={field.name}>
            <span className="pdpp-eyebrow">{field.label}</span>
            <IcInput
              autoComplete={field.autocomplete ?? (field.secret ? "off" : undefined)}
              defaultValue={firstValue(searchParams[`field_${field.name}`])}
              id={`browser-credential-${field.name}`}
              name={field.name}
              placeholder={field.placeholder ?? undefined}
              required={false}
              type={inputType(field)}
            />
            {field.description || field.help_text || field.help_url ? (
              <span className="pdpp-caption text-muted-foreground">
                {field.description ?? field.help_text}
                {field.help_url ? (
                  <>
                    {" "}
                    <a
                      className="underline decoration-dotted underline-offset-4"
                      href={field.help_url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open provider setup page in a new tab
                    </a>
                  </>
                ) : null}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function UnavailableSetupCard({ displayName }: { displayName: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-5 shadow-sm">
      <h2 className="pdpp-title text-foreground">Adding a new {displayName} source is not available here</h2>
      <p className="pdpp-body mt-3 text-muted-foreground">
        Browser-backed sources need a packaged self-service flow before this route can create a new account. Open an
        existing source to reconnect it, or return to Add source to see what this dashboard can add now.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link className={buttonVariants({ size: "sm", variant: "default" })} href="/sources">
          Open sources
        </Link>
        <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources/add">
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
  const supportedBrowserCollector = isSupportedBrowserCollectorConnector(connectorId);
  const storedCredentialSetup = supportedBrowserCollector
    ? await getStaticSecretSetup(connectorId).catch(() => null)
    : null;
  const displayName = formatConnectorKeyForDisplay(connectorId);
  const pageTitle = repairMode ? `Reconnect ${displayName}` : `Connect ${displayName}`;
  const setupDescription = supportedBrowserCollector
    ? "Create a new account in a secure browser. You can optionally remember sign-in details for automatic reconnection and repair; human verification still happens in the browser."
    : `This dashboard can repair an existing ${displayName} source, but it will not create a new browser-backed source from this generic page.`;
  const setupPanel = supportedBrowserCollector ? (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/70 bg-card/60 p-5 shadow-sm">
        <h2 className="pdpp-title text-foreground">Create a new account</h2>
        <p className="pdpp-body mt-3 text-muted-foreground">
          Use this when you are connecting a fresh account. The label is optional and only helps you distinguish the
          source later.
        </p>
        <form action={`/connect/browser-session/${encodeURIComponent(connectorId)}/start`} method="post">
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1" htmlFor="browser-session-display-name">
              <span className="pdpp-eyebrow">Source label (optional)</span>
              <IcInput id="browser-session-display-name" name="display_name" placeholder={`${displayName} personal`} />
            </label>
            {storedCredentialSetup ? (
              <OptionalStoredCredentialFields searchParams={resolvedSearchParams} setup={storedCredentialSetup} />
            ) : null}
            <button
              className={buttonVariants({ className: "w-full justify-center", size: "lg", variant: "default" })}
              type="submit"
            >
              Connect account
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-md border border-border/70 bg-muted/20 p-4">
        <p className="pdpp-caption text-muted-foreground">
          Need to reconnect an existing source instead? Go back to Sources and open that source from the list.
        </p>
        <div className="mt-3">
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources">
            Choose an existing source
          </Link>
        </div>
      </div>
    </div>
  ) : (
    <UnavailableSetupCard displayName={displayName} />
  );

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources">
            Back to sources
          </Link>
        }
        breadcrumbs={[{ href: "/sources", label: "Sources" }, { label: pageTitle }]}
        description={
          repairMode
            ? `Log in to ${displayName} in the secure browser to restore collection. Your existing records and history are preserved.`
            : setupDescription
        }
        title={pageTitle}
      />

      <div className="mx-auto max-w-lg space-y-6 px-4 py-8">
        {pageParams.error ? <InlineError message={pageParams.error} /> : null}

        {repairMode ? null : setupPanel}

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
                would on your own machine. PDPP stores the browser session state needed for this source. Optional
                encrypted sign-in details may assist repair, but they do not replace the secure browser or guarantee
                unattended reconnection.
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
            {storedCredentialSetup ? (
              <OptionalStoredCredentialFields searchParams={resolvedSearchParams} setup={storedCredentialSetup} />
            ) : null}
            <button
              className={buttonVariants({ className: "w-full justify-center", size: "lg", variant: "default" })}
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
