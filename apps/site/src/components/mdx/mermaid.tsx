// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Renders `mermaid` MDX code fences as diagrams. Follows the pattern
// documented at https://fumadocs.dev for wiring Mermaid into fumadocs-ui:
// `remarkMdxMermaid` (registered in source.config.ts) rewrites a ```mermaid
// fence into `<Mermaid chart="..." />`, and this client component renders it
// with the `mermaid` package. Reuses this site's own `useTheme` (site theme
// state; see components/theme/theme-provider.tsx) instead of `next-themes`,
// since the two expose the same `resolvedTheme` shape and the site does not
// otherwise depend on `next-themes`.
"use client";

import { use, useEffect, useId, useState } from "react";
import { useTheme } from "@/components/theme/theme-provider.tsx";

const renderCache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = renderCache.get(key);
  if (cached) {
    return cached as Promise<T>;
  }

  const promise = load();
  renderCache.set(key, promise);
  return promise;
}

export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return <MermaidContent chart={chart} />;
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(cachePromise("mermaid", () => import("mermaid")));

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    fontFamily: "inherit",
    themeCSS: "margin: 1.5rem auto 0;",
    theme: resolvedTheme === "dark" ? "dark" : "default",
  });

  const { svg, bindFunctions } = use(cachePromise(`${chart}-${resolvedTheme}`, () => mermaid.render(id, chart)));

  return (
    <div
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG markup is generated locally by mermaid.render from spec markdown authored in this repo, not user input.
      dangerouslySetInnerHTML={{ __html: svg }}
      ref={(container) => {
        if (container) {
          bindFunctions?.(container);
        }
      }}
    />
  );
}
