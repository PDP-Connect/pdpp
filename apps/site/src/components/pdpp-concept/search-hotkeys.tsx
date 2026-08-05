// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

// A client boundary that owns the search hotkey config.
//
// The root layout is a Server Component, and fumadocs' hotKey entries take a
// PREDICATE FUNCTION. Functions cannot cross the server/client boundary, so
// configuring this in layout.tsx crashes the render with "Functions cannot be
// passed directly to Client Components". This component exists to hold that
// function on the client side.
//
// ONE entry, not two: SearchProvider matches with hotKey.every(...), so a second
// entry would require both chords at once rather than offering an alternative.
// This single predicate accepts either `/` or Cmd/Ctrl-K.
//
// `/` is what the concept site bound and what the masthead trigger shows as its
// keycap hint, so the hint has to be true. Cmd/Ctrl-K is fumadocs' default and
// the one every comparable docs site ships, so both audiences are served.
export function PdppRootProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{
        hotKey: [
          {
            display: "/",
            key: (e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                return true;
              }
              // `/` must not swallow a keystroke meant for a field — including
              // the search dialog's own input.
              const el = e.target as HTMLElement | null;
              const isTypingTarget =
                el?.isContentEditable === true ||
                el?.tagName === "INPUT" ||
                el?.tagName === "TEXTAREA" ||
                el?.tagName === "SELECT";
              return e.key === "/" && !isTypingTarget;
            },
          },
        ],
      }}
      theme={{ enabled: false }}
    >
      {children}
    </RootProvider>
  );
}
