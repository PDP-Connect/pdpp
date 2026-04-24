import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { MetaPill, PageHeader, Section } from "../../components/primitives.tsx";
import { DashboardShell } from "../../components/shell.tsx";
import {
  buildGrantRequestExamples,
  createDefaultGrantRequestDraft,
  getGrantRequestWorkspace,
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

type Params = {
  workspace?: string;
  error?: string;
};

export default async function GrantRequestPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const workspace = params.workspace ? getGrantRequestWorkspace(params.workspace) : null;
  const draft = workspace?.draft ?? createDefaultGrantRequestDraft();
  const examples = workspace ? await buildGrantRequestExamples(workspace) : null;
  const error = params.error ?? workspace?.lastError ?? null;
  const ownerLoginUrl = getOwnerLoginPath();

  return (
    <DashboardShell active="grants">
      <PageHeader
        title="Grant request workspace"
        description="Register a public client, stage a real PAR request with PDPP authorization details, then drive the resulting consent through the public approval path."
        breadcrumbs={[{ label: "Grants", href: "/dashboard/grants" }, { label: "Grant request" }]}
        actions={
          <>
            <Link
              href="/dashboard/grants#pending-approvals"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Pending approvals
            </Link>
            <Link href="/dashboard/grants/bootstrap" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Owner device flow
            </Link>
            <a href={ownerLoginUrl} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Owner access
            </a>
          </>
        }
        meta={
          <>
            <MetaPill
              label="workspace"
              value={workspace ? "active" : "not started"}
              tone={workspace ? "human" : "neutral"}
            />
            <MetaPill
              label="client"
              value={workspace?.registeredClient ? "registered" : "not registered"}
              tone={workspace?.registeredClient ? "protocol" : "neutral"}
            />
            <MetaPill
              label="PAR"
              value={workspace?.stagedRequest ? "staged" : "not staged"}
              tone={workspace?.stagedRequest ? "protocol" : "neutral"}
            />
          </>
        }
      />

      {error ? (
        <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
          <span className="font-medium text-destructive">Workspace error:</span> <span>{error}</span>
        </div>
      ) : null}

      <Section
        title="1. Draft request and register client"
        description="Fill out the PAR parameters, save the draft, then register the client against the AS."
      >
        <form className="space-y-4">
          <input type="hidden" name="workspace_id" value={workspace?.workspaceId ?? ""} />

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <FormField
              label="Initial access token"
              name="initial_access_token"
              defaultValue={draft.initialAccessToken}
            />
            <FormField label="Subject id" name="subject_id" defaultValue={draft.subjectId} />
            <FormField label="Client name" name="client_name" defaultValue={draft.clientName} />
            <FormField label="Client id" name="client_id" defaultValue={draft.clientId} />
            <FormField
              label="Client uri"
              name="client_uri"
              defaultValue={draft.clientUri}
              placeholder="https://client.example"
            />
            <FormField
              label="Redirect uri"
              name="redirect_uri"
              defaultValue={draft.redirectUri}
              placeholder="https://client.example/callback"
            />
            <FormField label="Connector id" name="connector_id" defaultValue={draft.connectorId} />
            <FormField label="Provider id" name="provider_id" defaultValue={draft.providerId} />
            <FormField label="Purpose code" name="purpose_code" defaultValue={draft.purposeCode} />
            <FormSelect
              label="Access mode"
              name="access_mode"
              defaultValue={draft.accessMode}
              options={[
                { value: "single_use", label: "single_use" },
                { value: "ongoing", label: "ongoing" },
              ]}
            />
            <FormField label="Retention" name="retention" defaultValue={draft.retention} />
            <FormField label="Stream name" name="stream_name" defaultValue={draft.streamName} />
            <FormField
              label="Fields (comma-separated)"
              name="fields"
              defaultValue={draft.fields}
              placeholder="id, name"
            />
            <FormField label="View" name="view" defaultValue={draft.view} />
            <label className="flex flex-col gap-1 md:col-span-2 xl:col-span-3">
              <span className="pdpp-eyebrow">Purpose description</span>
              <Textarea name="purpose_description" defaultValue={draft.purposeDescription} rows={3} />
            </label>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button formAction={saveGrantRequestDraftAction} type="submit" variant="outline" size="sm">
              Save draft
            </Button>
            <Button formAction={registerGrantRequestClientAction} type="submit" variant="outline" size="sm">
              <span className="font-mono">POST /oauth/register</span>
            </Button>
            <Button formAction={stageGrantRequestAction} type="submit" size="sm">
              <span className="font-mono">POST /oauth/par</span>
            </Button>
          </div>
        </form>
      </Section>

      <Section title="2. Workspace state">
        {workspace ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <DetailCard title="Workspace">
              <DetailRow label="id" value={<code className="break-all">{workspace.workspaceId}</code>} />
              <DetailRow label="created" value={<Timestamp value={workspace.createdAt} />} />
              <DetailRow label="updated" value={<Timestamp value={workspace.updatedAt} />} />
            </DetailCard>
            <DetailCard title="Registered client">
              {workspace.registeredClient ? (
                <CodeBlock>{JSON.stringify(workspace.registeredClient, null, 2)}</CodeBlock>
              ) : (
                <p className="pdpp-caption text-muted-foreground italic">No client registered in this workspace yet.</p>
              )}
            </DetailCard>
            <DetailCard title="Staged request">
              {workspace.stagedRequest ? (
                <div className="space-y-1.5">
                  <DetailRow
                    label="request uri"
                    value={<code className="break-all">{String(workspace.stagedRequest.request_uri ?? "—")}</code>}
                  />
                  <DetailRow
                    label="authorization"
                    value={
                      typeof workspace.stagedRequest.authorization_url === "string" ? (
                        <a
                          href={workspace.stagedRequest.authorization_url}
                          className="underline-offset-2 hover:underline"
                        >
                          {workspace.stagedRequest.authorization_url}
                        </a>
                      ) : (
                        "—"
                      )
                    }
                  />
                  <DetailRow label="request id" value={String(workspace.stagedRequest.request_id ?? "—")} />
                  <DetailRow label="trace" value={String(workspace.stagedRequest.reference_trace_id ?? "—")} />
                </div>
              ) : (
                <p className="pdpp-caption text-muted-foreground italic">No PAR request staged yet.</p>
              )}
            </DetailCard>
          </div>
        ) : (
          <p className="pdpp-caption text-muted-foreground">
            No workspace yet. Save a draft, register a client, or stage a request to start one.
          </p>
        )}
      </Section>

      {workspace?.stagedRequest ? (
        <Section
          title="3. Drive consent"
          description="Approve or deny the staged request via the public consent routes. In placeholder-owner-auth mode these direct buttons are disabled — use owner access instead."
        >
          <form className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="workspace_id" value={workspace.workspaceId} />
            <Button formAction={approveGrantRequestAction} type="submit" size="sm">
              <span className="font-mono">POST /consent/approve</span>
            </Button>
            <Button formAction={denyGrantRequestAction} type="submit" size="sm" variant="destructive">
              <span className="font-mono">POST /consent/deny</span>
            </Button>
            <Link
              href="/dashboard/grants#pending-approvals"
              className="pdpp-caption ml-2 text-muted-foreground underline-offset-2 hover:underline"
            >
              pending queue →
            </Link>
          </form>
          <p className="pdpp-caption mt-3 text-muted-foreground">
            These buttons only work in open local-dev approval mode. If placeholder owner auth is enabled, open the
            hosted consent page or sign in at{" "}
            <a href={ownerLoginUrl} className="underline-offset-2 hover:underline">
              owner access
            </a>{" "}
            first and approve there.
          </p>
        </Section>
      ) : null}

      {examples ? (
        <Section title="4. Equivalents" description="Copy these to reproduce the flow outside the dashboard.">
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
      ) : null}
    </DashboardShell>
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
    <label className="flex min-w-0 flex-col gap-1">
      <span className="pdpp-eyebrow">{label}</span>
      <Input type="text" name={name} defaultValue={defaultValue} placeholder={placeholder} />
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
    <label className="flex min-w-0 flex-col gap-1">
      <span className="pdpp-eyebrow">{label}</span>
      <Select name={name} defaultValue={defaultValue}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
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
