import { createPdppCliCommand, getPdppCliPackageInfo } from "../../../../packages/cli/src/package-info.js";

export const PDPP_CLI_PROVIDER_PLACEHOLDER = "<provider-url>";
export const pdppCliPackageInfo = getPdppCliPackageInfo(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliConnectCommand = createPdppCliCommand(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliInstallCommand = `npx -y ${pdppCliPackageInfo.packageSpecifier} --help`;
export const pdppCliTokenCompletionUnavailable = pdppCliPackageInfo.noOwnerToken !== true;

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
 * Render a canonical `pdpp collector enroll` command for a freshly minted
 * enrollment code. Operators paste this on the host that has Claude Code /
 * Codex data to exchange the one-time code for a device-scoped credential.
 *
 * The collector runner currently requires a PDPP monorepo checkout — the
 * @pdpp/cli npm tarball ships a fail-fast shim that points back here. See
 * openspec/changes/introduce-local-collector-runner/design.md
 * § "Distribution follow-up". The returned command is the canonical
 * `pdpp collector enroll ...` form; consumers may wrap it with
 * `pnpm exec ` when surfacing the monorepo flow.
 */
export function pdppCliCollectorEnrollCommand(args: {
  baseUrl: string;
  code: string;
  deviceLabel?: string | null | undefined;
}): string {
  const parts = [pdppCliPackageInfo.binName, "collector", "enroll", "--base-url", args.baseUrl, "--code", args.code];
  const label = args.deviceLabel?.trim();
  if (label) {
    parts.push("--device-label", JSON.stringify(label));
  }
  return parts.join(" ");
}

/**
 * Render a canonical `pdpp collector run` command. The device id, device
 * token, and source instance id come from a prior `pdpp collector enroll`
 * JSON response and are passed as env vars so they do not appear in shell
 * history. Used by the dashboard enrollment surface to give operators a
 * single copy-pasteable command per supported connector.
 */
export function pdppCliCollectorRunCommand(args: { baseUrl: string; connectorId: string }): string {
  return [
    pdppCliPackageInfo.binName,
    "collector",
    "run",
    "--base-url",
    args.baseUrl,
    "--connector",
    args.connectorId,
  ].join(" ");
}

/**
 * Wrap a canonical `pdpp ...` command with `pnpm exec ` so it resolves the
 * workspace-linked binary inside a PDPP monorepo checkout. The collector
 * runner is not currently distributed via npm, so the monorepo form is the
 * supported invocation path today (see runner.js for the fail-fast shim).
 * Returns null for non-`pdpp ` inputs so callers can fall back gracefully.
 */
export function pdppCliMonorepoCommand(cliCommand: string): string | null {
  const prefix = `${pdppCliPackageInfo.binName} `;
  if (!cliCommand.startsWith(prefix)) {
    return null;
  }
  return `pnpm exec ${cliCommand}`;
}
