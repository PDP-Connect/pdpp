export const PDPP_CLI_PACKAGE_NAME = '@pdpp/cli';
export const PDPP_CLI_BIN_NAME = 'pdpp';
export const PDPP_CLI_VERSION_POLICY = 'beta';
export const PDPP_CLI_PACKAGE_SPECIFIER = `${PDPP_CLI_PACKAGE_NAME}@${PDPP_CLI_VERSION_POLICY}`;

export function createPdppCliCommand(providerUrl = '<provider-url>') {
  return `npx -y ${PDPP_CLI_PACKAGE_SPECIFIER} connect ${providerUrl}`;
}

export function getPdppCliPackageInfo(providerUrl) {
  return {
    packageName: PDPP_CLI_PACKAGE_NAME,
    packageSpecifier: PDPP_CLI_PACKAGE_SPECIFIER,
    binName: PDPP_CLI_BIN_NAME,
    versionPolicy: PDPP_CLI_VERSION_POLICY,
    runCommand: createPdppCliCommand(providerUrl),
    noOwnerToken: true,
  };
}
