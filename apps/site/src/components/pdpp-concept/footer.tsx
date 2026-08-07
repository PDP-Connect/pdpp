// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Suspense } from "react";
import { cn } from "@/lib/utils.ts";
import { ColorSchemeMenu } from "./color-scheme-menu.tsx";
import { DiscordIcon, GithubIcon, WordmarkIcon } from "./icons.tsx";
import { DISCORD_INVITE_URL, GITHUB_REPO_URL, SITE_LICENSES } from "./site-facts.ts";
import { Text } from "./text.tsx";

const GITHUB_URL_SCHEME_RE = /^https?:\/\//;
const githubDisplayText = GITHUB_REPO_URL.replace(GITHUB_URL_SCHEME_RE, "");

// ONE footer, identical on every page. The owner's finding was that the footer
// differed on all four pages; the fix is a single component that takes no
// per-page props, so there is no seam where they can diverge again.
//
// Column order and content are load-bearing:
//   BRAND       — wordmark + protocol name.
//   LICENSE     — licenses (spec first) + governance.
//   COMMUNITY   — Discord and the GitHub repository (SOURCE folded in here).
//
// Three columns on all pages.
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
          // Stack by default; three-col row from 721px (concept surface omits md: theme)
          "flex flex-col gap-6 py-8",
          "min-[721px]:flex-row min-[721px]:flex-wrap min-[721px]:justify-between min-[721px]:gap-x-16 min-[721px]:gap-y-8 min-[721px]:pt-10 min-[721px]:pb-24"
        )}
      >
        <div className={colClassName}>
          <Link
            aria-label="PDPP, home"
            className="text-on-primary-emphasis hover:text-white! focus-visible:text-white!"
            href="/"
          >
            <WordmarkIcon />
          </Link>
          <Text color="onAccentLabel" size="stamp" weight="normal">
            personal data portabilty protocol
          </Text>
        </div>

        <div className={cn(colClassName, "max-w-[40ch] gap-6 tabular-nums")}>
          <div className="flex flex-col gap-1.5">
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
          <div className="flex flex-col gap-1.5">
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
        </div>

        <div className={cn(colClassName, "gap-6")}>
          <div className="flex flex-col gap-1.5">
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
          <div className="flex flex-col gap-1.5">
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
