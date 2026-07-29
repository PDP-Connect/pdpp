// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const PDPP_CLI_PACKAGE_NAME: string;
export const PDPP_CLI_BIN_NAME: string;
export const PDPP_CLI_VERSION_POLICY: "latest";
export const PDPP_CLI_PACKAGE_SPECIFIER: string;
export const PDPP_CLI_DEFAULT_CLIENT_ID: "pdpp_cli";
export const PDPP_CLI_NO_OWNER_TOKEN_POLICY: "owner_browser_approval_required";

export interface PdppCliPackageInfo {
  binName: string;
  defaultClientId: "pdpp_cli";
  noOwnerToken: true;
  noOwnerTokenPolicy: "owner_browser_approval_required";
  packageName: string;
  packageSpecifier: string;
  runCommand: string;
  versionPolicy: "latest";
}

export function createPdppCliCommand(providerUrl?: string): string;
export function getPdppCliPackageInfo(providerUrl?: string): PdppCliPackageInfo;
