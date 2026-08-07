// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Suspense } from "react";
import { cn } from "@/lib/utils.ts";
import { ColorSchemeMenu } from "./color-scheme-menu.tsx";
import { DiscordIcon, GithubIcon } from "./icons.tsx";
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, SITE_LICENSES } from "./site-facts.ts";
import { Text } from "./text.tsx";

const GITHUB_URL_SCHEME_RE = /^https?:\/\//;
const githubDisplayText = GITHUB_REPO_URL.replace(GITHUB_URL_SCHEME_RE, "");

// ONE footer, identical on every page. The owner's finding was that the footer
// differed on all four pages; the fix is a single component that takes no
// per-page props, so there is no seam where they can diverge again.
//
// Column order and content are load-bearing:
//   LICENSE     — all three licenses LINKED and LABELLED by the artifact they
//                 cover, specification text FIRST (explicit owner instruction).
//   SOURCE      — the repository, with the GitHub mark.
//   COMMUNITY   — Discord. Named for the category, not the product: LICENSE /
//                 SOURCE / GOVERNANCE all name a kind of information, and the
//                 link text underneath already says "Discord". COMMUNITY is
//                 also the dominant convention (Docusaurus's default footer
//                 scaffold, reused by vercel.com) and absorbs a forum or a
//                 mailing list later without a rename.
//   GOVERNANCE  — the LFDT lab line.
//
// Four columns exactly, on all four pages. A fifth was tried during the concept
// pass and reverted: it wrapped to a second row at 1280px.
//
// Type via Text; column rhythm via flex gap (footer is outside .pdpp-doc —
// no prose p margin to zero).
// License rows stay a dl — leave .pdpp-doc table / .pdpp-impl-table alone.
// `pdpp-footer` remains a ::selection cascade hook on teal-deep grounds.

const footerLinkClassName = cn(
  "text-on-primary-emphasis! no-underline",
  "border-on-primary-emphasis/30 border-b border-solid",
  "hover:border-on-primary-emphasis hover:text-white!",
  "focus-visible:border-on-primary-emphasis focus-visible:text-white!"
);

const colClassName = "flex max-w-[34ch] flex-col gap-1.5";

export function PdppConceptFooter() {
  return (
    <footer
      className={cn(
        "pdpp-footer",
        "mt-24 font-sans text-[13px] text-on-primary-emphasis-soft leading-[1.7]",
        "border-[color-mix(in_srgb,var(--primary)_55%,transparent)] border-t",
        "bg-primary-emphasis"
      )}
      data-slot="pdpp-concept-footer"
    >
      <div
        className={cn(
          // Same measure as masthead / PdppConceptPage
          "container max-w-page",
          // Stack by default; four-col row from 721px (concept surface omits md: theme)
          "flex flex-col gap-6 py-8",
          "min-[721px]:flex-row min-[721px]:flex-wrap min-[721px]:justify-between min-[721px]:gap-x-16 min-[721px]:gap-y-8 min-[721px]:pt-10 min-[721px]:pb-24"
        )}
      >
        <div className={cn(colClassName, "max-w-[40ch] tabular-nums")}>
          <Text color="onAccentLabel" size="stamp" weight="normal">
            License
          </Text>
          <dl className="m-0 flex flex-col gap-0.5 tabular-nums">
            {SITE_LICENSES.map((row) => (
              <div className="flex gap-1.5 whitespace-nowrap" key={row.artifact}>
                <dt className="m-0 opacity-75">{row.artifact}:</dt>
                <dd className="m-0">
                  <a className={footerLinkClassName} href={row.href} rel="noopener noreferrer" target="_blank">
                    {row.spdx}
                  </a>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <div className={colClassName}>
          <Text color="onAccentLabel" size="stamp" weight="normal">
            Source
          </Text>
          <Text
            as="a"
            className={footerLinkClassName}
            color="onAccent"
            href={GITHUB_REPO_URL}
            rel="noopener noreferrer"
            size="inherit"
            target="_blank"
            withIcon
          >
            <GithubIcon />
            {githubDisplayText}
          </Text>
        </div>

        <div className={colClassName}>
          <Text color="onAccentLabel" size="stamp" weight="normal">
            Community
          </Text>
          <Text
            as="a"
            className={footerLinkClassName}
            color="onAccent"
            href={DISCORD_INVITE_URL}
            rel="noopener noreferrer"
            size="inherit"
            target="_blank"
            withIcon
          >
            <DiscordIcon />
            #pdp-connect on LFDT Discord
          </Text>
        </div>

        <div className={colClassName}>
          <Text color="onAccentLabel" size="stamp" weight="normal">
            Governance
          </Text>
          <Text color="onAccentSoft" size="inherit">
            PDP-Connect is an{" "}
            <a
              className={footerLinkClassName}
              href="https://www.lfdecentralizedtrust.org/"
              rel="noopener noreferrer"
              target="_blank"
            >
              LF Decentralized Trust
            </a>{" "}
            Lab.
          </Text>
        </div>

        <div className="flex w-full justify-end">
          <Suspense fallback={<div aria-hidden className="min-h-11 w-40" />}>
            <ColorSchemeMenu />
          </Suspense>
        </div>
      </div>
    </footer>
  );
}
