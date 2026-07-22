// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox deployment page. Uses the shared live deployment diagnostics view
 * with deterministic demo data, then appends sandbox-only metadata sections.
 */

import { ConnectAgentCard } from "@pdpp/operator-ui/components/connect-agent-card";
import { Section } from "@pdpp/operator-ui/components/primitives";
import { DeploymentDiagnosticsView } from "@pdpp/operator-ui/components/views/deployment-diagnostics-view";
import { headers } from "next/headers";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { getDemoCapabilities } from "../_demo/builders.ts";
import { CodeBlock } from "../_demo/components/code-block.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";
import {
  buildSandboxAuthorizationServerMetadata,
  buildSandboxProtectedResourceMetadata,
} from "../_demo/operations-fixtures.ts";

export const dynamic = "force-dynamic";

export default async function SandboxDeploymentPage() {
  const report = await sandboxDashboardDataSource.getDeploymentDiagnostics();
  const capabilities = getDemoCapabilities();
  const issuer = `${await getRequestOrigin()}/sandbox`;
  const auth = buildSandboxAuthorizationServerMetadata(issuer);
  const rs = await buildSandboxProtectedResourceMetadata(issuer);

  return (
    <DashboardShell active="deployment" mode="mock-owner">
      <DeploymentDiagnosticsView
        afterDiagnostics={
          <>
            <ConnectAgentCard mode="sandbox" providerUrl={issuer} />
            <SandboxDeploymentExtensions auth={auth} capabilities={capabilities} protectedResource={rs} />
          </>
        }
        description="Reference deployment diagnostics: AS/RS metadata, retrieval state, and manifests."
        report={report}
      />
    </DashboardShell>
  );
}

function SandboxDeploymentExtensions({
  auth,
  capabilities,
  protectedResource,
}: {
  auth: ReturnType<typeof buildSandboxAuthorizationServerMetadata>;
  capabilities: ReturnType<typeof getDemoCapabilities>;
  protectedResource: Awaited<ReturnType<typeof buildSandboxProtectedResourceMetadata>>;
}) {
  return (
    <>
      <Section description="Capabilities advertised by this reference implementation." title="Capabilities matrix">
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {capabilities.map((cap) => (
            <li
              className="grid grid-cols-1 gap-1 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_6rem_6rem]"
              key={cap.capability}
            >
              <span className="pdpp-body font-medium text-foreground">{cap.capability}</span>
              <span className="pdpp-caption text-muted-foreground">
                {cap.description}
                <br />
                <span className="text-muted-foreground/70">{cap.notes}</span>
              </span>
              <span
                className={`pdpp-eyebrow ${cap.implemented ? "text-[color:var(--success)]" : "text-muted-foreground"}`}
              >
                {cap.implemented ? "live: ✓" : "live: —"}
              </span>
              <span
                className={`pdpp-eyebrow ${cap.demonstrated_in_demo ? "text-[color:var(--success)]" : "text-muted-foreground"}`}
              >
                {cap.demonstrated_in_demo ? "demo: ✓" : "demo: —"}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section description="Live response from /sandbox/.well-known/oauth-authorization-server." title="AS metadata">
        <CodeBlock language="json">{JSON.stringify(auth, null, 2)}</CodeBlock>
      </Section>

      <Section description="Live response from /sandbox/.well-known/oauth-protected-resource." title="RS metadata">
        <CodeBlock language="json">{JSON.stringify(protectedResource, null, 2)}</CodeBlock>
      </Section>
    </>
  );
}

async function getRequestOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3002";
  const protocol =
    headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`;
}
