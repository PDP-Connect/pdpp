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

/** 44px hit target without growing the layout box — nav link + search. */
const hitAreaOverlay = cn(
  "before:absolute before:top-1/2 before:left-1/2",
  "before:h-[max(44px,100%)] before:w-[max(44px,100%)]",
  "before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
);

function NavSearchTrigger() {
  const { enabled, setOpenSearch } = useSearchContext();

  if (!enabled) {
    return null;
  }

  return (
    <button
      aria-haspopup="dialog"
      className={cn(
        // Type inherits nav text-small; baseline with siblings
        "relative box-border inline-flex items-baseline gap-1.5 leading-none",
        // Pill chrome grows around glyphs (no fixed height that lifts the line)
        "cursor-pointer rounded-[3px] bg-paper-deep px-2 py-0.5",
        "border border-[color-mix(in_srgb,var(--pdpp-concept-ink)_16%,var(--pdpp-concept-paper))]",
        "text-ink-soft hover:border-teal hover:text-teal focus-visible:border-teal focus-visible:text-teal",
        hitAreaOverlay
      )}
      onClick={() => setOpenSearch(true)}
      type="button"
    >
      <SearchIcon className="size-[0.9em] shrink-0 self-center" />
      <span>Search</span>
      <kbd
        className={cn(
          "rounded-[2px] bg-paper/20 px-1 font-mono text-[0.73em] text-ink-faint leading-none",
          "border border-[color-mix(in_srgb,var(--pdpp-concept-ink)_18%,var(--pdpp-concept-paper))]",
          "max-[640px]:hidden",
          "translate-y-[-0.1em]"
        )}
      >
        /
      </kbd>
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
  // stands down at, the nav itself collapses behind a disclosure toggle rather
  // than wrapping as visible text links — the concept's own mobile pattern
  // (styles.css's .nav-toggle/.nav.is-open). `mobileNavOpen` only matters below
  // that width; the nav stays always visible above it regardless of this state,
  // so there is no desktop-width behavior change here.
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
      <a
        className={cn(
          "absolute top-0 -left-[9999px] z-[100] bg-paper px-4 py-2.5",
          "border border-teal font-sans text-[15px] text-teal!",
          "focus:top-2 focus:left-2"
        )}
        href={skipTarget}
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b bg-paper">
        <div
          className={cn(
            // Page measure + named container for the label stand-down
            "@container/masthead container max-w-page",
            // Sticky row: baseline align so nav/search/theme share one cross-size
            "flex flex-wrap items-baseline justify-between gap-8 py-5",
            // Mobile: relative so the Menu toggle can absolute to the pad edge
            "max-[720px]:relative"
          )}
        >
          <div className="flex min-w-0 flex-nowrap items-baseline gap-3.5">
            {pathname !== "/" && (
              <Link
                aria-label="PDPP, home"
                className={cn("inline-flex items-center gap-3 hover:text-teal!", "md:translate-y-[0.25em]")}
                href="/"
              >
                <WordmarkIcon />
              </Link>
            )}
          </div>
          <button
            aria-controls="pdpp-primary-nav"
            aria-expanded={mobileNavOpen}
            className={cn(
              // Viewport MQ (not masthead CQ): collapse width depends on open state — circular if CQ
              "absolute top-0 right-pad box-border hidden min-h-11 min-w-11 cursor-pointer",
              "border border-rule bg-transparent px-2.5 py-1.5",
              "font-sans text-[12px] text-ink-soft uppercase tracking-[0.08em]",
              "hover:text-teal focus-visible:text-teal",
              "focus-visible:outline-2 focus-visible:outline-teal focus-visible:outline-offset-2",
              "max-[720px]:block"
            )}
            onClick={() => setMobileNavOpen((open) => !open)}
            ref={navToggleRef}
            type="button"
          >
            Menu
          </button>
          <nav
            aria-label="Primary"
            className={cn(
              "flex flex-wrap items-baseline gap-6 font-sans text-small",
              // Collapsed by default below 720px; data-open flips it (concept .nav.is-open)
              "max-[720px]:hidden max-[720px]:w-full max-[720px]:flex-col max-[720px]:items-start max-[720px]:gap-3",
              "max-[720px]:data-[open=true]:flex"
            )}
            data-open={mobileNavOpen}
            id="pdpp-primary-nav"
          >
            {publicSiteNav.map((item) => {
              const active = pathname === item.link || pathname.startsWith(`${item.link}/`);
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    // Box: fixed 20px line, underline track for active
                    "relative box-border inline-flex h-5 items-center leading-none",
                    "border-transparent! border-b pb-0.5",
                    // Color
                    "text-ink-soft! hover:text-teal! focus-visible:text-teal!",
                    "aria-[current=page]:border-teal! aria-[current=page]:text-teal!",
                    hitAreaOverlay,
                    "max-[720px]:h-auto"
                  )}
                  href={item.link}
                  key={item.link}
                >
                  {item.text}
                </Link>
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
