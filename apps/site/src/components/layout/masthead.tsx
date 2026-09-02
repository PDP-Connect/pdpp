// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { useSearchContext } from "fumadocs-ui/contexts/search";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { publicSiteNav } from "@/lib/public-site-nav.ts";
import { cn } from "@/lib/utils.ts";
import { SearchIcon, WordmarkIcon } from "../elements/icons.tsx";
import { PdppThemeSwitch } from "../elements/theme-switch.tsx";
import { Text } from "../typography/text.tsx";

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
  const headerRef = useRef<HTMLElement | null>(null);

  // The masthead's height is intrinsic — py-5 plus whatever the nav row wraps
  // to — so nothing downstream can hardcode it. The docs layout needs it as a
  // sticky offset for the rail and the TOC: fumadocs' own --fd-banner-height
  // defaulted to 3rem while the real header measured 70px, so both panes sat
  // correctly at rest and then jumped 22px up the instant the reader scrolled.
  // Publishing the measured value keeps the offset honest across font loading,
  // zoom, and the width where the nav row wraps.
  useEffect(() => {
    // The <header> below is rendered unconditionally, so the ref is populated
    // before this effect runs — no null guard (Biome flags one here as dead).
    const header = headerRef.current as HTMLElement;
    const publish = () => {
      document.documentElement.style.setProperty(
        "--pdpp-masthead-height",
        `${Math.round(header.getBoundingClientRect().height)}px`
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

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
        data-slot="pdpp-editorial-masthead"
        ref={headerRef}
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
            {publicSiteNav().map((item) => {
              const active = pathname === item.link || pathname.startsWith(`${item.link}/`);
              const label = (
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
                >
                  {item.text}
                </Text>
              );

              // Only Specification carries children. The panel opens on hover
              // AND on focus-within, so it is reachable by keyboard without a
              // click handler or any open/closed state to keep in sync — the
              // links inside are ordinary tab stops. Below the nav's collapse
              // width the panel is rendered inline rather than floating, since
              // a floating panel inside an already-expanded disclosure has
              // nothing to float over.
              if (!item.children || item.children.length <= 1) {
                return <span key={item.link}>{label}</span>;
              }

              return (
                <span className="relative md:group" key={item.link}>
                  {label}
                  <span
                    className={cn(
                      "z-30 flex-col gap-2 whitespace-nowrap",
                      "md:absolute md:top-full md:left-0 md:hidden md:pt-3",
                      "md:group-hover:flex md:group-focus-within:flex",
                      "max-md:mt-2 max-md:ml-3 max-md:flex"
                    )}
                  >
                    <span className="flex flex-col gap-2 border border-border bg-background p-3 max-md:border-0 max-md:bg-transparent max-md:p-0">
                      {item.children.map((child) => (
                        <Text
                          as={Link}
                          className="hover:text-primary! focus-visible:text-primary!"
                          color="muted"
                          family="sans"
                          href={child.link}
                          inline
                          key={child.link}
                        >
                          {child.text}
                        </Text>
                      ))}
                    </span>
                  </span>
                </span>
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
