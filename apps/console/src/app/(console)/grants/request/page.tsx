// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcInput, IcSelect, IcTimestamp } from "@pdpp/brand-react";
import { MetaPill, PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  buildGrantRequestExamples,
  type ConnectionPinOption,
  createDefaultGrantRequestDraft,
  getGrantRequestWorkspace,
  loadConnectionPinOptions,
} from "../../lib/operator-grant-request.ts";
import { getOwnerLoginPath } from "../../lib/owner-token.ts";
import {
  approveGrantRequestAction,
  denyGrantRequestAction,
  registerGrantRequestClientAction,
  saveGrantRequestDraftAction,
  stageGrantRequestAction,
} from "./actions.ts";

export const dynamic = "force-dynamic";

interface Params {
  error?: string;
  workspace?: string;
}

type Workspace = NonNullable<ReturnType<typeof getGrantRequestWorkspace>>;
type Draft = ReturnType<typeof createDefaultGrantRequestDraft>;
type Examples = NonNullable<Awaited<ReturnType<typeof buildGrantRequestExamples>>>;

function HeaderActions({ ownerLoginUrl }: { ownerLoginUrl: string }) {
  return (
    <>
      <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/grants#pending-approvals">
        Pending approvals
      </Link>
      <a className={buttonVariants({ variant: "ghost", size: "sm" })} href={ownerLoginUrl}>
        Owner access
      </a>
    </>
  );
}

function HeaderMeta({ workspace }: { workspace: Workspace | null }) {
  return (
    <>
      <MetaPill label="workspace" tone={workspace ? "human" : "neutral"} value={workspace ? "active" : "not started"} />
      <MetaPill
        label="client"
        tone={workspace?.registeredClient ? "protocol" : "neutral"}
        value={workspace?.registeredClient ? "registered" : "not registered"}
      />
      <MetaPill
        label="PAR"
        tone={workspace?.stagedRequest ? "protocol" : "neutral"}
        value={workspace?.stagedRequest ? "staged" : "not staged"}
      />
    </>
  );
}

function WorkspaceError({ message }: { message: string }) {
  return (
    <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
      <span className="font-medium text-destructive">Workspace error:</span> <span>{message}</span>
    </div>
  );
}

const ACCESS_MODE_OPTIONS = [
  { value: "single_use", label: "single_use" },
  { value: "ongoing", label: "ongoing" },
];

function DraftFormFields({ connectionOptions, draft }: { connectionOptions: ConnectionPinOption[]; draft: Draft }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <FormField defaultValue={draft.initialAccessToken} label="Initial access token" name="initial_access_token" />
      <FormField defaultValue={draft.subjectId} label="Subject id" name="subject_id" />
      <FormField defaultValue={draft.clientName} label="Client name" name="client_name" />
      <FormField defaultValue={draft.clientId} label="Client id" name="client_id" />
      <FormField
        defaultValue={draft.clientUri}
        label="Client uri"
        name="client_uri"
        placeholder="https://client.example"
      />
      <FormField
        defaultValue={draft.redirectUri}
        label="Redirect uri"
        name="redirect_uri"
        placeholder="https://client.example/callback"
      />
      <label className="flex min-w-0 flex-col gap-1" htmlFor="grant-request-source_kind">
        <span className="pdpp-caption font-medium text-muted-foreground">Source kind</span>
        <IcSelect
          defaultValue={draft.sourceKind}
          id="grant-request-source_kind"
          name="source_kind"
          options={[
            { label: "connector", value: "connector" },
            { label: "provider_native", value: "provider_native" },
          ]}
        />
      </label>
      <FormField defaultValue={draft.sourceId} label="Source id" name="source_id" />
      <FormField defaultValue={draft.purposeCode} label="Purpose code" name="purpose_code" />
      <FormSelect
        defaultValue={draft.accessMode}
        label="Access mode"
        name="access_mode"
        options={ACCESS_MODE_OPTIONS}
      />
      <FormField defaultValue={draft.retention} label="Retention" name="retention" />
      <FormField defaultValue={draft.streamName} label="Stream name" name="stream_name" />
      <ConnectionPinField connectionOptions={connectionOptions} draft={draft} />
      <FormField defaultValue={draft.fields} label="Fields (comma-separated)" name="fields" placeholder="id, name" />
      <FormField defaultValue={draft.view} label="View" name="view" />
      <label className="flex flex-col gap-1 md:col-span-2 xl:col-span-3" htmlFor="grant-request-purpose-description">
        <span className="pdpp-caption font-medium text-muted-foreground">Purpose description</span>
        <textarea
          className="pdpp-input"
          defaultValue={draft.purposeDescription}
          id="grant-request-purpose-description"
          name="purpose_description"
          rows={3}
        />
      </label>
    </div>
  );
}

const FAN_IN_OPTION_VALUE = "";
const FAN_IN_OPTION_LABEL = "All connections (fan-in)";

/**
 * Per-connection pin for the addressed stream. The default option is an
 * explicit "All connections (fan-in)" — never a silent fan-in and never a
 * silent pin. When the source is a connector with more than one active
 * connection, the owner may pin one; the chosen `connection_id` rides on
 * `streams[].connection_id` (an existing grant field the read path enforces).
 *
 * For a single-connection or provider-native source there is nothing to
 * disambiguate, so the control collapses to a static "fan-in" note and posts
 * the empty (fan-in) value — preserving the prior single-connection shape.
 */
function ConnectionPinField({ connectionOptions, draft }: { connectionOptions: ConnectionPinOption[]; draft: Draft }) {
  if (connectionOptions.length <= 1) {
    return (
      <label className="flex min-w-0 flex-col gap-1" htmlFor="grant-request-connection_id">
        <span className="pdpp-caption font-medium text-muted-foreground">Connection</span>
        <input name="connection_id" type="hidden" value={FAN_IN_OPTION_VALUE} />
        <span
          className="pdpp-caption rounded-md border border-border/80 border-dashed bg-muted/20 px-3 py-2 text-muted-foreground"
          data-testid="connection-pin-fan-in-only"
          id="grant-request-connection_id"
        >
          {connectionOptions.length === 1 ? "One connection — reads cover it (fan-in)." : "All connections (fan-in)."}
        </span>
      </label>
    );
  }
  return (
    <label className="flex min-w-0 flex-col gap-1" htmlFor="grant-request-connection_id">
      <span className="pdpp-caption font-medium text-muted-foreground">Connection</span>
      <IcSelect
        defaultValue={draft.connectionId}
        id="grant-request-connection_id"
        name="connection_id"
        options={[{ label: FAN_IN_OPTION_LABEL, value: FAN_IN_OPTION_VALUE }, ...connectionOptions]}
      />
      <span className="pdpp-caption text-muted-foreground">
        Pin to one connection, or fan in across all the grant authorizes.
      </span>
    </label>
  );
}

function DraftFormActions() {
  return (
    /* P1: mobile — wrap actions, left-align on narrow screens */
    <div className="flex flex-wrap items-center gap-2 border-border/70 border-t pt-3 sm:justify-end">
      <IcButton formAction={saveGrantRequestDraftAction} size="sm" type="submit" variant="ghost">
        Save draft
      </IcButton>
      <IcButton formAction={registerGrantRequestClientAction} size="sm" type="submit" variant="ghost">
        <span className="font-mono">POST /oauth/register</span>
      </IcButton>
      <IcButton formAction={stageGrantRequestAction} size="sm" type="submit">
        <span className="font-mono">POST /oauth/par</span>
      </IcButton>
    </div>
  );
}

function DraftSection({
  connectionOptions,
  draft,
  workspace,
}: {
  connectionOptions: ConnectionPinOption[];
  draft: Draft;
  workspace: Workspace | null;
}) {
  return (
    <Section
      description="Fill out the PAR parameters, save the draft, then register the client against the AS."
      title="1. Draft request and register client"
    >
      <form className="space-y-4">
        <input name="workspace_id" type="hidden" value={workspace?.workspaceId ?? ""} />
        <DraftFormFields connectionOptions={connectionOptions} draft={draft} />
        <DraftFormActions />
      </form>
    </Section>
  );
}

function StagedRequestAuthorizationLink({ url }: { url: unknown }) {
  if (typeof url !== "string") {
    return <>—</>;
  }
  return (
    <a className="underline-offset-2 hover:underline" href={url}>
      {url}
    </a>
  );
}

function StagedRequestCard({ staged }: { staged: NonNullable<Workspace["stagedRequest"]> }) {
  return (
    <DetailCard title="Staged request">
      <div className="space-y-1.5">
        <DetailRow label="request uri" value={<code className="break-all">{String(staged.request_uri ?? "—")}</code>} />
        <DetailRow label="authorization" value={<StagedRequestAuthorizationLink url={staged.authorization_url} />} />
        <DetailRow label="request id" value={String(staged.request_id ?? "—")} />
        <DetailRow label="trace" value={String(staged.reference_trace_id ?? "—")} />
      </div>
    </DetailCard>
  );
}

function WorkspaceStateSection({ workspace }: { workspace: Workspace | null }) {
  return (
    <Section title="2. Workspace state">
      {workspace ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <DetailCard title="Workspace">
            <DetailRow label="id" value={<code className="break-all">{workspace.workspaceId}</code>} />
            <DetailRow label="created" value={<IcTimestamp value={workspace.createdAt} />} />
            <DetailRow label="updated" value={<IcTimestamp value={workspace.updatedAt} />} />
          </DetailCard>
          <DetailCard title="Registered client">
            {workspace.registeredClient ? (
              <CodeBlock>{JSON.stringify(workspace.registeredClient, null, 2)}</CodeBlock>
            ) : (
              <p className="pdpp-caption text-muted-foreground italic">No client registered in this workspace yet.</p>
            )}
          </DetailCard>
          {workspace.stagedRequest ? (
            <StagedRequestCard staged={workspace.stagedRequest} />
          ) : (
            <DetailCard title="Staged request">
              <p className="pdpp-caption text-muted-foreground italic">No PAR request staged yet.</p>
            </DetailCard>
          )}
        </div>
      ) : (
        <p className="pdpp-caption text-muted-foreground">
          No workspace yet. Save a draft, register a client, or stage a request to start one.
        </p>
      )}
    </Section>
  );
}

function DriveConsentSection({ ownerLoginUrl, workspace }: { ownerLoginUrl: string; workspace: Workspace }) {
  return (
    <Section
      description="Approve or deny the staged request via the public consent routes. In placeholder-owner-auth mode these direct buttons are disabled — use owner access instead."
      title="3. Drive consent"
    >
      <form className="flex flex-wrap items-center gap-2">
        <input name="workspace_id" type="hidden" value={workspace.workspaceId} />
        <IcButton formAction={approveGrantRequestAction} size="sm" type="submit">
          <span className="font-mono">POST /consent/approve</span>
        </IcButton>
        <IcButton formAction={denyGrantRequestAction} size="sm" type="submit" variant="destructive">
          <span className="font-mono">POST /consent/deny</span>
        </IcButton>
        <Link
          className="pdpp-caption ml-2 text-muted-foreground underline-offset-2 hover:underline"
          href="/grants#pending-approvals"
        >
          pending queue →
        </Link>
      </form>
      <p className="pdpp-caption mt-3 text-muted-foreground">
        These buttons only work in open local-dev approval mode. If placeholder owner auth is enabled, open the hosted
        consent page or sign in at{" "}
        <a className="underline-offset-2 hover:underline" href={ownerLoginUrl}>
          owner access
        </a>{" "}
        first and approve there.
      </p>
    </Section>
  );
}

function EquivalentsSection({ examples }: { examples: Examples }) {
  return (
    <Section description="Copy these to reproduce the flow outside the dashboard." title="4. Equivalents">
      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <h3 className="pdpp-eyebrow mb-2">Register client</h3>
          <CodeBlock>{examples.registerCurl}</CodeBlock>
        </div>
        <div>
          <h3 className="pdpp-eyebrow mb-2">Stage request</h3>
          <CodeBlock>{examples.stageCurl}</CodeBlock>
        </div>
      </div>
    </Section>
  );
}

export default async function GrantRequestPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const workspace = params.workspace ? getGrantRequestWorkspace(params.workspace) : null;
  const draft = workspace?.draft ?? createDefaultGrantRequestDraft();
  const examples = workspace ? await buildGrantRequestExamples(workspace) : null;
  const connectionOptions = await loadConnectionPinOptions(draft);
  const error = params.error ?? workspace?.lastError ?? null;
  const ownerLoginUrl = getOwnerLoginPath();

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={<HeaderActions ownerLoginUrl={ownerLoginUrl} />}
        breadcrumbs={[{ label: "Grants", href: "/grants" }, { label: "Grant request" }]}
        description="Register a public client, stage a real PAR request with PDPP authorization details, then drive the resulting consent through the public approval path."
        meta={<HeaderMeta workspace={workspace} />}
        title="Grant request workspace"
      />

      {error ? <WorkspaceError message={error} /> : null}

      <DraftSection connectionOptions={connectionOptions} draft={draft} workspace={workspace} />
      <WorkspaceStateSection workspace={workspace} />
      {workspace?.stagedRequest ? <DriveConsentSection ownerLoginUrl={ownerLoginUrl} workspace={workspace} /> : null}
      {examples ? <EquivalentsSection examples={examples} /> : null}
    </RecordroomShellWithPalette>
  );
}

function FormField({
  label,
  name,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    // P1: use pdpp-caption label (sentence case, less noisy than all-caps eyebrow)
    <label className="flex min-w-0 flex-col gap-1" htmlFor={`grant-request-${name}`}>
      <span className="pdpp-caption font-medium text-muted-foreground">{label}</span>
      <IcInput
        defaultValue={defaultValue}
        id={`grant-request-${name}`}
        name={name}
        placeholder={placeholder}
        type="text"
      />
    </label>
  );
}

function FormSelect({
  label,
  name,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1" htmlFor={`grant-request-${name}`}>
      <span className="pdpp-caption font-medium text-muted-foreground">{label}</span>
      <IcSelect defaultValue={defaultValue} id={`grant-request-${name}`} name={name} options={options} />
    </label>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/80 bg-muted/20 p-3">
      <h3 className="pdpp-eyebrow mb-2">{title}</h3>
      {children}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="pdpp-caption grid gap-0.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:items-baseline sm:gap-2">
      <span className="pdpp-caption text-muted-foreground">{label}</span>
      <div className="min-w-0 break-words">{value}</div>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="pdpp-caption overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border/80 bg-muted/30 p-3 font-mono">
      <code>{children}</code>
    </pre>
  );
}
