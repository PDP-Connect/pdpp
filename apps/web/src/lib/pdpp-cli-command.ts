import {
  createPdppCliCommand,
  getPdppCliPackageInfo,
} from "../../../../packages/cli/src/package-info.js";

export const PDPP_CLI_PROVIDER_PLACEHOLDER = "<provider-url>";
export const pdppCliPackageInfo = getPdppCliPackageInfo(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliConnectCommand = createPdppCliCommand(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliInstallCommand = `npx -y ${pdppCliPackageInfo.packageSpecifier} --help`;
export const pdppCliTokenCompletionUnavailable = pdppCliPackageInfo.noOwnerToken !== true;
