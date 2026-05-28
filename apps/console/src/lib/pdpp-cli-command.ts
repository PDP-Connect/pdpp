import { createPdppCliCommand, getPdppCliPackageInfo } from "../../../../packages/cli/src/package-info.js";

export const PDPP_CLI_PROVIDER_PLACEHOLDER = "<provider-url>";
export const pdppCliPackageInfo = getPdppCliPackageInfo(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliConnectCommand = createPdppCliCommand(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliInstallCommand = `npx -y ${pdppCliPackageInfo.packageSpecifier} --help`;
export const pdppCliTokenCompletionUnavailable = pdppCliPackageInfo.noOwnerToken !== true;
export const localCollectorPackageName = "@pdpp/local-collector";
export const localCollectorPackageSpecifier = `${localCollectorPackageName}@beta`;

/**
 * Rewrite a canonical `pdpp ...` invocation (as advertised in dashboard/docs
 * copy) into a zero-install one-shot form using `npx -y @pdpp/cli@beta ...`.
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
 * Render the public `@pdpp/local-collector@beta` enrollment command for a freshly
 * minted enrollment code. Operators paste this on the host that has Claude
 * Code / Codex data to exchange the one-time code for a device-scoped
 * credential. `@pdpp/cli` owns the `pdpp` binary; the runner package owns the
 * `pdpp-local-collector` binary and npx package invocation. Keep the beta tag
 * until the package's npm latest tag is intentionally promoted.
 */
export function pdppLocalCollectorEnrollCommand(args: {
  baseUrl: string;
  code: string;
  deviceLabel?: string | null | undefined;
}): string {
  const parts = ["npx", "-y", localCollectorPackageSpecifier, "enroll", "--base-url", args.baseUrl, "--code", args.code];
  const label = args.deviceLabel?.trim();
  if (label) {
    parts.push("--device-label", JSON.stringify(label));
  }
  return parts.join(" ");
}

/**
 * Render the public `@pdpp/local-collector@beta` run command. The device id, device
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

export const pdppCliCollectorEnrollCommand = pdppLocalCollectorEnrollCommand;
export const pdppCliCollectorRunCommand = pdppLocalCollectorRunCommand;
