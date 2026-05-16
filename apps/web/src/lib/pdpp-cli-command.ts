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
