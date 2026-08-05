// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Standing links and license facts, declared once so no page hand-types them.
// The owner's rule for this pass: anything that can go stale must be wired so
// it cannot. These are the values that appear on more than one surface.

export const GITHUB_REPO_URL = "https://github.com/PDP-Connect/pdpp";
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPO_URL}/issues/new`;
export const GITHUB_MAINTAINERS_URL = `${GITHUB_REPO_URL}/blob/main/MAINTAINERS.md`;

/** A `blob/main/<path>` link into the repo, e.g. a source file or test. */
export function repoBlobUrl(repoRelativePath: string): string {
  return `${GITHUB_REPO_URL}/blob/main/${repoRelativePath}`;
}

// The LFDT lab channel invite. discord.gg/hyperledger reaches the whole LFDT
// server; this one drops the visitor directly into #pdp-connect, which is the
// invite the owner said to prefer.
export const DISCORD_INVITE_URL = "https://discord.gg/FV4bkZBdmA";

// Specification text FIRST — explicit owner instruction. Each row states which
// artifact the license covers and links the license text, because the footer
// previously listed bare unlinked identifiers.
//
// SOURCE OF TRUTH: the repo-root LICENSE files and REUSE.toml. See
// scripts/pdpp-concept-facts.test.ts, which fails if the SPDX identifiers here
// stop matching the LICENSE files on disk — so this list cannot silently drift
// from the licenses the repository actually carries.
export const SITE_LICENSES = [
  {
    artifact: "Specification text",
    href: "https://github.com/CommunitySpecification/1.0",
    // LICENSE-specs states "Community Specification License 1.0"; REUSE.toml
    // tags the spec files LicenseRef-CSL-1.0. CSL-1.0 is the short form the
    // site shows.
    spdx: "CSL-1.0",
  },
  {
    artifact: "Reference implementation",
    href: "https://www.apache.org/licenses/LICENSE-2.0",
    spdx: "Apache-2.0",
  },
  {
    artifact: "Documentation",
    href: "https://creativecommons.org/licenses/by/4.0/legalcode",
    spdx: "CC-BY-4.0",
  },
] as const;
