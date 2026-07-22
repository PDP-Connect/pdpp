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
 * Source of truth for the package identity/specifier is `@pdpp/cli`'s
 * `package-info.js`, imported the same relative way the apps do (the apps do
 * not declare `@pdpp/cli` as a named dependency; it resolves through the
 * workspace via this relative path).
 */
import { createPdppCliCommand, getPdppCliPackageInfo } from "../../../cli/src/package-info.js";

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
