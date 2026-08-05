// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { siteNav } from "@pdpp/brand/chrome";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SearchIcon } from "./icons.tsx";

// Search lives in the global nav, not on any page. The owner's finding was that
// a page-level search box is furniture on a front door and mis-sized on the spec
// page; the answer is one global affordance.
//
// Pattern: compact trigger + overlay dialog, never a permanently-expanded input.
// That is what every comparable docs site converged on (MCP docs, Stripe,
// react.dev, Tailwind, Next.js, shadcn/ui), and a button has the same box-model
// shape as a nav link where a text input does not.
//
// The dialog itself is fumadocs' own, already wired to /api/search — this is the
// idiomatic React equivalent of the concept's hand-rolled <script> overlay, so
// the site keeps one search index and one dialog rather than a second one built
// by hand. `/` and Cmd/Ctrl-K are bound by fumadocs' SearchProvider.
function NavSearchTrigger() {
  const { enabled, setOpenSearch } = useSearchContext();

  if (!enabled) {
    return null;
  }

  return (
    <button
      aria-haspopup="dialog"
      className="pdpp-nav-search-trigger"
      onClick={() => setOpenSearch(true)}
      type="button"
    >
      <SearchIcon className="pdpp-nav-search-trigger__icon" />
      <span className="pdpp-nav-search-trigger__label">Search</span>
      <kbd className="pdpp-nav-search-trigger__key">/</kbd>
    </button>
  );
}

export function PdppConceptMasthead() {
  const pathname = usePathname();

  return (
    <header className="pdpp-masthead">
      <div className="pdpp-masthead__inner">
        <div className="pdpp-masthead__wordmark-line">
          <Link className="pdpp-wordmark" href="/">
            PDPP
          </Link>
          <span className="pdpp-masthead__label">Personal Data Portability Protocol</span>
        </div>
        <nav aria-label="Primary" className="pdpp-nav">
          {siteNav.map((item) => {
            const active = pathname === item.link || pathname.startsWith(`${item.link}/`);
            return (
              <Link aria-current={active ? "page" : undefined} href={item.link} key={item.link}>
                {item.text}
              </Link>
            );
          })}
          <NavSearchTrigger />
        </nav>
      </div>
    </header>
  );
}
