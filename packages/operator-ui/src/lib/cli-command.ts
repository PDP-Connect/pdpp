// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The narrow slice of public `pdpp` CLI command helpers that the SHARED
 * dashboard feature components need (`ConnectAgentCard`, `Peek`,
 * `TimelineDetailView`). The apps keep their own fuller `@/lib/pdpp-cli-command`
 * for non-dashboard surfaces and the live local-collector enroll/run/doctor
 * commands; only these five symbols cross into shared components, so only these
 * live in the package.
 *
 * `@pdpp/cli`'s package identity/specifier constants used to live in
 * `packages/cli/src/package-info.ts` and were imported from here via a
 * relative path. That package moved to PDP-Connect/data-connect (Move B);
 * this repo no longer has a local copy to import. `@pdpp/cli` is still a
 * real, separately-published npm package (only its source moved), so the
 * small, pure identity constants below are vendored directly here instead
 * of reached for across a repo boundary — the same pattern
 * `packages/reference-operations-sandbox` uses for the reference
 * operations `apps/site` depends on.
 */

const PDPP_CLI_PACKAGE_NAME = "@pdpp/cli";
const PDPP_CLI_BIN_NAME = "pdpp";
// Single release channel: the published package rides npm's default
// `latest` dist-tag, so the advertised specifier is the plain package name.
const PDPP_CLI_PACKAGE_SPECIFIER = PDPP_CLI_PACKAGE_NAME;
const PDPP_CLI_DEFAULT_CLIENT_ID = "pdpp_cli";
const PDPP_CLI_NO_OWNER_TOKEN_POLICY = "owner_browser_approval_required";

interface PdppCliPackageInfo {
  binName: string;
  defaultClientId: "pdpp_cli";
  noOwnerToken: true;
  noOwnerTokenPolicy: "owner_browser_approval_required";
  packageName: string;
  packageSpecifier: string;
  runCommand: string;
  versionPolicy: "latest";
}

function createPdppCliCommand(providerUrl = "<provider-url>"): string {
  return `npx -y ${PDPP_CLI_PACKAGE_SPECIFIER} connect ${providerUrl}`;
}

function getPdppCliPackageInfo(providerUrl?: string): PdppCliPackageInfo {
  return {
    packageName: PDPP_CLI_PACKAGE_NAME,
    packageSpecifier: PDPP_CLI_PACKAGE_SPECIFIER,
    binName: PDPP_CLI_BIN_NAME,
    defaultClientId: PDPP_CLI_DEFAULT_CLIENT_ID,
    versionPolicy: "latest",
    runCommand: createPdppCliCommand(providerUrl),
    noOwnerToken: true,
    noOwnerTokenPolicy: PDPP_CLI_NO_OWNER_TOKEN_POLICY,
  };
}

export const PDPP_CLI_PROVIDER_PLACEHOLDER = "<provider-url>";
export const pdppCliPackageInfo = getPdppCliPackageInfo(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliConnectCommand = createPdppCliCommand(PDPP_CLI_PROVIDER_PLACEHOLDER);
export const pdppCliTokenCompletionUnavailable = pdppCliPackageInfo.noOwnerToken !== true;

/**
 * Rewrite a canonical `pdpp ...` invocation (as advertised in dashboard/docs
 * copy) into a zero-install one-shot form using `npx -y @pdpp/cli ...`.
 * Returns null when `cliCommand` does not start with the `pdpp ` prefix.
 */
export function pdppCliNoInstallCommand(cliCommand: string): string | null {
  const prefix = `${pdppCliPackageInfo.binName} `;
  if (!cliCommand.startsWith(prefix)) {
    return null;
  }
  const args = cliCommand.slice(prefix.length);
  return `npx -y ${pdppCliPackageInfo.packageSpecifier} ${args}`;
}

export function pdppCliConnectCommandFor(providerUrl: string): string {
  return createPdppCliCommand(providerUrl);
}
