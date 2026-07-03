import { buttonVariants, IcButton, IcInput, IcTimestamp } from "@pdpp/brand-react";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { Callout, PageHeader } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/shell.tsx";
import { buildOwnerBootstrapExamples, getOwnerBootstrapFlow } from "../../lib/operator-bootstrap.ts";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import {
  listOwnerClientTokens,
  listOwnerIssuedClients,
  type OwnerClientToken,
  type OwnerIssuedClient,
} from "../../lib/ref-client.ts";
import {
  introspectOwnerTokenFlowAction,
  issueOwnerTokenAction,
  renameOwnerTokenAction,
  revokeOwnerClientTokenAction,
  revokeOwnerTokenAction,
} from "./actions.ts";

export const dynamic = "force-dynamic";

interface Params {
  error?: string;
  flow?: string;
  notice?: string;
  reproduce?: string;
}

type FlowState = NonNullable<ReturnType<typeof getOwnerBootstrapFlow>>;
type FlowExamples = NonNullable<Awaited<ReturnType<typeof buildOwnerBootstrapExamples>>>;
type ReproduceFormat = "curl" | "cli";
const DAISY_OWNER_AGENT_CREDENTIAL_PATH = "~/applications/daisy/.pi/agent/pdpp-owner-agent.json";

function InlineError({ prefix, message }: { message: string; prefix: string }) {
  return (
    <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5">
      <span className="font-medium text-destructive">{prefix}:</span> <span>{message}</span>
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function OwnerAgentOnboardingCard({ entrypoint }: { entrypoint: string }) {
  const command = [
    "pdpp owner-agent onboard",
    shellQuote(entrypoint),
    "--credential-file",
    shellQuote(DAISY_OWNER_AGENT_CREDENTIAL_PATH),
    "--client-name",
    shellQuote("Daisy"),
  ].join(" ");
  return (
    <section
      className="mb-6 rounded-md border border-[color:var(--human)]/30 bg-[color:var(--human-wash)]/30 p-5"
      data-surface="human"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          <p className="pdpp-eyebrow text-[color:var(--human)]">Recommended owner-agent path</p>
          <h2 className="pdpp-title mt-1 text-foreground">Let the local agent complete onboarding</h2>
          <p className="pdpp-caption mt-2 text-muted-foreground">
            Use this for Daisy or another trusted local agent. The agent starts from the public entrypoint, opens the
            browser approval flow, and writes the owner credential directly to its local state. No bearer needs to be
            pasted into chat or copied out of the dashboard.
          </p>
        </div>
        <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/deployment">
          Review deployment metadata
        </Link>
      </div>
      <div className="mt-4 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <CodeBlock>{command}</CodeBlock>
        </div>
        <CopyButton ariaLabel="Copy owner-agent onboarding command" value={command} />
      </div>
      <p className="pdpp-caption mt-3 text-muted-foreground">
        Daisy reads <code className="font-mono">{DAISY_OWNER_AGENT_CREDENTIAL_PATH}</code>, uses the top-level{" "}
        <code className="font-mono">access_token</code> for owner-level REST reads, and should not send it to{" "}
        <code className="font-mono">/mcp</code>.
      </p>
    </section>
  );
}

/**
 * Single card that holds both the issuance form and the issued-token result.
 * SLVP convention (GitHub/Stripe/Vercel/Linear) — operator's eye stays on one
 * surface across the create-then-copy transition.
 */
function IssueCard({ flow }: { flow: FlowState | null }) {
  return (
    <div className="rounded-md border border-border/80 p-5" data-surface="human">
      <div className="mb-4">
        <p className="pdpp-eyebrow">Manual/debug bearer</p>
        <p className="pdpp-caption mt-1 text-muted-foreground">
          Use this fallback for debugging a script you control or inspecting the wire flow. For Daisy, prefer the
          owner-agent command above so the credential lands in the right local file.
        </p>
      </div>
      <form action={issueOwnerTokenAction} className="flex flex-col gap-2">
        <label className="flex min-w-0 flex-col gap-1" htmlFor="token-name">
          <span className="pdpp-eyebrow">Debug credential name</span>
        </label>
        <div className="flex min-w-0 gap-2">
          <IcInput
            className="flex-1"
            defaultValue=""
            id="token-name"
            name="name"
            placeholder="e.g. local-debug"
            type="text"
          />
          <IcButton size="sm" type="submit" variant="ghost">
            Issue debug bearer
          </IcButton>
        </div>
      </form>

      {flow?.token ? (
        <div className="mt-5 border-border/60 border-t pt-5">
          <div className="pdpp-eyebrow mb-2 inline-flex items-baseline gap-2">
            <span>{flow.name ?? "Unnamed token"}</span>
            {flow.tokenIssuedAt ? (
              <span className="text-muted-foreground">
                · issued <IcTimestamp value={flow.tokenIssuedAt} />
              </span>
            ) : null}
          </div>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <CodeBlock>{flow.token}</CodeBlock>
            </div>
            <CopyButton ariaLabel="Copy bearer token" value={flow.token} />
          </div>
          <p className="pdpp-caption mt-2 text-muted-foreground">
            Manual bearer issued. Copy it now if you are debugging a local script — the dashboard does not store it.
            Send as <code className="font-mono">Authorization: Bearer …</code> to{" "}
            <code className="font-mono">/v1/*</code>.
          </p>
        </div>
      ) : null}

      <p className="pdpp-caption mt-4 text-muted-foreground">
        Each token is a freshly-registered OAuth client (RFC 7591), bound to your signed-in subject. Revoke with one
        click — that deletes the client (RFC 7592) and cascade-revokes its bearer.
      </p>
    </div>
  );
}

/**
 * Flat transcript of the device flow that just ran. Numbered, no nested
 * cards, no re-execute buttons (the steps already ran). Operators inspecting
 * the wire don't need to drive each step again — they need to see what
 * happened. Introspect-on-demand stays as a single button because operators
 * do legitimately want to verify a token after issuance.
 */
function TranscriptStep({ index, method, path, body }: { index: number; method: string; path: string; body?: string }) {
  return (
    <li>
      <div className="pdpp-caption mb-1 inline-flex items-baseline gap-2 text-muted-foreground">
        <span className="font-mono text-foreground">
          {index}. {method} {path}
        </span>
      </div>
      {body ? <CodeBlock>{body}</CodeBlock> : null}
    </li>
  );
}

function Transcript({ flow }: { flow: FlowState }) {
  const start = JSON.stringify({ client_id: flow.clientId }, null, 2);
  const approve = JSON.stringify({ user_code: flow.userCode }, null, 2);
  const exchange = JSON.stringify(
    {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: flow.deviceCode,
      client_id: flow.clientId,
    },
    null,
    2
  );
  return (
    <ol className="space-y-4">
      <TranscriptStep body={start} index={1} method="POST" path="/oauth/device_authorization" />
      <TranscriptStep body={approve} index={2} method="POST" path="/device/approve" />
      <TranscriptStep body={exchange} index={3} method="POST" path="/oauth/token" />
    </ol>
  );
}

function IntrospectControl({ flow }: { flow: FlowState }) {
  return (
    <div>
      <form action={introspectOwnerTokenFlowAction}>
        <input name="flow_id" type="hidden" value={flow.flowId} />
        <IcButton size="sm" type="submit" variant="ghost">
          Introspect this token
        </IcButton>
      </form>
      {flow.introspection ? (
        <div className="mt-3">
          <div className="pdpp-caption mb-1 text-muted-foreground">
            POST /introspect · refreshed{" "}
            {flow.introspectedAt ? <IcTimestamp value={flow.introspectedAt} /> : "just now"}
          </div>
          <CodeBlock>{JSON.stringify(flow.introspection, null, 2)}</CodeBlock>
        </div>
      ) : null}
    </div>
  );
}

function ReproduceToggle({ flowId, format }: { flowId: string; format: ReproduceFormat }) {
  const base = `/deployment/tokens?flow=${encodeURIComponent(flowId)}`;
  return (
    <div className="pdpp-caption inline-flex gap-1 rounded-md border border-border p-0.5">
      <Link
        className={`rounded px-2 py-0.5 ${format === "curl" ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        href={`${base}&reproduce=curl`}
        prefetch={false}
      >
        curl
      </Link>
      <Link
        className={`rounded px-2 py-0.5 ${format === "cli" ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        href={`${base}&reproduce=cli`}
        prefetch={false}
      >
        pdpp CLI
      </Link>
    </div>
  );
}

function ReproduceBlock({ examples, format }: { examples: FlowExamples; format: ReproduceFormat }) {
  if (format === "cli") {
    return (
      <div className="space-y-3">
        <CodeBlock>{examples.cliLogin}</CodeBlock>
        <CodeBlock>{examples.cliIntrospect}</CodeBlock>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <CodeBlock>{examples.startCurl}</CodeBlock>
      <CodeBlock>{examples.approveCurl}</CodeBlock>
      <CodeBlock>{examples.exchangeCurl}</CodeBlock>
      <CodeBlock>{examples.introspectCurl}</CodeBlock>
      <CodeBlock>{examples.ownerReadExample}</CodeBlock>
    </div>
  );
}

function InlineNotice({ message }: { message: string }) {
  return (
    <div className="pdpp-caption mb-6 rounded-md border border-border bg-muted/40 px-4 py-2.5 text-foreground">
      {message}
    </div>
  );
}

// Owner bearers and the routine MCP scoped-grant flow are two separate paths
// with two separate audiences. Tokens issued here cover the whole RS read
// surface under the operator's identity — fine for a CLI you wrote yourself,
// a backup script you run from your laptop, or a trusted local agent that
// acts on the operator's behalf. They are explicitly the wrong shape for
// ordinary MCP clients (Claude, ChatGPT, third-party agents); the hosted
// MCP endpoint rejects owner bearers by design.
function OwnerScopeCallout() {
  return (
    <Callout className="mb-6" title="Use this for operator and trusted-agent access only" tone="warning">
      <p className="pdpp-caption text-callout-warning-fg/80">
        Owner-agent credentials are owner bearers — they grant the operator's full read access to{" "}
        <code className="font-mono">/v1/*</code>. Use them for the operator themselves, for CLI tools and scripts you
        wrote, and for trusted local agents that run on your behalf.
      </p>
      <p className="pdpp-caption mt-2 text-callout-warning-fg/80">
        Ordinary MCP clients (Claude, ChatGPT, third-party agents) should connect through the OAuth scoped-grant flow at{" "}
        <code className="font-mono">/mcp</code>. That path is documented in the{" "}
        <Link className="underline-offset-2 hover:underline" href="/connect">
          connect page
        </Link>
        . <code className="font-mono">/mcp</code> rejects owner bearers on purpose.
      </p>
    </Callout>
  );
}

/**
 * Per-client token drilldown, shown only when a client has more than one
 * active token. Lists each token with its issued/expiry facts and a per-token
 * revoke that targets exactly that bearer (not the whole client). The
 * `token_id_public` is a non-reversible digest, never a usable bearer.
 */
function TokenDrilldown({ clientId, tokens }: { clientId: string; tokens: OwnerClientToken[] }) {
  return (
    <details className="mt-2 rounded-md border border-border/70 bg-muted/20">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium text-xs">
        Show individual tokens ({tokens.length})
      </summary>
      <ul className="divide-y divide-border/60 border-border/60 border-t">
        {tokens.map((token) => (
          <li
            className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            key={token.token_id_public}
          >
            <div className="min-w-0">
              <div className="pdpp-caption inline-flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                <span>
                  issued <IcTimestamp value={token.created_at} />
                </span>
                <span aria-hidden>·</span>
                <span>
                  {token.expires_at ? (
                    <>
                      expires <IcTimestamp value={token.expires_at} />
                    </>
                  ) : (
                    "no expiry"
                  )}
                </span>
                <span aria-hidden>·</span>
                <code className="font-mono text-xs">{token.token_id_public}</code>
              </div>
            </div>
            <form action={revokeOwnerClientTokenAction}>
              <input name="client_id" type="hidden" value={clientId} />
              <input name="token_id_public" type="hidden" value={token.token_id_public} />
              <IcButton size="sm" type="submit" variant="ghost">
                Revoke this token
              </IcButton>
            </form>
          </li>
        ))}
      </ul>
    </details>
  );
}

function TokensListSection({
  tokens,
  tokenDetailsByClient,
  highlightClientId,
}: {
  tokens: OwnerIssuedClient[];
  tokenDetailsByClient: Map<string, OwnerClientToken[]>;
  highlightClientId: string | null;
}) {
  if (tokens.length === 0) {
    return null;
  }
  return (
    <div className="rounded-md border border-border" data-surface="human">
      <div className="border-border/70 border-b px-5 py-3">
        <h2 className="pdpp-eyebrow">Owner credentials</h2>
        <p className="pdpp-caption mt-0.5 text-muted-foreground">
          One row per approved owner-agent or manual credential. Rename the label in place, or revoke to delete the
          OAuth client (RFC 7592) and cascade-revoke its bearers. Clients with more than one active token expand to
          per-token details.
        </p>
      </div>
      <ul className="divide-y divide-border/70">
        {tokens.map((token) => {
          const isHighlight = highlightClientId === token.client_id;
          const detailTokens = tokenDetailsByClient.get(token.client_id) ?? [];
          const showDrilldown = token.active_token_count > 1 && detailTokens.length > 0;
          return (
            <li className={`flex flex-col gap-2 px-5 py-3 ${isHighlight ? "bg-muted/30" : ""}`} key={token.client_id}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="pdpp-body font-medium">{token.client_name ?? "Unnamed token"}</div>
                  <div className="pdpp-caption mt-0.5 inline-flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                    <span>
                      {token.active_token_count > 1 ? "first issued " : "issued "}
                      <IcTimestamp value={token.created_at} />
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {token.active_token_count} active token{token.active_token_count === 1 ? "" : "s"}
                    </span>
                    <span aria-hidden>·</span>
                    <code className="font-mono text-xs">{token.client_id}</code>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <form action={renameOwnerTokenAction} className="flex items-center gap-2">
                    <input name="client_id" type="hidden" value={token.client_id} />
                    <IcInput
                      aria-label={`Rename ${token.client_name ?? "credential"}`}
                      className="h-8 w-40"
                      defaultValue={token.client_name ?? ""}
                      name="client_name"
                      placeholder="Credential name"
                      type="text"
                    />
                    <IcButton size="sm" type="submit" variant="ghost">
                      Rename
                    </IcButton>
                  </form>
                  <form action={revokeOwnerTokenAction}>
                    <input name="client_id" type="hidden" value={token.client_id} />
                    <IcButton size="sm" type="submit" variant="destructive">
                      Revoke
                    </IcButton>
                  </form>
                </div>
              </div>
              {showDrilldown ? <TokenDrilldown clientId={token.client_id} tokens={detailTokens} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FlowInspector({
  flow,
  examples,
  format,
}: {
  flow: FlowState;
  examples: FlowExamples | null;
  format: ReproduceFormat;
}) {
  return (
    <details className="rounded-md border border-border bg-card/30">
      <summary className="cursor-pointer select-none px-4 py-3 font-medium text-sm">
        Show manual bearer wire details
        <span className="pdpp-caption ml-2 text-muted-foreground">
          (real RFC 8628 wire — inspect, debug, or replay outside the dashboard)
        </span>
      </summary>
      <div className="space-y-6 border-border/70 border-t p-5">
        {flow.lastError ? <InlineError message={flow.lastError} prefix="Last action error" /> : null}

        <section>
          <h3 className="pdpp-eyebrow mb-3">Wire transcript</h3>
          <Transcript flow={flow} />
        </section>

        <section>
          <h3 className="pdpp-eyebrow mb-3">Verify</h3>
          <IntrospectControl flow={flow} />
        </section>

        {examples ? (
          <section>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h3 className="pdpp-eyebrow">Reproduce out-of-band</h3>
              <ReproduceToggle flowId={flow.flowId} format={format} />
            </div>
            <ReproduceBlock examples={examples} format={format} />
          </section>
        ) : null}
      </div>
    </details>
  );
}

export default async function DeploymentTokensPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const flow = params.flow ? getOwnerBootstrapFlow(params.flow) : null;
  const examples = flow ? await buildOwnerBootstrapExamples(flow) : null;
  const error = params.error ?? null;
  const notice = params.notice ?? null;
  const format: ReproduceFormat = params.reproduce === "cli" ? "cli" : "curl";
  const entrypoint = await getReferencePublicOrigin();

  let tokens: OwnerIssuedClient[] = [];
  const tokenDetailsByClient = new Map<string, OwnerClientToken[]>();
  try {
    const resp = await listOwnerIssuedClients();
    tokens = resp.data ?? [];
    // Only clients with more than one active token get a per-token drilldown;
    // a single-token client is fully described by its row.
    const multiTokenClients = tokens.filter((t) => t.active_token_count > 1);
    await Promise.all(
      multiTokenClients.map(async (client) => {
        try {
          const detail = await listOwnerClientTokens(client.client_id);
          tokenDetailsByClient.set(client.client_id, detail.data ?? []);
        } catch {
          // A per-client drilldown failure must not break the whole page; the
          // row still renders its aggregate count without the expansion.
        }
      })
    );
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Tokens" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href="/deployment">
            Deployment overview
          </Link>
        }
        breadcrumbs={[{ label: "Deployment", href: "/deployment" }, { label: "Tokens" }]}
        description="Set up trusted local owner automation without pasting bearer material. Manual owner bearers stay available below for debugging."
        title="Owner-agent access"
      />

      <OwnerAgentOnboardingCard entrypoint={entrypoint} />

      <OwnerScopeCallout />

      {error ? <InlineError message={error} prefix="Action failed" /> : null}
      {notice === "revoked" ? <InlineNotice message="Credential revoked. Its bearers no longer work." /> : null}
      {notice === "token_revoked" ? (
        <InlineNotice message="Token revoked. That one bearer no longer works; the credential's other tokens are unaffected." />
      ) : null}
      {notice === "renamed" ? <InlineNotice message="Credential renamed." /> : null}

      <IssueCard flow={flow} />

      <TokensListSection
        highlightClientId={flow?.clientId ?? null}
        tokenDetailsByClient={tokenDetailsByClient}
        tokens={tokens}
      />

      {flow ? <FlowInspector examples={examples} flow={flow} format={format} /> : null}
    </RecordroomShellWithPalette>
  );
}
