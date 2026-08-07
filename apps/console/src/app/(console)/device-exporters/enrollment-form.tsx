"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcInput } from "@pdpp/brand-react";
import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { Callout, ToolbarField } from "@pdpp/operator-ui/components/primitives";
import { useActionState, useState } from "react";
import {
  pdppLocalCollectorEnrollCommand,
  pdppLocalCollectorRunCommand,
  pdppLocalCollectorSetupCommand,
} from "@/lib/pdpp-cli-command.ts";
import { createEnrollmentCodeAction } from "./actions.ts";

const COLLECTOR_RUN_CONNECTORS = ["claude_code", "codex", "imessage"] as const;
const SETUP_SAMPLE_SIZE = 20;
const MACOS_ONLY_LOCAL_COLLECTOR_CONNECTORS = ["imessage"] as const;

function isMacosOnlyLocalCollectorConnector(connectorId: string): boolean {
  return (MACOS_ONLY_LOCAL_COLLECTOR_CONNECTORS as readonly string[]).includes(connectorId);
}

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
  const [showAdvanced, setShowAdvanced] = useState(false);

  let setupCommand: string | null = null;
  let enrollCommand: string | null = null;
  let isMacosOnly = false;
  if (state.ok === true) {
    isMacosOnly = isMacosOnlyLocalCollectorConnector(state.code.connector_id);
    setupCommand = pdppLocalCollectorSetupCommand({
      baseUrl: referenceBaseUrl,
      code: state.code.enrollment_code,
      connectorId: state.code.connector_id,
      deviceLabel: state.deviceLabel,
      sample: SETUP_SAMPLE_SIZE,
    });
    enrollCommand = pdppLocalCollectorEnrollCommand({
      baseUrl: referenceBaseUrl,
      code: state.code.enrollment_code,
      deviceLabel: state.deviceLabel,
    });
  }

  return (
    <Callout
      description="Create a short-lived enrollment code for a local collector. This links the collector to this server and is separate from PDPP Core/Profile protocol controls."
      surface="human"
      title="Create enrollment code"
    >
      <form action={formAction} className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
        <ToolbarField label="Connector id">
          <IcInput defaultValue={defaultConnectorId} name="connector_id" placeholder="claude_code" required />
        </ToolbarField>
        <ToolbarField label="Local binding">
          <IcInput name="local_binding_name" placeholder="personal-laptop" required />
        </ToolbarField>
        <ToolbarField label="Display name">
          <IcInput name="display_name" placeholder="the owner's laptop" />
        </ToolbarField>
        <input name="expires_in_seconds" type="hidden" value="900" />
        <IcButton disabled={pending} type="submit">
          {pending ? "Creating..." : "Create code"}
        </IcButton>
      </form>

      {state.ok === false ? <p className="pdpp-caption mt-3 text-destructive">{state.message}</p> : null}
      {state.ok === true && setupCommand && enrollCommand ? (
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

          {isMacosOnly ? (
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
              data-testid="collector-macos-requirements"
            >
              <p className="pdpp-caption text-foreground">
                <strong>Requires a physical Mac.</strong> iMessage reads{" "}
                <code className="font-mono">~/Library/Messages/chat.db</code>, which only exists on macOS &mdash; this
                cannot run on Linux/Windows or in a container. It also needs{" "}
                <strong>Full Disk Access</strong> for the terminal (or Node binary) running the command: System
                Settings &rarr; Privacy &amp; Security &rarr; Full Disk Access &rarr; enable your terminal app, then
                restart it. Without Full Disk Access, chat.db reads fail with a permissions error even though the
                file path is correct.
              </p>
            </div>
          ) : null}

          <div>
            <div className="pdpp-eyebrow text-muted-foreground">Set up the device that has the data</div>
            <p className="pdpp-caption mt-1 text-muted-foreground">
              Run this <code className="font-mono">@pdpp/local-collector</code> command on the device with the data
              (Claude Code, Codex, or iMessage). It exchanges the code, saves your device credentials to a local file
              only you can read (never printed here or in your terminal), and runs a bounded {SETUP_SAMPLE_SIZE}-record
              proof pass so you can see it working before it collects everything.
            </p>
            <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
              <code
                className="pdpp-caption min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-foreground"
                data-testid="collector-setup-command"
              >
                {setupCommand}
              </code>
              <CopyButton ariaLabel="Copy @pdpp/local-collector setup command" value={setupCommand} />
            </div>
            <p className="pdpp-caption mt-2 text-muted-foreground">
              When that finishes, it prints the exact <code className="font-mono">run</code> command to collect the full
              source &mdash; credentials are picked up automatically, no values to copy by hand.
            </p>
          </div>

          <div>
            <button
              className="pdpp-caption text-foreground underline underline-offset-2"
              onClick={() => setShowAdvanced((prev) => !prev)}
              type="button"
            >
              {showAdvanced ? "Hide" : "Show"} advanced / scriptable commands
            </button>
            {showAdvanced ? (
              <div className="mt-3 space-y-3">
                <div>
                  <div className="pdpp-eyebrow text-muted-foreground">1. Enroll the device (prints raw JSON)</div>
                  <p className="pdpp-caption mt-1 text-muted-foreground">
                    Exchanges the code for a credential and prints it as JSON instead of saving a profile file &mdash;
                    for scripts that manage credentials themselves. The response returns{" "}
                    <code className="font-mono">device_id</code>, <code className="font-mono">device_token</code>, and{" "}
                    <code className="font-mono">source_instance_id</code> &mdash; save all three, and never log the
                    token.
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
                  <div className="pdpp-eyebrow text-muted-foreground">2. Start collection with explicit env vars</div>
                  <p className="pdpp-caption mt-1 text-muted-foreground">
                    Use the three values from the enrollment response. The collector resumes from its saved state, so
                    running it again is safe.
                  </p>
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
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Callout>
  );
}
