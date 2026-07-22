// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { CopyButton } from "./copy-button.tsx";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function mcpUrlFor(providerUrl?: string): string {
  return providerUrl ? `${trimTrailingSlash(providerUrl)}/mcp` : "<provider-url>/mcp";
}

export function ConnectAgentCard({
  connectHref,
  mode,
  providerUrl,
}: {
  connectHref?: string;
  mode: "live" | "sandbox";
  providerUrl?: string;
}) {
  const label = mode === "live" ? "Live reference" : "Sandbox mock";
  const mcpUrl = mcpUrlFor(providerUrl);
  const posture =
    mode === "live"
      ? "Use the MCP URL from this running deployment."
      : "Sandbox URL is illustrative; it targets deterministic mock data, not owner data.";
  return (
    <section className="mb-8 rounded-2xl border bg-card/80 p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="pdpp-eyebrow text-muted-foreground">{label}</div>
          <h2 className="pdpp-title mt-1 text-foreground">Connect an AI app</h2>
          <p className="pdpp-caption mt-1 max-w-2xl text-muted-foreground">
            Copy the MCP URL here, or open the setup page for Claude Code, Codex, ChatGPT, Claude.ai, and local agent
            entrypoints.
          </p>
        </div>
        {connectHref ? (
          <a
            className="pdpp-label inline-flex items-center rounded-md border border-border px-3 py-1.5 hover:bg-muted/60"
            href={connectHref}
          >
            Open setup →
          </a>
        ) : null}
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-lg border bg-muted/35 px-3 py-2">
        <code className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-foreground">
          {mcpUrl}
        </code>
        <CopyButton ariaLabel="Copy MCP server URL" value={mcpUrl} />
      </div>
      <p className="pdpp-caption mt-3 text-muted-foreground">
        {posture} The owner approves scoped access in the browser; no owner bearer token is pasted into the agent.
      </p>
    </section>
  );
}
