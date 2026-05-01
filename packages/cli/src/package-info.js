export const PDPP_CLI_PACKAGE_NAME = '@pdpp/cli';
export const PDPP_CLI_BIN_NAME = 'pdpp';
export const PDPP_CLI_VERSION_POLICY = 'beta';
export const PDPP_CLI_PACKAGE_SPECIFIER = `${PDPP_CLI_PACKAGE_NAME}@${PDPP_CLI_VERSION_POLICY}`;
export const PDPP_CLI_DEFAULT_CLIENT_ID = 'pdpp_cli';
export const PDPP_CLI_NO_OWNER_TOKEN_POLICY = 'owner_browser_approval_required';

export function createPdppCliCommand(providerUrl = '<provider-url>') {
  return `npx -y ${PDPP_CLI_PACKAGE_SPECIFIER} connect ${providerUrl}`;
}

export function getPdppCliPackageInfo(providerUrl) {
  return {
    packageName: PDPP_CLI_PACKAGE_NAME,
    packageSpecifier: PDPP_CLI_PACKAGE_SPECIFIER,
    binName: PDPP_CLI_BIN_NAME,
    defaultClientId: PDPP_CLI_DEFAULT_CLIENT_ID,
    versionPolicy: PDPP_CLI_VERSION_POLICY,
    runCommand: createPdppCliCommand(providerUrl),
    noOwnerToken: true,
    noOwnerTokenPolicy: PDPP_CLI_NO_OWNER_TOKEN_POLICY,
  };
}
