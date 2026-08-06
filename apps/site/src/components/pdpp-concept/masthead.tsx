// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useSearchContext } from "fumadocs-ui/contexts/search";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { publicSiteNav } from "@/lib/public-site-nav.ts";
import { SearchIcon, WordmarkIcon } from "./icons.tsx";
import { PdppThemeSwitch } from "./theme-switch.tsx";

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
  // /specification lands in fumadocs' own #nd-page article (see
  // src/app/specification/[[...slug]]/page.tsx); other pages don't yet carry
  // an equivalent id on their <main>, so the skip link is a no-op there until
  // those pages adopt one — restoring it fixes the one route this pass owns
  // rather than leaving it out everywhere for want of a universal target.
  const skipTarget = pathname.startsWith("/specification") ? "#nd-page" : "#main";

  // Below the same 700px container-query threshold the masthead label already
  // stands down at (see .pdpp-masthead__inner in editorial.css), the nav
  // itself collapses behind a disclosure toggle rather than wrapping as
  // visible text links — the concept's own mobile pattern (styles.css's
  // .nav-toggle/.nav.is-open). `mobileNavOpen` only matters below that width;
  // the CSS makes `.pdpp-nav` always visible above it regardless of this
  // state, so there is no desktop-width behavior change here.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navToggleRef = useRef<HTMLButtonElement>(null);

  // Following a link closes the disclosure, matching the goal's own behavior
  // (site.js closes any open dropdown before it navigates elsewhere) — without
  // this a reader who taps "Specification" from an already-open menu would
  // land on the new page with the mobile nav still expanded.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // Escape closes the disclosure and returns focus to the toggle that opened
  // it, the same "return focus to the trigger" contract every other overlay
  // control on this page follows (see fumadocs' own search dialog and
  // theme-switch's focus-visible ring) — a keyboard user who opened the menu
  // should not be dropped onto whatever the browser happens to focus next.
  useEffect(() => {
    if (!mobileNavOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
        navToggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);

  return (
    <>
      <a className="pdpp-skip-link" href={skipTarget}>
        Skip to content
      </a>
      <header className="pdpp-masthead">
        <div className="pdpp-masthead__inner">
          <div className="pdpp-masthead__wordmark-line">
            <Link aria-label="PDPP, home" className="pdpp-wordmark" href="/">
              <WordmarkIcon />
            </Link>
            {/* Hidden on the home route only — signed-off concept behavior
                (styles.css: "PRESERVE #5"). Home's composition is narrower
                than the railed pages, and the label collides with the nav at
                that width; the nav-to-content alignment wins there, so the
                label stands down rather than render clipped. */}
            {pathname !== "/" && <span className="pdpp-masthead__label">Personal Data Portability Protocol</span>}
          </div>
          <button
            aria-controls="pdpp-primary-nav"
            aria-expanded={mobileNavOpen}
            className="pdpp-nav-toggle"
            onClick={() => setMobileNavOpen((open) => !open)}
            ref={navToggleRef}
            type="button"
          >
            Menu
          </button>
          <nav aria-label="Primary" className="pdpp-nav" data-open={mobileNavOpen} id="pdpp-primary-nav">
            {publicSiteNav.map((item) => {
              const active = pathname === item.link || pathname.startsWith(`${item.link}/`);
              return (
                <Link aria-current={active ? "page" : undefined} href={item.link} key={item.link}>
                  {item.text}
                </Link>
              );
            })}
            <NavSearchTrigger />
            <PdppThemeSwitch />
          </nav>
        </div>
      </header>
    </>
  );
}
