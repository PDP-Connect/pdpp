import { createPdppCliCommand, getPdppCliPackageInfo } from "../../../../packages/cli/src/package-info.js";

export const PDPP_CLI_PROVIDER_PLACEHOLDER = "<provider-url>";
export const pdppCliPackageInfo = getPdppCliPackageInfo(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliConnectCommand = createPdppCliCommand(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliInstallCommand = `npx -y ${pdppCliPackageInfo.packageSpecifier} --help`;
export const pdppCliTokenCompletionUnavailable = pdppCliPackageInfo.noOwnerToken !== true;
export const localCollectorPackageName = "@pdpp/local-collector";
// Single release channel: the published package rides npm's default `latest`
// dist-tag, so the advertised specifier is the plain package name. Kept as a
// direct string literal (not an alias) so the owner-journey harness scanner
// can resolve it in rendered-command extraction.
export const localCollectorPackageSpecifier = "@pdpp/local-collector";

/**
 * Rewrite a canonical `pdpp ...` invocation (as advertised in dashboard/docs
 * copy) into a zero-install one-shot form using `npx -y @pdpp/cli ...`.
 * Operators who have not globally installed or workspace-linked the binary
 * still get a copy-pasteable command. Returns null when `cliCommand` does not
 * start with the `pdpp ` prefix.
 */
export function pdppCliNoInstallCommand(cliCommand: string): string | null {
  const prefix = `${pdppCliPackageInfo.binName} `;
  if (!cliCommand.startsWith(prefix)) {
    return null;
  }
  const args = cliCommand.slice(prefix.length);
  return `npx -y ${pdppCliPackageInfo.packageSpecifier} ${args}`;
}

/**
 * Render the public `pdpp connect <provider-url>` command for a specific
 * provider URL. Used by operator surfaces that already know the running
 * deployment's public origin and should not force the operator to substitute
 * the `<provider-url>` placeholder by hand.
 */
export function pdppCliConnectCommandFor(providerUrl: string): string {
  return createPdppCliCommand(providerUrl);
}

/**
 * Render the public `@pdpp/local-collector` enrollment command for a freshly
 * minted enrollment code. Operators paste this on the host that has Claude
 * Code / Codex data to exchange the one-time code for a device-scoped
 * credential. `@pdpp/cli` owns the `pdpp` binary; the runner package owns the
 * `pdpp-local-collector` binary and npx package invocation.
 */
export function pdppLocalCollectorEnrollCommand(args: {
  baseUrl: string;
  code: string;
  deviceLabel?: string | null | undefined;
}): string {
  const parts = [
    "npx",
    "-y",
    localCollectorPackageSpecifier,
    "enroll",
    "--base-url",
    args.baseUrl,
    "--code",
    args.code,
  ];
  const label = args.deviceLabel?.trim();
  if (label) {
    parts.push("--device-label", JSON.stringify(label));
  }
  return parts.join(" ");
}

/**
 * Render the public `@pdpp/local-collector` run command. The device id, device
 * token, and source instance id come from a prior enrollment response and are
 * passed as env vars so the dashboard never embeds secrets in generated
 * commands.
 */
export function pdppLocalCollectorRunCommand(args: { baseUrl: string; connectorId: string }): string {
  return [
    "npx",
    "-y",
    localCollectorPackageSpecifier,
    "run",
    "--base-url",
    args.baseUrl,
    "--connector",
    args.connectorId,
  ].join(" ");
}

/**
 * Render the monorepo-only browser-collector enrollment command. Browser-bound
 * connectors are not bundled in `@pdpp/local-collector`; the owner runs
 * this from a PDPP checkout that has `packages/polyfill-connectors`.
 */
export function pdppBrowserCollectorEnrollCommand(args: {
  baseUrl: string;
  code: string;
  deviceLabel?: string | null | undefined;
}): string {
  const parts = [
    "pnpm",
    "--dir",
    "packages/polyfill-connectors",
    "exec",
    "tsx",
    "bin/local-device-exporter.ts",
    "enroll",
    "--base-url",
    args.baseUrl,
    "--code",
    args.code,
  ];
  const label = args.deviceLabel?.trim();
  if (label) {
    parts.push("--device-label", JSON.stringify(label));
  }
  return parts.join(" ");
}

/**
 * Render the monorepo-only browser-collector run command. The placeholders are
 * the non-printing values returned by the enroll command: device id, device
 * token, and `source_instance_id` as `PDPP_CONNECTION_ID`.
 */
export function pdppBrowserCollectorRunCommand(args: { baseUrl: string; connectorId: string }): string {
  return [
    "PDPP_CAPTURE_FIXTURES=1 \\",
    `PDPP_${args.connectorId.toUpperCase()}_HEADLESS=0 \\`,
    "pnpm --dir packages/polyfill-connectors exec tsx bin/local-device-exporter.ts run \\",
    `  --base-url ${args.baseUrl} \\`,
    `  --connector ${args.connectorId} \\`,
    `  --device-id "$PDPP_LOCAL_DEVICE_ID" \\`,
    `  --device-token "$PDPP_LOCAL_DEVICE_TOKEN" \\`,
    `  --connection-id "$PDPP_CONNECTION_ID"`,
  ].join("\n");
}

/**
 * Wrap a canonical `pdpp ...` command with `pnpm exec ` so it resolves the
 * workspace-linked binary inside a PDPP monorepo checkout.
 * Returns null for non-`pdpp ` inputs so callers can fall back gracefully.
 */
export function pdppCliMonorepoCommand(cliCommand: string): string | null {
  const prefix = `${pdppCliPackageInfo.binName} `;
  if (!cliCommand.startsWith(prefix)) {
    return null;
  }
  return `pnpm exec ${cliCommand}`;
}

/**
 * Render a local-only `@pdpp/local-collector` diagnostic command
 * (`doctor` or `status`). These subcommands inspect the device-local durable
 * outbox; they take no `--base-url`, exchange no credentials, and the operator
 * runs them on the host that owns the data — so the generated string is safe
 * to display remotely. We deliberately omit `--queue` (a device-local
 * filesystem path) so the dashboard never leaks or guesses host paths; the
 * collector resolves the default queue on the device. When the connection's
 * source identity is known we scope with `--connection-id <id>`, which is a
 * non-secret stable source identity already shown elsewhere in diagnostics.
 */
function pdppLocalCollectorDiagnosticCommand(
  subcommand: "doctor" | "status",
  args?: { connectionId?: string | null | undefined }
): string {
  const parts = ["npx", "-y", localCollectorPackageSpecifier, subcommand];
  const connectionId = args?.connectionId?.trim();
  if (connectionId) {
    parts.push("--connection-id", connectionId);
  }
  return parts.join(" ");
}

/**
 * Render the public `@pdpp/local-collector doctor` command. `doctor`
 * prints operator-facing durable-outbox diagnostics (expired leases, dead
 * letters, missing DB) as JSON. This is the command an owner runs on the
 * local collector host when the dashboard shows the outbox as stalled.
 */
export function pdppLocalCollectorDoctorCommand(args?: { connectionId?: string | null | undefined }): string {
  return pdppLocalCollectorDiagnosticCommand("doctor", args);
}

/**
 * Render the public `@pdpp/local-collector status` command. `status`
 * prints the raw durable-outbox health snapshot (queue counts, oldest pending,
 * expired leases) as JSON.
 */
export function pdppLocalCollectorStatusCommand(args?: { connectionId?: string | null | undefined }): string {
  return pdppLocalCollectorDiagnosticCommand("status", args);
}

/**
 * Render the public `@pdpp/local-collector retry-dead-letters` command.
 * This is the *recovery* primitive (shipped in `94afba46` / `63a4eec5`): it
 * requeues dead-letter outbox rows so a stalled local collector can drain. The
 * doctor command only diagnoses; this is the command that actually fixes a
 * stalled outbox, so the remediation surface must name it, not just `doctor`.
 *
 * It is safe to render remotely for the same reasons as `doctor`/`status`: it
 * runs on the host that owns the data, takes no `--base-url`, exchanges no
 * credentials, and we deliberately omit `--queue` (a device-local filesystem
 * path) so the dashboard never leaks or guesses host paths.
 *
 * The command is dry-run by default — pass `{ apply: true }` to render the
 * `--apply` variant that mutates after an automatic DB backup. The two-step
 * preview-then-apply flow matches the CLI's own help and the doctor remediation
 * hint, so the operator runs exactly what the collector documents.
 */
export function pdppLocalCollectorRetryDeadLettersCommand(args?: {
  apply?: boolean;
  connectionId?: string | null | undefined;
}): string {
  const parts = ["npx", "-y", localCollectorPackageSpecifier, "retry-dead-letters"];
  const connectionId = args?.connectionId?.trim();
  if (connectionId) {
    parts.push("--connection-id", connectionId);
  }
  if (args?.apply) {
    parts.push("--apply");
  }
  return parts.join(" ");
}

export const pdppCliCollectorEnrollCommand = pdppLocalCollectorEnrollCommand;
export const pdppCliCollectorRunCommand = pdppLocalCollectorRunCommand;
export const pdppCliCollectorDoctorCommand = pdppLocalCollectorDoctorCommand;
export const pdppCliCollectorStatusCommand = pdppLocalCollectorStatusCommand;
export const pdppCliCollectorRetryDeadLettersCommand = pdppLocalCollectorRetryDeadLettersCommand;
