// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { ThemeProvider } from "@pdpp/operator-ui/components/theme/theme-provider";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";

export function SiteProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <RootProvider
        search={{
          hotKey: [
            {
              display: "/",
              key: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "k") {
                  return true;
                }

                // `/` must not swallow a keystroke meant for a field, including
                // the search dialog's own input.
                const element = event.target as HTMLElement | null;
                const isTypingTarget =
                  element?.isContentEditable === true ||
                  element?.tagName === "INPUT" ||
                  element?.tagName === "TEXTAREA" ||
                  element?.tagName === "SELECT";

                return event.key === "/" && !isTypingTarget;
              },
            },
          ],
        }}
        theme={{ enabled: false }}
      >
        <TooltipProvider>{children}</TooltipProvider>
      </RootProvider>
    </ThemeProvider>
  );
}
