export const PDPP_CLI_PACKAGE_NAME: string;
export const PDPP_CLI_BIN_NAME: string;
export const PDPP_CLI_VERSION_POLICY: "latest";
export const PDPP_CLI_PACKAGE_SPECIFIER: string;
export const PDPP_CLI_DEFAULT_CLIENT_ID: "pdpp_cli";
export const PDPP_CLI_NO_OWNER_TOKEN_POLICY: "owner_browser_approval_required";

export interface PdppCliPackageInfo {
  packageName: string;
  packageSpecifier: string;
  binName: string;
  defaultClientId: "pdpp_cli";
  versionPolicy: "latest";
  runCommand: string;
  noOwnerToken: true;
  noOwnerTokenPolicy: "owner_browser_approval_required";
}

export function createPdppCliCommand(providerUrl?: string): string;
export function getPdppCliPackageInfo(providerUrl?: string): PdppCliPackageInfo;
