import Link from 'next/link';
import {
  DashboardMetaPill,
  DashboardPageHeader,
  DashboardSectionCard,
} from '../../components/primitives';
import {
  DashboardShell,
} from '../../components/shell';
import {
  buildGrantRequestExamples,
  createDefaultGrantRequestDraft,
  getGrantRequestWorkspace,
} from '../../lib/operator-grant-request';
import {
  getOwnerLoginPath,
  toReferencePublicUrl,
} from '../../lib/owner-token';
import {
  approveGrantRequestAction,
  denyGrantRequestAction,
  registerGrantRequestClientAction,
  saveGrantRequestDraftAction,
  stageGrantRequestAction,
} from './actions';

export const dynamic = 'force-dynamic';

type Params = {
  workspace?: string;
  error?: string;
};

export default async function GrantRequestPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const workspace = params.workspace ? getGrantRequestWorkspace(params.workspace) : null;
  const draft = workspace?.draft ?? createDefaultGrantRequestDraft();
  const examples = workspace ? await buildGrantRequestExamples(workspace) : null;
  const error = params.error ?? workspace?.lastError ?? null;
  const ownerLoginPath = getOwnerLoginPath();
  const authorizationUrl =
    typeof workspace?.stagedRequest?.authorization_url === 'string'
      ? await toReferencePublicUrl(workspace.stagedRequest.authorization_url)
      : null;

  return (
    <DashboardShell active="grants">
      <DashboardPageHeader
        title="Grant request workspace"
        description="Register a public client, stage a real PAR request with PDPP authorization details, then drive the resulting consent through the public approval path."
        breadcrumbs={[
          { label: 'Grants', href: '/dashboard/grants' },
          { label: 'Grant request workspace' },
        ]}
        actions={
          <>
            <Link
              href="/dashboard/grants#pending-approvals"
              className="border-border hover:bg-muted/50 rounded-xl border px-2.5 py-1.5"
            >
              pending approvals →
            </Link>
            <Link
              href="/dashboard/grants/bootstrap"
              className="border-border hover:bg-muted/50 rounded-xl border px-2.5 py-1.5"
            >
              owner device flow →
            </Link>
            <Link
              href={ownerLoginPath}
              className="border-border hover:bg-muted/50 rounded-xl border px-2.5 py-1.5"
            >
              owner access →
            </Link>
          </>
        }
        meta={
          <>
            <DashboardMetaPill
              label="workspace"
              value={workspace ? 'active' : 'not started'}
              tone="human"
            />
            <DashboardMetaPill
              label="client"
              value={workspace?.registeredClient ? 'registered' : 'not registered'}
              tone={workspace?.registeredClient ? 'protocol' : 'neutral'}
            />
            <DashboardMetaPill
              label="PAR"
              value={workspace?.stagedRequest ? 'staged' : 'not staged'}
              tone={workspace?.stagedRequest ? 'protocol' : 'neutral'}
            />
          </>
        }
        surface="human"
      />

      {error ? (
        <div className="border-destructive/40 bg-destructive/5 mb-6 rounded-2xl border px-4 py-3 text-xs">
          <span className="text-destructive font-medium">Workspace error:</span>{' '}
          <span>{error}</span>
        </div>
      ) : null}

      <section className="mb-6 grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card title="1. Draft + register client">
          <form className="space-y-4">
            <input type="hidden" name="workspace_id" value={workspace?.workspaceId ?? ''} />

            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                initial access token
                <input
                  type="text"
                  name="initial_access_token"
                  defaultValue={draft.initialAccessToken}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                subject id
                <input
                  type="text"
                  name="subject_id"
                  defaultValue={draft.subjectId}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                client name
                <input
                  type="text"
                  name="client_name"
                  defaultValue={draft.clientName}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                client id
                <input
                  type="text"
                  name="client_id"
                  defaultValue={draft.clientId}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                client uri
                <input
                  type="text"
                  name="client_uri"
                  defaultValue={draft.clientUri}
                  placeholder="https://client.example"
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                redirect uri
                <input
                  type="text"
                  name="redirect_uri"
                  defaultValue={draft.redirectUri}
                  placeholder="https://client.example/callback"
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                connector id
                <input
                  type="text"
                  name="connector_id"
                  defaultValue={draft.connectorId}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                provider id
                <input
                  type="text"
                  name="provider_id"
                  defaultValue={draft.providerId}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                purpose code
                <input
                  type="text"
                  name="purpose_code"
                  defaultValue={draft.purposeCode}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                access mode
                <select
                  name="access_mode"
                  defaultValue={draft.accessMode}
                  className="border-border bg-background rounded border px-3 py-2"
                >
                  <option value="single_use">single_use</option>
                  <option value="ongoing">ongoing</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                retention
                <input
                  type="text"
                  name="retention"
                  defaultValue={draft.retention}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                stream name
                <input
                  type="text"
                  name="stream_name"
                  defaultValue={draft.streamName}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="md:col-span-2 flex flex-col gap-1 text-xs">
                purpose description
                <textarea
                  name="purpose_description"
                  defaultValue={draft.purposeDescription}
                  rows={3}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                fields (comma-separated)
                <input
                  type="text"
                  name="fields"
                  defaultValue={draft.fields}
                  placeholder="id, name"
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                view
                <input
                  type="text"
                  name="view"
                  defaultValue={draft.view}
                  className="border-border bg-background rounded border px-3 py-2"
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                formAction={saveGrantRequestDraftAction}
                type="submit"
                className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
              >
                save draft
              </button>
              <button
                formAction={registerGrantRequestClientAction}
                type="submit"
                className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
              >
                register via `/oauth/register`
              </button>
              <button
                formAction={stageGrantRequestAction}
                type="submit"
                className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
              >
                stage via `/oauth/par`
              </button>
            </div>
          </form>
        </Card>

        <Card title="Current workspace state">
          {workspace ? (
            <div className="space-y-2 text-xs">
              <DetailRow label="workspace id" value={<code className="break-all">{workspace.workspaceId}</code>} />
              <DetailRow label="created" value={workspace.createdAt} />
              <DetailRow label="updated" value={workspace.updatedAt} />
              <DetailRow
                label="client"
                value={
                  typeof workspace.registeredClient?.client_id === 'string'
                    ? <code className="break-all">{workspace.registeredClient.client_id}</code>
                    : draft.clientId || '—'
                }
              />
              <DetailRow
                label="request"
                value={
                  typeof workspace.stagedRequest?.request_uri === 'string'
                    ? <code className="break-all">{workspace.stagedRequest.request_uri}</code>
                    : '—'
                }
              />
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              No workspace yet. Save a draft, register a client, or stage a request to start one.
            </p>
          )}
        </Card>
      </section>

      <section className="mb-6 grid gap-3 xl:grid-cols-2">
        <Card title="2. Registered client">
          {workspace?.registeredClient ? (
            <CodeBlock>{JSON.stringify(workspace.registeredClient, null, 2)}</CodeBlock>
          ) : (
            <p className="text-muted-foreground text-xs">
              No client has been registered in this workspace yet.
            </p>
          )}
        </Card>

        <Card title="3. Staged request">
          {workspace?.stagedRequest ? (
            <>
              <div className="space-y-2 text-xs">
                <DetailRow
                  label="request uri"
                  value={<code className="break-all">{String(workspace.stagedRequest.request_uri ?? '—')}</code>}
                />
                <DetailRow
                  label="authorization"
                  value={
                    authorizationUrl ? (
                      <a
                        href={authorizationUrl}
                        className="underline-offset-2 hover:underline"
                      >
                        {authorizationUrl}
                      </a>
                    ) : (
                      '—'
                    )
                  }
                />
                <DetailRow label="request id" value={String(workspace.stagedRequest.request_id ?? '—')} />
                <DetailRow label="trace" value={String(workspace.stagedRequest.reference_trace_id ?? '—')} />
              </div>

              <form className="mt-3 flex flex-wrap gap-2">
                <input type="hidden" name="workspace_id" value={workspace.workspaceId} />
                <button
                  formAction={approveGrantRequestAction}
                  type="submit"
                  className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
                >
                  approve via `/consent/approve`
                </button>
                <button
                  formAction={denyGrantRequestAction}
                  type="submit"
                  className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
                >
                  deny via `/consent/deny`
                </button>
                <Link
                  href="/dashboard/grants#pending-approvals"
                  className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                >
                  queue →
                </Link>
              </form>
              <p className="text-muted-foreground mt-3 text-[11px]">
                These actions call the live approval endpoints. If placeholder owner auth is
                enabled and this dashboard session expires, open the hosted consent page or sign in
                again at{' '}
                <Link href={ownerLoginPath} className="underline-offset-2 hover:underline">
                  owner access
                </Link>
                .
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              No PAR request staged yet.
            </p>
          )}
        </Card>
      </section>

      {examples ? (
        <section className="mb-6 grid gap-3 xl:grid-cols-2">
          <Card title="4. Curl equivalents">
            <div className="space-y-3">
              <CodeExample label="register client">{examples.registerCurl}</CodeExample>
              <CodeExample label="stage request">{examples.stageCurl}</CodeExample>
            </div>
          </Card>

          <Card title="What this workspace exercises">
            <ul className="text-muted-foreground space-y-2 text-xs">
              <li>1. `POST /oauth/register` with the current protected public-client profile</li>
              <li>2. `POST /oauth/par` with PDPP `authorization_details`</li>
              <li>3. `POST /consent/approve` and `POST /consent/deny` for the resulting pending request</li>
            </ul>
          </Card>
        </section>
      ) : null}
    </DashboardShell>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <DashboardSectionCard title={title} surface="human">
      {children}
    </DashboardSectionCard>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 break-words">{value}</div>
    </div>
  );
}

function CodeExample({
  label,
  children,
}: {
  label: string;
  children: string;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-[11px]">{label}</div>
      <CodeBlock>{children}</CodeBlock>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-muted overflow-x-auto rounded p-3 text-[11px] whitespace-pre-wrap break-words">
      <code>{children}</code>
    </pre>
  );
}
