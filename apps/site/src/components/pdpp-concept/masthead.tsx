// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useSearchContext } from "fumadocs-ui/contexts/search";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { publicSiteNav } from "@/lib/public-site-nav.ts";
import { cn } from "@/lib/utils.ts";
import { SearchIcon, WordmarkIcon } from "./icons.tsx";
import { Text } from "./text.tsx";
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
      className={cn(
        // Baseline row; type/color on Text children
        "hit-area-overlay box-border inline-flex items-center gap-1.5",
        // Pill chrome grows around glyphs (no fixed height that lifts the line)
        "cursor-pointer rounded-[3px] bg-card/70 px-2 py-0.5",
        "border border-border",
        "text-muted-foreground hover:border-primary hover:text-primary focus-visible:border-primary focus-visible:text-primary"
      )}
      onClick={() => setOpenSearch(true)}
      type="button"
    >
      <SearchIcon className="size-[0.9em] shrink-0 self-center" />
      <Text as="span" color="inherit" family="sans" inline>
        Search
      </Text>
      <Text
        as="kbd"
        className={cn(
          "rounded-[2px] bg-transparent px-1 text-[0.73em]",
          "border border-border/70",
          "max-[640px]:hidden"
        )}
        color="subtle"
        family="mono"
        inline
      >
        /
      </Text>
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

  // Below 720px the nav collapses behind a disclosure toggle (concept
  // .nav-toggle/.nav.is-open). `mobileNavOpen` only matters there; above it
  // the nav stays visible regardless of this state.
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
      <Text
        as="a"
        className={cn(
          "absolute top-0 left-[-9999px] z-100 bg-background px-4 py-2.5",
          "border border-primary focus:top-2 focus:left-2"
        )}
        color="primary"
        href={skipTarget}
        inline
        size="small"
      >
        Skip to content
      </Text>
      <header
        className={cn("sticky top-0 z-20 bg-background", pathname !== "/" && "border-b")}
        data-slot="pdpp-concept-masthead"
      >
        <div
          className={cn(
            "container max-w-page",
            // Sticky row: baseline align so nav/search/theme share one cross-size
            "flex flex-wrap items-baseline justify-between gap-8 py-5",
            // Mobile: relative so the Menu toggle can absolute to the pad edge
            "max-md:relative"
          )}
        >
          <div className="flex min-w-0 flex-nowrap items-baseline gap-3.5">
            <Link
              aria-label="PDPP, home"
              className={cn(
                "inline-flex items-center gap-3 text-primary hover:text-foreground",
                // align
                "md:translate-y-[0.25em]",
                // hide on home but retain layout space
                pathname === "/" && "opacity-0"
              )}
              href="/"
            >
              <WordmarkIcon />
            </Link>
          </div>

          {/* mobile toggle */}
          <button
            aria-controls="pdpp-primary-nav"
            aria-expanded={mobileNavOpen}
            className={cn(
              "absolute top-2.5 right-pad box-border hidden min-h-11 min-w-11 cursor-pointer",
              "border border-border bg-transparent px-2.5 py-1.5",
              "text-muted-foreground hover:text-primary focus-visible:text-primary",
              "focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2",
              "max-md:block"
            )}
            onClick={() => setMobileNavOpen((open) => !open)}
            ref={navToggleRef}
            type="button"
          >
            <Text as="span" color="inherit" inline size="stamp">
              Menu
            </Text>
          </button>

          {/* nav list */}
          <nav
            aria-label="Primary"
            className={cn(
              "flex flex-wrap items-baseline gap-6",
              // Collapsed by default below 720px; data-open flips it (concept .nav.is-open)
              "max-md:hidden max-md:w-full max-md:flex-col max-md:items-start max-md:gap-3",
              "max-md:data-[open=true]:flex"
            )}
            data-open={mobileNavOpen}
            id="pdpp-primary-nav"
          >
            {publicSiteNav.map((item) => {
              const active = pathname === item.link || pathname.startsWith(`${item.link}/`);
              return (
                <Text
                  aria-current={active ? "page" : undefined}
                  as={Link}
                  className={cn(
                    // Box: fixed 20px line, underline track for active
                    "hit-area-overlay box-border inline-flex h-5 items-center",
                    "border-transparent! border-b pb-0.5",
                    "hover:text-primary! focus-visible:text-primary!",
                    "aria-[current=page]:border-primary! aria-[current=page]:text-primary!",
                    "max-md:h-auto"
                  )}
                  color="muted"
                  family="sans"
                  href={item.link}
                  inline
                  key={item.link}
                >
                  {item.text}
                </Text>
              );
            })}
            <div className="flex items-center gap-5 pr-2">
              <NavSearchTrigger />
              <PdppThemeSwitch />
            </div>
          </nav>
        </div>
      </header>
    </>
  );
}
