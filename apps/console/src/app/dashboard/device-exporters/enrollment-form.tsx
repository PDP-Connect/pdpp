"use client";

import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { Callout, ToolbarField } from "@pdpp/operator-ui/components/primitives";
import { useActionState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import {
  pdppBrowserCollectorEnrollCommand,
  pdppBrowserCollectorRunCommand,
  pdppLocalCollectorEnrollCommand,
  pdppLocalCollectorRunCommand,
} from "@/lib/pdpp-cli-command.ts";
import { BROWSER_BOUND_RUNBOOK_PATH, isSupportedBrowserCollectorConnector } from "../lib/connection-modality.ts";
import { createEnrollmentCodeAction } from "./actions.ts";

const COLLECTOR_RUN_CONNECTORS = ["claude_code", "codex"] as const;

export function EnrollmentForm({
  referenceBaseUrl,
  defaultConnectorId,
}: {
  referenceBaseUrl: string;
  /**
   * Optional connector key to prefill the `connector_id` field. The Connect
   * "Add source" entry point deep-links here with `?connector=claude_code`
   * (or `codex`) so the supported-connector path is a real, ready-to-submit flow
   * rather than landing the owner on an empty form. The page validates the value
   * against the supported set before passing it; an unsupported/absent value
   * leaves the field empty.
   */
  defaultConnectorId?: string;
}) {
  const [state, formAction, pending] = useActionState(createEnrollmentCodeAction, { ok: null });

  const isBrowserCollectorCode = state.ok === true && isSupportedBrowserCollectorConnector(state.code.connector_id);
  let enrollCommand: string | null = null;
  if (state.ok === true) {
    enrollCommand = isBrowserCollectorCode
      ? pdppBrowserCollectorEnrollCommand({
          baseUrl: referenceBaseUrl,
          code: state.code.enrollment_code,
          deviceLabel: state.deviceLabel,
        })
      : pdppLocalCollectorEnrollCommand({
          baseUrl: referenceBaseUrl,
          code: state.code.enrollment_code,
          deviceLabel: state.deviceLabel,
        });
  }

  return (
    <Callout
      description="Creates a short-lived reference-experimental enrollment code for a local exporter agent. This is not a PDPP Core/Profile protocol control."
      surface="human"
      title="Create enrollment code"
    >
      <form action={formAction} className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
        <ToolbarField label="Connector id">
          <Input defaultValue={defaultConnectorId} name="connector_id" placeholder="claude_code" required />
        </ToolbarField>
        <ToolbarField label="Local binding">
          <Input name="local_binding_name" placeholder="personal-laptop" required />
        </ToolbarField>
        <ToolbarField label="Display name">
          <Input name="display_name" placeholder="the owner's laptop" />
        </ToolbarField>
        <input name="expires_in_seconds" type="hidden" value="900" />
        <Button disabled={pending} type="submit">
          {pending ? "Creating..." : "Create code"}
        </Button>
      </form>

      {state.ok === false ? <p className="pdpp-caption mt-3 text-destructive">{state.message}</p> : null}
      {state.ok === true && enrollCommand ? (
        <div className="mt-4 space-y-3 rounded-md border border-border/80 bg-background/60 p-3">
          <div>
            <div className="pdpp-eyebrow text-muted-foreground">Enrollment code</div>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <code className="pdpp-body min-w-0 break-all font-mono text-foreground">
                {state.code.enrollment_code}
              </code>
              <CopyButton ariaLabel="Copy enrollment code" value={state.code.enrollment_code} />
            </div>
            <p className="pdpp-caption mt-1 text-muted-foreground">Expires at {state.code.expires_at}</p>
          </div>

          <div>
            <div className="pdpp-eyebrow text-muted-foreground">1. Enroll the host that has the data</div>
            <p className="pdpp-caption mt-1 text-muted-foreground">
              {isBrowserCollectorCode ? (
                <>
                  Run this from a PDPP monorepo checkout on the host with the logged-in browser profile. The JSON
                  response returns the device credentials plus <code className="font-mono">source_instance_id</code> and{" "}
                  <code className="font-mono">connector_instance_id</code>; persist them without logging the token.
                </>
              ) : (
                <>
                  Run this <code className="font-mono">@pdpp/local-collector@beta</code> command on the host with Claude
                  Code or Codex data. It uses the npx-launched <code className="font-mono">pdpp-local-collector</code>{" "}
                  binary; no PDPP monorepo checkout is required. The JSON response returns{" "}
                  <code className="font-mono">device_id</code>, <code className="font-mono">device_token</code>, and{" "}
                  <code className="font-mono">source_instance_id</code> &mdash; persist all three without logging the
                  token.
                </>
              )}
            </p>
            <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
              <code
                className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-foreground"
                data-testid="collector-enroll-command"
              >
                {enrollCommand}
              </code>
              <CopyButton ariaLabel="Copy @pdpp/local-collector enroll command" value={enrollCommand} />
            </div>
          </div>

          <div>
            <div className="pdpp-eyebrow text-muted-foreground">
              {isBrowserCollectorCode ? "2. Run the browser connector" : "2. Run a connector pass"}
            </div>
            <p className="pdpp-caption mt-1 text-muted-foreground">
              {isBrowserCollectorCode ? (
                <>
                  Replace the placeholders with values from the enrollment response. This is still an owner-run browser
                  proof path, not a one-click console flow; keep provider login and 2FA local. Full procedure:{" "}
                  <code className="pdpp-eyebrow font-mono text-foreground">{BROWSER_BOUND_RUNBOOK_PATH}</code>.
                </>
              ) : (
                <>
                  Replace the three placeholders with values from the enrollment response. The command resumes from
                  prior connector state via the device-scoped STATE route (see{" "}
                  <code className="font-mono">design-local-collector-state-sync</code>) &mdash; re-running is safe.
                </>
              )}
            </p>
            {isBrowserCollectorCode ? (
              <BrowserCollectorRunCommand connectorId={state.code.connector_id} referenceBaseUrl={referenceBaseUrl} />
            ) : (
              <div className="mt-2 space-y-2">
                {COLLECTOR_RUN_CONNECTORS.map((connectorId) => {
                  const runCommand = pdppLocalCollectorRunCommand({ baseUrl: referenceBaseUrl, connectorId });
                  const fullCommand = [
                    "PDPP_LOCAL_DEVICE_ID=<device_id> \\",
                    "PDPP_LOCAL_DEVICE_TOKEN=<device_token> \\",
                    "PDPP_CONNECTION_ID=<source_instance_id> \\",
                    runCommand,
                  ].join("\n");
                  return (
                    <div className="rounded-md border border-border/70 bg-muted/30 p-3" key={connectorId}>
                      <div className="flex min-w-0 items-baseline justify-between gap-2">
                        <div className="pdpp-caption text-muted-foreground">
                          <code className="font-mono">{connectorId}</code>
                        </div>
                        <CopyButton
                          ariaLabel={`Copy @pdpp/local-collector run command for ${connectorId}`}
                          value={fullCommand}
                        />
                      </div>
                      <pre
                        className="pdpp-caption mt-2 min-w-0 overflow-x-auto whitespace-pre font-mono text-foreground"
                        data-testid={`collector-run-command-${connectorId}`}
                      >
                        {fullCommand}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Callout>
  );
}

function BrowserCollectorRunCommand({
  connectorId,
  referenceBaseUrl,
}: {
  connectorId: string;
  referenceBaseUrl: string;
}) {
  const runCommand = pdppBrowserCollectorRunCommand({ baseUrl: referenceBaseUrl, connectorId });
  return (
    <div className="mt-2 rounded-md border border-border/70 bg-muted/30 p-3">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <div className="pdpp-caption text-muted-foreground">
          <code className="font-mono">{connectorId}</code> browser_collector
        </div>
        <CopyButton ariaLabel={`Copy browser-collector run command for ${connectorId}`} value={runCommand} />
      </div>
      <pre
        className="pdpp-caption mt-2 min-w-0 overflow-x-auto whitespace-pre font-mono text-foreground"
        data-testid={`browser-collector-run-command-${connectorId}`}
      >
        {runCommand}
      </pre>
    </div>
  );
}
