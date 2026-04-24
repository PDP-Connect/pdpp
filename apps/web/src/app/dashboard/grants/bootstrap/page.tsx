import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { MetaPill, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { DashboardShell } from "../../components/shell.tsx";
import {
  buildOwnerBootstrapExamples,
  DASHBOARD_BOOTSTRAP_CLIENT_ID,
  getOwnerBootstrapFlow,
} from "../../lib/operator-bootstrap.ts";
import { getOwnerLoginPath } from "../../lib/owner-token.ts";
import {
  approveOwnerTokenFlowAction,
  denyOwnerTokenFlowAction,
  exchangeOwnerTokenFlowAction,
  introspectOwnerTokenFlowAction,
  startOwnerTokenFlowAction,
} from "./actions.ts";

export const dynamic = "force-dynamic";

interface Params {
  flow?: string;
  error?: string;
}

export default async function OwnerTokenBootstrapPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const flow = params.flow ? getOwnerBootstrapFlow(params.flow) : null;
  const examples = flow ? await buildOwnerBootstrapExamples(flow) : null;
  const error = params.error ?? null;
  const ownerLoginUrl = getOwnerLoginPath();

  return (
    <DashboardShell active="grants">
      <PageHeader
        title="Owner device flow"
        description="Use the real public device flow to mint an owner self-export token, then introspect or reuse it against the normal `/v1/streams` read surface."
        breadcrumbs={[{ label: "Grants", href: "/dashboard/grants" }, { label: "Owner device flow" }]}
        actions={
          <>
            <Link
              href="/dashboard/grants#pending-approvals"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Pending approvals
            </Link>
            <Link href="/dashboard/grants/request" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Grant request
            </Link>
            <a href={ownerLoginUrl} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Owner access
            </a>
            <Link href="/dashboard/records" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Records workbench
            </Link>
          </>
        }
        meta={
          <>
            <MetaPill
              label="flow"
              value={flow ? flow.status.replace(/_/g, " ") : "not started"}
              tone={flow ? "human" : "neutral"}
            />
            <MetaPill label="client" value={flow?.clientId ?? DASHBOARD_BOOTSTRAP_CLIENT_ID} />
            <MetaPill
              label="token"
              value={flow?.token ? "issued" : "not issued"}
              tone={flow?.token ? "protocol" : "neutral"}
            />
          </>
        }
      />

      {error ? (
        <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
          <span className="font-medium text-destructive">Device-flow error:</span> <span>{error}</span>
        </div>
      ) : null}

      <Section
        title="1. Start a device flow"
        description="This starts `POST /oauth/device_authorization` with a registered public client id, then keeps the resulting device and user codes in ephemeral dashboard memory."
      >
        <form action={startOwnerTokenFlowAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="pdpp-eyebrow">Client id</span>
            <Input type="text" name="client_id" defaultValue={flow?.clientId ?? DASHBOARD_BOOTSTRAP_CLIENT_ID} />
          </label>
          <Button type="submit" size="sm">
            {flow ? "Start new flow" : "Start device flow"}
          </Button>
        </form>
        <p className="pdpp-caption mt-3 text-muted-foreground">
          Leave <code className="font-mono">{DASHBOARD_BOOTSTRAP_CLIENT_ID}</code> unless you registered another public
          client. Unknown client ids fail here because this page uses the real authorization-server device endpoint. Use
          the{" "}
          <Link href="/dashboard/grants/request" className="underline-offset-2 hover:underline">
            grant request workspace
          </Link>{" "}
          to register more.
        </p>
      </Section>

      {flow ? (
        <>
          {flow.lastError ? (
            <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
              <span className="font-medium text-destructive">Last action error:</span> <span>{flow.lastError}</span>
            </div>
          ) : null}

          <Section title="Current flow">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <DetailCard title="Flow">
                <DetailRow label="id" value={<code className="break-all">{flow.flowId}</code>} />
                <DetailRow label="status" value={<StatusBadge status={flow.status} />} />
                <DetailRow label="client" value={<code className="break-all">{flow.clientId}</code>} />
                <DetailRow label="subject" value={flow.subjectId ?? "—"} />
                <DetailRow label="started" value={<Timestamp value={flow.startedAt} />} />
                <DetailRow label="expires" value={flow.expiresAt ? <Timestamp value={flow.expiresAt} /> : "—"} />
              </DetailCard>
              <DetailCard title="Device authorization">
                <DetailRow
                  label="user code"
                  value={<code className="pdpp-body break-all font-semibold">{flow.userCode}</code>}
                />
                <DetailRow label="device code" value={<code className="break-all">{flow.deviceCode}</code>} />
                <DetailRow label="poll" value={`${flow.intervalSeconds}s`} />
                <DetailRow
                  label="verification"
                  value={
                    flow.verificationUriComplete ? (
                      <a href={flow.verificationUriComplete} className="underline-offset-2 hover:underline">
                        {flow.verificationUriComplete}
                      </a>
                    ) : flow.verificationUri ? (
                      <a href={flow.verificationUri} className="underline-offset-2 hover:underline">
                        {flow.verificationUri}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                />
              </DetailCard>
              <DetailCard title="Approval">
                <form className="space-y-3">
                  <input type="hidden" name="flow_id" value={flow.flowId} />
                  <label className="flex flex-col gap-1">
                    <span className="pdpp-eyebrow">Subject id</span>
                    <Input type="text" name="subject_id" defaultValue={flow.subjectId ?? "owner_local"} />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button formAction={approveOwnerTokenFlowAction} type="submit" size="sm">
                      <span className="font-mono">POST /device/approve</span>
                    </Button>
                    <Button formAction={denyOwnerTokenFlowAction} type="submit" size="sm" variant="destructive">
                      <span className="font-mono">POST /device/deny</span>
                    </Button>
                  </div>
                </form>
                <p className="pdpp-caption mt-2 inline-flex flex-wrap items-baseline gap-1 text-muted-foreground">
                  State: <StatusBadge status={flow.status} inline />
                  {flow.approvalUpdatedAt ? (
                    <>
                      · updated <Timestamp value={flow.approvalUpdatedAt} />
                    </>
                  ) : null}
                </p>
              </DetailCard>
            </div>
          </Section>

          <Section title="2. Exchange and introspect">
            <div className="grid gap-4 md:grid-cols-2">
              <DetailCard title="Exchange">
                <form action={exchangeOwnerTokenFlowAction}>
                  <input type="hidden" name="flow_id" value={flow.flowId} />
                  <Button type="submit" size="sm">
                    <span className="font-mono">POST /oauth/token</span>
                  </Button>
                </form>
                {flow.token ? (
                  <div className="mt-3">
                    <div className="pdpp-caption mb-1 inline-flex items-baseline gap-1 text-muted-foreground">
                      issued {flow.tokenIssuedAt ? <Timestamp value={flow.tokenIssuedAt} /> : "just now"}
                    </div>
                    <CodeBlock>{flow.token}</CodeBlock>
                  </div>
                ) : (
                  <p className="pdpp-caption mt-3 text-muted-foreground italic">
                    Exchange stays pending until the device flow is approved.
                  </p>
                )}
              </DetailCard>
              <DetailCard title="Introspection">
                <form action={introspectOwnerTokenFlowAction}>
                  <input type="hidden" name="flow_id" value={flow.flowId} />
                  <Button type="submit" variant="outline" size="sm">
                    <span className="font-mono">POST /introspect</span>
                  </Button>
                </form>
                {flow.introspection ? (
                  <div className="mt-3">
                    <div className="pdpp-caption mb-1 inline-flex items-baseline gap-1 text-muted-foreground">
                      refreshed {flow.introspectedAt ? <Timestamp value={flow.introspectedAt} /> : "just now"}
                    </div>
                    <CodeBlock>{JSON.stringify(flow.introspection, null, 2)}</CodeBlock>
                  </div>
                ) : (
                  <p className="pdpp-caption mt-3 text-muted-foreground italic">
                    Introspection is available after the token is issued.
                  </p>
                )}
              </DetailCard>
            </div>
          </Section>

          {examples ? (
            <Section title="3. Equivalents" description="Reproduce the full flow outside the dashboard.">
              <div className="grid gap-4 xl:grid-cols-2">
                <DetailCard title="CLI">
                  <Labeled label="login">
                    <CodeBlock>{examples.cliLogin}</CodeBlock>
                  </Labeled>
                  <Labeled label="introspect">
                    <CodeBlock>{examples.cliIntrospect}</CodeBlock>
                  </Labeled>
                </DetailCard>
                <DetailCard title="Curl">
                  <Labeled label="device authorization">
                    <CodeBlock>{examples.startCurl}</CodeBlock>
                  </Labeled>
                  <Labeled label="approve">
                    <CodeBlock>{examples.approveCurl}</CodeBlock>
                  </Labeled>
                  <Labeled label="exchange">
                    <CodeBlock>{examples.exchangeCurl}</CodeBlock>
                  </Labeled>
                  <Labeled label="introspect">
                    <CodeBlock>{examples.introspectCurl}</CodeBlock>
                  </Labeled>
                  <Labeled label="owner read">
                    <CodeBlock>{examples.ownerReadExample}</CodeBlock>
                  </Labeled>
                </DetailCard>
              </div>
            </Section>
          ) : null}
        </>
      ) : (
        <Section title="How to use this page">
          <ul className="pdpp-body max-w-prose list-disc space-y-1.5 pl-5 text-muted-foreground">
            <li>The dashboard uses the real public device flow — no hidden token mint endpoint.</li>
            <li>Approval state is explicit and operator-visible.</li>
            <li>The issued token is introspected through the public RFC 7662-style route.</li>
            <li>The resulting token can be reused against the normal owner self-export routes.</li>
            <li>CLI and curl equivalents stay visible so the flow remains debuggable outside the UI.</li>
          </ul>
        </Section>
      )}
    </DashboardShell>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div data-surface="human" className="rounded-md p-4">
      <h3 className="pdpp-eyebrow mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="pdpp-caption grid gap-0.5 sm:grid-cols-[5rem_minmax(0,1fr)] sm:items-baseline sm:gap-2">
      <span className="pdpp-caption text-muted-foreground">{label}</span>
      <div className="min-w-0 break-words">{value}</div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="pdpp-eyebrow mb-1">{label}</div>
      {children}
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
