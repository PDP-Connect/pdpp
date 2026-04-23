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
  DASHBOARD_BOOTSTRAP_CLIENT_ID,
  buildOwnerBootstrapExamples,
  getOwnerBootstrapFlow,
  type OwnerBootstrapFlow,
} from '../../lib/operator-bootstrap';
import { getOwnerLoginUrl } from '../../lib/owner-token';
import {
  approveOwnerTokenFlowAction,
  denyOwnerTokenFlowAction,
  exchangeOwnerTokenFlowAction,
  introspectOwnerTokenFlowAction,
  startOwnerTokenFlowAction,
} from './actions';

export const dynamic = 'force-dynamic';

type Params = {
  flow?: string;
  error?: string;
};

export default async function OwnerTokenBootstrapPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const flow = params.flow ? getOwnerBootstrapFlow(params.flow) : null;
  const examples = flow ? buildOwnerBootstrapExamples(flow) : null;
  const error = params.error ?? null;
  const ownerLoginUrl = getOwnerLoginUrl();

  return (
    <DashboardShell active="grants">
      <DashboardPageHeader
        title="Owner device flow"
        description="Use the real public device flow for owner self-export, then introspect or reuse the resulting token against the normal `/v1/streams` read surface."
        breadcrumbs={[
          { label: 'Grants', href: '/dashboard/grants' },
          { label: 'Owner device flow' },
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
              href="/dashboard/grants/request"
              className="border-border hover:bg-muted/50 rounded-xl border px-2.5 py-1.5"
            >
              register or inspect client →
            </Link>
            <a
              href={ownerLoginUrl}
              className="border-border hover:bg-muted/50 rounded-xl border px-2.5 py-1.5"
            >
              owner access →
            </a>
            <Link
              href="/dashboard/records"
              className="border-border hover:bg-muted/50 rounded-xl border px-2.5 py-1.5"
            >
              records workbench →
            </Link>
          </>
        }
        meta={
          <>
            <DashboardMetaPill
              label="flow state"
              value={flow ? flow.status.replace(/_/g, ' ') : 'not started'}
              tone="human"
            />
            <DashboardMetaPill
              label="client"
              value={flow?.clientId ?? DASHBOARD_BOOTSTRAP_CLIENT_ID}
            />
            <DashboardMetaPill
              label="token"
              value={flow?.token ? 'issued' : 'not issued'}
              tone={flow?.token ? 'protocol' : 'neutral'}
            />
          </>
        }
        surface="human"
      />

      {error ? (
        <div className="border-destructive/40 bg-destructive/5 mb-6 rounded-2xl border px-4 py-3 text-xs">
          <span className="text-destructive font-medium">Device-flow error:</span>{' '}
          <span>{error}</span>
        </div>
      ) : null}

      <section className="mb-6 grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card title="1. Start a device flow">
          <p className="text-muted-foreground mb-3 text-xs">
            This starts `POST /oauth/device_authorization` with a registered public client id, then
            keeps the resulting device/user codes in ephemeral dashboard memory so you can approve,
            exchange, and introspect the token without inventing a private mint route.
          </p>
          <form action={startOwnerTokenFlowAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              client id
              <input
                type="text"
                name="client_id"
                defaultValue={flow?.clientId ?? DASHBOARD_BOOTSTRAP_CLIENT_ID}
                className="border-border bg-background rounded border px-3 py-2"
              />
            </label>
            <button
              type="submit"
              className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
            >
              {flow ? 'start new device flow' : 'start device flow'}
            </button>
          </form>
          <p className="text-muted-foreground mt-3 text-[11px]">
            Leave <code>{DASHBOARD_BOOTSTRAP_CLIENT_ID}</code> unless you intentionally registered
            another public client. Unknown client ids fail here because this page uses the real
            authorization-server device endpoint. Use the{' '}
            <Link href="/dashboard/grants/request" className="underline-offset-2 hover:underline">
              grant request workspace
            </Link>{' '}
            if you need to register another public client first.
          </p>
        </Card>

        <Card title="Current flow state">
          {flow ? (
            <div className="space-y-2 text-xs">
              <DetailRow label="flow id" value={<code className="break-all">{flow.flowId}</code>} />
              <DetailRow label="status" value={<StatusBadge status={flow.status} />} />
              <DetailRow label="client" value={<code className="break-all">{flow.clientId}</code>} />
              <DetailRow label="subject" value={flow.subjectId ?? '—'} />
              <DetailRow label="started" value={flow.startedAt} />
              <DetailRow label="expires" value={flow.expiresAt ?? '—'} />
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              No active device flow in dashboard memory yet.
            </p>
          )}
        </Card>
      </section>

      {flow ? (
        <>
          {flow.lastError ? (
            <div className="border-destructive/40 bg-destructive/5 mb-6 rounded border px-3 py-2 text-xs">
              <span className="text-destructive font-medium">Last action error:</span>{' '}
              <span>{flow.lastError}</span>
            </div>
          ) : null}

          <section className="mb-6 grid gap-3 xl:grid-cols-2">
            <Card title="1. Device authorization">
              <div className="space-y-2 text-xs">
                <DetailRow label="user code" value={<code className="break-all text-sm font-semibold">{flow.userCode}</code>} />
                <DetailRow label="device code" value={<code className="break-all">{flow.deviceCode}</code>} />
                <DetailRow label="poll interval" value={`${flow.intervalSeconds}s`} />
                <DetailRow
                  label="verification uri"
                  value={
                    flow.verificationUriComplete ? (
                      <a
                        href={flow.verificationUriComplete}
                        className="underline-offset-2 hover:underline"
                      >
                        {flow.verificationUriComplete}
                      </a>
                    ) : flow.verificationUri ? (
                      <a href={flow.verificationUri} className="underline-offset-2 hover:underline">
                        {flow.verificationUri}
                      </a>
                    ) : (
                      '—'
                    )
                  }
                />
                <p className="text-muted-foreground text-[11px]">
                  This is the real public device flow. You can also open the verification URI in a
                  browser and approve manually.
                  {' '}
                  <a href={ownerLoginUrl} className="underline-offset-2 hover:underline">
                    Owner access
                  </a>
                  {' '}
                  is the stable hosted entry point.
                </p>
              </div>
            </Card>

            <Card title="2. Approve or deny">
              <form className="space-y-3">
                <input type="hidden" name="flow_id" value={flow.flowId} />
                <label className="flex flex-col gap-1 text-xs">
                  subject id
                  <input
                    type="text"
                    name="subject_id"
                    defaultValue={flow.subjectId ?? 'owner_local'}
                    className="border-border bg-background rounded border px-3 py-2"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    formAction={approveOwnerTokenFlowAction}
                    type="submit"
                    className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
                  >
                    approve via `/device/approve`
                  </button>
                  <button
                    formAction={denyOwnerTokenFlowAction}
                    type="submit"
                    className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
                  >
                    deny via `/device/deny`
                  </button>
                </div>
              </form>
              <p className="text-muted-foreground mt-3 text-[11px]">
                Current verification state: <StatusBadge status={flow.status} inline />
                {flow.approvalUpdatedAt ? ` · last updated ${flow.approvalUpdatedAt}` : ''}
              </p>
              <p className="text-muted-foreground mt-2 text-[11px]">
                These direct dashboard shortcut buttons only work while the reference AS approval
                pages are still open locally. If placeholder owner auth is enabled, sign in at{' '}
                <a href={ownerLoginUrl} className="underline-offset-2 hover:underline">
                  owner access
                </a>
                {' '}and finish approval in the hosted UI instead.
              </p>
            </Card>
          </section>

          <section className="mb-6 grid gap-3 xl:grid-cols-2">
            <Card title="3. Exchange token">
              <form action={exchangeOwnerTokenFlowAction} className="space-y-3">
                <input type="hidden" name="flow_id" value={flow.flowId} />
                <button
                  type="submit"
                  className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
                >
                  exchange via `/oauth/token`
                </button>
              </form>
              {flow.token ? (
                <div className="mt-3">
                  <div className="text-muted-foreground mb-1 text-[11px]">
                    issued {flow.tokenIssuedAt ?? 'just now'}
                  </div>
                  <CodeBlock>{flow.token}</CodeBlock>
                </div>
              ) : (
                <p className="text-muted-foreground mt-3 text-[11px]">
                  Exchange stays pending until the device flow is approved.
                </p>
              )}
            </Card>

            <Card title="4. Introspection">
              <form action={introspectOwnerTokenFlowAction} className="space-y-3">
                <input type="hidden" name="flow_id" value={flow.flowId} />
                <button
                  type="submit"
                  className="border-border hover:bg-muted/50 rounded border px-3 py-2 text-xs"
                >
                  introspect via `/introspect`
                </button>
              </form>
              {flow.introspection ? (
                <div className="mt-3">
                  <div className="text-muted-foreground mb-1 text-[11px]">
                    refreshed {flow.introspectedAt ?? 'just now'}
                  </div>
                  <CodeBlock>{JSON.stringify(flow.introspection, null, 2)}</CodeBlock>
                </div>
              ) : (
                <p className="text-muted-foreground mt-3 text-[11px]">
                  Introspection is available after the token is issued.
                </p>
              )}
            </Card>
          </section>

          {examples ? (
            <section className="mb-6 grid gap-3 xl:grid-cols-2">
              <Card title="5. CLI equivalents">
                <div className="space-y-3">
                  <CodeExample label="login">{examples.cliLogin}</CodeExample>
                  <CodeExample label="introspect">{examples.cliIntrospect}</CodeExample>
                </div>
              </Card>

              <Card title="Curl equivalents">
                <div className="space-y-3">
                  <CodeExample label="device authorization">{examples.startCurl}</CodeExample>
                  <CodeExample label="approve">{examples.approveCurl}</CodeExample>
                  <CodeExample label="exchange">{examples.exchangeCurl}</CodeExample>
                  <CodeExample label="introspect">{examples.introspectCurl}</CodeExample>
                  <CodeExample label="owner read">{examples.ownerReadExample}</CodeExample>
                </div>
              </Card>
            </section>
          ) : null}
        </>
      ) : (
        <Card title="How to use this page">
          <ul className="text-muted-foreground space-y-2 text-xs">
            <li>1. the dashboard uses the real public device flow, not a hidden token mint endpoint</li>
            <li>2. approval state is explicit and operator-visible</li>
            <li>3. the resulting token is introspected through the public RFC 7662-style route</li>
            <li>4. the issued token can be reused against the normal owner self-export RS routes</li>
            <li>5. CLI and curl equivalents stay visible so the flow remains debuggable outside the UI</li>
          </ul>
        </Card>
      )}
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

function StatusBadge({
  status,
  inline = false,
}: {
  status: OwnerBootstrapFlow['status'];
  inline?: boolean;
}) {
  const tone =
    status === 'denied'
      ? 'bg-destructive/10 text-destructive'
      : status === 'token_issued'
        ? 'bg-muted text-foreground'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={`${inline ? '' : 'inline-flex'} rounded px-1.5 py-0.5 text-[10px] ${tone}`}>
      {status.replace(/_/g, ' ')}
    </span>
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
