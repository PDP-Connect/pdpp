// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const PDPP_CLI_PACKAGE_NAME = "@pdpp/cli";
export const PDPP_CLI_BIN_NAME = "pdpp";
// Single release channel: the published package rides npm's default `latest`
// dist-tag, so the advertised specifier is the plain package name.
export const PDPP_CLI_VERSION_POLICY = "latest";
export const PDPP_CLI_PACKAGE_SPECIFIER = PDPP_CLI_PACKAGE_NAME;
export const PDPP_CLI_DEFAULT_CLIENT_ID = "pdpp_cli";
export const PDPP_CLI_NO_OWNER_TOKEN_POLICY = "owner_browser_approval_required";

export function createPdppCliCommand(providerUrl = "<provider-url>") {
  return `npx -y ${PDPP_CLI_PACKAGE_SPECIFIER} connect ${providerUrl}`;
}

export function getPdppCliPackageInfo(providerUrl) {
  return {
    binName: PDPP_CLI_BIN_NAME,
    defaultClientId: PDPP_CLI_DEFAULT_CLIENT_ID,
    noOwnerToken: true,
    noOwnerTokenPolicy: PDPP_CLI_NO_OWNER_TOKEN_POLICY,
    packageName: PDPP_CLI_PACKAGE_NAME,
    packageSpecifier: PDPP_CLI_PACKAGE_SPECIFIER,
    runCommand: createPdppCliCommand(providerUrl),
    versionPolicy: PDPP_CLI_VERSION_POLICY,
  };
}
