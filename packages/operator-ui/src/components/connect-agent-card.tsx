import {
  pdppCliConnectCommand,
  pdppCliConnectCommandFor,
  pdppCliPackageInfo,
  pdppCliTokenCompletionUnavailable,
} from "../lib/cli-command.ts";
import { CopyButton } from "./copy-button.tsx";

export function ConnectAgentCard({ mode, providerUrl }: { mode: "live" | "sandbox"; providerUrl?: string }) {
  const label = mode === "live" ? "Live reference" : "Sandbox mock";
  const connectCommand = providerUrl ? pdppCliConnectCommandFor(providerUrl) : pdppCliConnectCommand;
  const posture =
    mode === "live"
      ? "Use the provider URL from this running deployment."
      : "Sandbox command is illustrative; it targets deterministic mock data, not owner data.";
  return (
    <section className="mb-8 rounded-2xl border bg-card/80 p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="pdpp-eyebrow text-muted-foreground">{label}</div>
          <h2 className="pdpp-title mt-1 text-foreground">Connect an AI agent</h2>
          <p className="pdpp-caption mt-1 max-w-2xl text-muted-foreground">
            Copy the generated CLI command for agent setup. Token completion is beta-gated until the reference AS
            exposes a proven no-owner-token completion path.
          </p>
        </div>
        <span className="pdpp-eyebrow rounded-full border bg-muted/40 px-2 py-1 text-muted-foreground">
          {pdppCliPackageInfo.versionPolicy}
        </span>
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-lg border bg-muted/35 px-3 py-2">
        <code className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-foreground">
          {connectCommand}
        </code>
        <CopyButton ariaLabel="Copy PDPP CLI connect command" value={connectCommand} />
      </div>
      <p className="pdpp-caption mt-3 text-muted-foreground">
        {posture}{" "}
        {pdppCliTokenCompletionUnavailable
          ? "Current metadata must keep no-owner-token completion marked unavailable."
          : "The owner approves scoped access in the browser; no owner bearer token is pasted into the agent."}
      </p>
    </section>
  );
}
