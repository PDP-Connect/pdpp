// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcInput } from "@pdpp/brand-react";
import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { getStaticSecretSetup, RefNotFoundError, type StaticSecretSetupField } from "../../../lib/ref-client.ts";
import { staticSecretFormContract } from "../../../lib/source-setup-form-contract.ts";
import { createStaticSecretConnectionAction, replaceStaticSecretCredentialAction } from "./actions.ts";

export const dynamic = "force-dynamic";

interface PageParams {
  connectorId: string;
}

interface PageSearchParams {
  // When present, the form is in "replace credential" mode for an existing
  // connection — preserves connection_id, history, schedule, and records.
  connectionId?: string;
  displayName?: string;
  draftRetry?: string;
  error?: string;
}

function InlineNotice({ message }: { message: string }) {
  return (
    <div className="pdpp-caption rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive">
      {message}
    </div>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function inputType(field: StaticSecretSetupField): "email" | "password" | "text" {
  return field.type === "email" || field.type === "password" ? field.type : "text";
}

function pageCopy(displayName: string, isDraftRetryMode: boolean, isReplaceMode: boolean) {
  if (isDraftRetryMode) {
    return {
      description:
        "Correct the provider details and submit again. This keeps the same pending connection and never reuses the rejected secret.",
      title: `Retry ${displayName}`,
    };
  }
  if (isReplaceMode) {
    return {
      description:
        "Enter the credential this connection should use. Records, history, and schedule stay attached to the same connection.",
      title: `Reconnect ${displayName}`,
    };
  }
  return {
    description:
      "Enter the provider credential to create this connection and start its first sync. The account keeps its own connection identity and credentials.",
    title: `Add ${displayName}`,
  };
}

function ModeCallout({ isDraftRetryMode, isReplaceMode }: { isDraftRetryMode: boolean; isReplaceMode: boolean }) {
  if (isDraftRetryMode) {
    return (
      <Callout
        className="mt-5"
        description="The failed validation did not create a credential. Your corrected non-secret details stay on this pending connection; enter the secret again to retry."
        surface="human"
        title="Retrying the same connection"
      />
    );
  }
  if (isReplaceMode) {
    return (
      <Callout
        className="mt-5"
        description="Reconnect uses the submitted credential for this connection. It does not change collected records, schedule, or history."
        surface="human"
        title="This keeps the same connection"
      />
    );
  }
  return (
    <Callout
      className="mt-5"
      description="Submit the form again for a second mailbox or account. Each submission creates a separate connection with its own stored credential."
      title="Add another account without changing deployment settings"
    >
      <p className="pdpp-caption text-muted-foreground">
        The deployment only needs an instance-level credential key provider. Account credentials are captured here for
        one connection at a time.
      </p>
    </Callout>
  );
}

export default async function StaticSecretConnectPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId: rawConnectorId } = await params;
  const connectorId = decodeURIComponent(rawConnectorId);
  const setup = await getStaticSecretSetup(connectorId).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });
  const resolvedSearchParams = await searchParams;
  const pageParams: PageSearchParams = {
    connectionId: firstValue(resolvedSearchParams.connection_id),
    displayName: firstValue(resolvedSearchParams.display_name),
    draftRetry: firstValue(resolvedSearchParams.draft_retry),
    error: firstValue(resolvedSearchParams.error),
  };
  // A draft retry keeps the same connection id but remains in the create-form
  // presentation so the owner can see and preserve the chosen display name.
  const isDraftRetryMode = Boolean(pageParams.connectionId && pageParams.draftRetry === "1");
  const isReplaceMode = Boolean(pageParams.connectionId && !isDraftRetryMode);
  const hasExistingTarget = Boolean(pageParams.connectionId);
  const readinessBlocked = setup.deployment_readiness.state !== "ready";
  const formContract = staticSecretFormContract(setup, hasExistingTarget);

  // After a validation failure the action redirects back here with the owner's
  // non-secret field values as `field_<name>` query params so the form context
  // is preserved. The secret field is never round-tripped — the owner re-enters
  // it. Connector-generic: the field names come from the manifest descriptor.
  function preservedValue(field: StaticSecretSetupField): string | undefined {
    if (field.secret) {
      return;
    }
    return firstValue(resolvedSearchParams[`field_${field.name}`]);
  }

  const { description: pageDescription, title: pageTitle } = pageCopy(
    setup.display_name,
    isDraftRetryMode,
    isReplaceMode
  );
  const backHref =
    isReplaceMode && pageParams.connectionId ? `/sources/${encodeURIComponent(pageParams.connectionId)}` : "/sources";

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={backHref}>
            Back to Sources
          </Link>
        }
        breadcrumbs={[{ href: "/sources", label: "Sources" }, { label: pageTitle }]}
        description={pageDescription}
        title={pageTitle}
      />

      <div className="mb-5 grid gap-2">{pageParams.error ? <InlineNotice message={pageParams.error} /> : null}</div>

      <Section description={formContract.credentialSectionDescription} title={setup.credential_capture.label}>
        {readinessBlocked ? (
          <Callout
            description={
              setup.deployment_readiness.guidance ??
              "Configure the instance-level credential key provider before entering a provider credential."
            }
            title="Credential storage is not ready"
            tone="warning"
          >
            <ul className="pdpp-caption mt-3 grid gap-1 text-muted-foreground">
              {setup.deployment_readiness.blockers.map((blocker) => (
                <li key={blocker.key}>
                  Set <code>{blocker.key}</code>
                </li>
              ))}
            </ul>
          </Callout>
        ) : (
          <form
            action={hasExistingTarget ? replaceStaticSecretCredentialAction : createStaticSecretConnectionAction}
            className="grid max-w-2xl gap-4 rounded-sm border border-border/80 bg-muted/20 p-4"
          >
            <input name="connector_id" type="hidden" value={setup.connector_id} />
            {hasExistingTarget && pageParams.connectionId ? (
              <input name="connection_id" type="hidden" value={pageParams.connectionId} />
            ) : null}
            {isReplaceMode ? null : (
              <label className="grid gap-1" htmlFor="static-secret-display-name">
                <span className="pdpp-eyebrow">{formContract.connectionName.label}</span>
                <IcInput
                  defaultValue={pageParams.displayName}
                  id="static-secret-display-name"
                  maxLength={formContract.connectionName.maxLength}
                  name={formContract.connectionName.name}
                  placeholder={formContract.connectionName.placeholder}
                  type="text"
                />
                <span className="pdpp-caption text-muted-foreground">{formContract.connectionName.helpText}</span>
              </label>
            )}
            {formContract.credentialFields.map((field) => (
              <label className="grid gap-1" htmlFor={`static-secret-${field.name}`} key={field.name}>
                <span className="pdpp-eyebrow">{field.label}</span>
                <IcInput
                  autoComplete={field.autocomplete ?? (field.secret ? "off" : undefined)}
                  defaultValue={preservedValue(field)}
                  id={`static-secret-${field.name}`}
                  name={field.name}
                  placeholder={field.placeholder ?? undefined}
                  // F2: native HTML validation must not block the block-level
                  // optional case. `setup.credential_capture.required ===
                  // false` (e.g. Venmo — BOTH-OR-NONE, blank is a valid,
                  // complete choice) makes every field's own `required`
                  // attribute non-binding at the browser level; the server
                  // (buildStaticSecretPayload / validateBundledSecret) is
                  // what actually enforces BOTH-OR-NONE once ANY field is
                  // filled. A REQUIRED capture (the default) is unaffected —
                  // each field's own `required` still gates the native form
                  // exactly as before.
                  required={setup.credential_capture.required !== false && field.required}
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
            {setup.validation === "synchronous" ? (
              <p className="pdpp-caption text-muted-foreground">
                The credential is checked with the provider when you submit. A valid one confirms the account and starts
                the first sync; otherwise you stay on this form with your details preserved.
              </p>
            ) : null}
            <div>
              <IcButton type="submit" variant="human">
                {formContract.primaryActionLabel}
              </IcButton>
            </div>
          </form>
        )}
      </Section>

      <ModeCallout isDraftRetryMode={isDraftRetryMode} isReplaceMode={isReplaceMode} />
    </RecordroomShellWithPalette>
  );
}
