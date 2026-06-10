import { Callout, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button.tsx";
import { DashboardShell } from "../../../../../components/shell.tsx";
import {
  getStaticSecretSetupStatus,
  RefNotFoundError,
  type StaticSecretSetupStatus,
} from "../../../../../lib/ref-client.ts";

// The setup-status surface re-renders on every navigation; force-dynamic so the
// owner always sees the current lifecycle state, not a cached pending snapshot.
export const dynamic = "force-dynamic";

interface PageParams {
  connectionId: string;
  connectorId: string;
}

interface PageSearchParams {
  identity?: string;
  run_id?: string;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Owner-facing copy per lifecycle state. Operator-voiced (this is the owner's
// own instance), no provider-specific branches: the connector display name and
// account identity come from the projected status.
function describeState(status: StaticSecretSetupStatus): { tone: "active" | "failed" | "pending"; headline: string; detail: string } {
  switch (status.setup_state) {
    case "active":
      return {
        tone: "active",
        headline: "Connection active",
        detail: "The first sync accepted records. This account is now a working connection.",
      };
    case "first_sync_running":
      return {
        tone: "pending",
        headline: "First sync running",
        detail: "The credential is captured and the first sync is in progress. This page updates as it finishes.",
      };
    case "first_sync_pending":
      return {
        tone: "pending",
        headline: "First sync starting",
        detail: "The credential is captured and the first sync is queued. This page updates as it runs.",
      };
    case "awaiting_credential":
      return {
        tone: "pending",
        headline: "Awaiting credential",
        detail: "This connection is set up but no provider credential is captured yet.",
      };
    case "first_sync_failed":
      return {
        tone: "failed",
        headline: "First sync failed",
        detail: status.last_error?.remediation ?? "Start the first sync again, or re-enter the provider credential.",
      };
    case "paused":
      return { tone: "pending", headline: "Connection paused", detail: "This connection is paused." };
    case "revoked":
      return { tone: "failed", headline: "Connection revoked", detail: "This connection has been revoked." };
    default:
      return {
        tone: "pending",
        headline: "Setting up",
        detail: "This connection is being set up. This page updates as the setup progresses.",
      };
  }
}

export default async function StaticSecretSetupStatusPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectionId: rawConnectionId, connectorId: rawConnectorId } = await params;
  const connectionId = decodeURIComponent(rawConnectionId);
  const connectorId = decodeURIComponent(rawConnectorId);
  const resolvedSearchParams = await searchParams;
  const pageParams: PageSearchParams = {
    identity: firstValue(resolvedSearchParams.identity),
    run_id: firstValue(resolvedSearchParams.run_id),
  };

  const status = await getStaticSecretSetupStatus(connectionId, pageParams.run_id ?? null).catch((err) => {
    if (err instanceof RefNotFoundError) {
      notFound();
    }
    throw err;
  });

  // Prefer the durable identity the projection derives from the connection's
  // non-secret setup fields (e.g. a mailbox address). Fall back to the
  // synchronous-probe echo passed at submit for connectors with no durable
  // identity field (e.g. an account login). Non-secret either way.
  const accountIdentity = status.account_identity ?? pageParams.identity ?? null;
  const described = describeState(status);
  const title = accountIdentity
    ? `${status.display_name ?? connectorId} · ${accountIdentity}`
    : (status.display_name ?? connectorId);

  return (
    <DashboardShell active="records">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/records">
            Back to Sources
          </Link>
        }
        breadcrumbs={[{ href: "/dashboard/records", label: "Sources" }, { label: "Setup status" }]}
        description="This is the durable status for the account you just submitted. Bookmark or revisit it any time."
        title={title}
      />

      <Section description={described.detail} title={described.headline}>
        <dl className="grid max-w-2xl gap-2 rounded-md border border-border/80 bg-muted/20 p-4">
          {accountIdentity ? (
            <div className="flex justify-between gap-4">
              <dt className="pdpp-caption text-muted-foreground">Connected as</dt>
              <dd className="pdpp-caption">{accountIdentity}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4">
            <dt className="pdpp-caption text-muted-foreground">Connection</dt>
            <dd className="pdpp-caption font-mono">{status.connection_id}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="pdpp-caption text-muted-foreground">Status</dt>
            <dd className="pdpp-caption">{status.status}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="pdpp-caption text-muted-foreground">Setup state</dt>
            <dd className="pdpp-caption">{status.setup_state}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="pdpp-caption text-muted-foreground">Credential</dt>
            <dd className="pdpp-caption">{status.credential.present ? "captured" : "not captured"}</dd>
          </div>
          {status.run?.run_id ? (
            <div className="flex justify-between gap-4">
              <dt className="pdpp-caption text-muted-foreground">Run</dt>
              <dd className="pdpp-caption">
                <Link
                  className="font-mono underline underline-offset-2 hover:text-foreground"
                  href={`/dashboard/runs/${encodeURIComponent(status.run.run_id)}`}
                >
                  {status.run.run_id}
                </Link>{" "}
                {status.run.status ? `(${status.run.status})` : null}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          {described.tone === "active" ? (
            <Link
              className={buttonVariants({ variant: "default", size: "sm" })}
              href={`/dashboard/records/${encodeURIComponent(connectorId)}`}
            >
              View records
            </Link>
          ) : null}
          {described.tone === "failed" || status.setup_state === "awaiting_credential" ? (
            <Link
              className={buttonVariants({ variant: "default", size: "sm" })}
              href={`/dashboard/connect/static-secret/${encodeURIComponent(connectorId)}`}
            >
              Re-enter credential and retry
            </Link>
          ) : null}
          {described.tone === "pending" && status.setup_state !== "awaiting_credential" ? (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`?${new URLSearchParams(pageParams.run_id ? { run_id: pageParams.run_id } : {}).toString()}`}>
              Refresh status
            </Link>
          ) : null}
        </div>
      </Section>

      {status.last_error ? (
        <Callout className="mt-5" description={status.last_error.remediation} surface="human" title="First sync failed">
          <p className="pdpp-caption text-muted-foreground">Reason: {status.last_error.reason}</p>
        </Callout>
      ) : null}
    </DashboardShell>
  );
}
