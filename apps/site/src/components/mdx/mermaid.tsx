// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Renders `mermaid` MDX code fences as diagrams. Follows the pattern
// documented at https://fumadocs.dev for wiring Mermaid into fumadocs-ui:
// `remarkMdxMermaid` (registered in source.config.ts) rewrites a ```mermaid
// fence into `<Mermaid chart="..." />`, and this client component renders it.
// The MDX source stays standard Mermaid syntax; only the renderer differs.
//
// Rendering is done by `beautiful-mermaid` (github.com/lukilabs/beautiful-mermaid,
// MIT), a from-scratch TypeScript renderer that parses standard Mermaid syntax
// (including flowchart subgraphs with `direction` overrides, which spec-core.md
// uses) and produces more polished SVG output than mermaid.js's default theme.
// It renders synchronously, so no async/Suspense dance is needed. Colors are
// passed as concrete hex values derived from this site's brand tokens
// (packages/pdpp-brand/styles/base.css --background/--foreground/--primary/--muted/
// --border, oklch converted to hex) so the diagram matches the site's palette
// in both themes rather than using one of the library's bundled theme presets.
"use client";

import { useTheme } from "@pdpp/operator-ui/components/theme/theme-provider";
import { type DiagramColors, renderMermaidSVG } from "beautiful-mermaid";
import { useEffect, useState } from "react";

// Hex equivalents of packages/pdpp-brand/styles/base.css design tokens (:root and
// html.dark), converted from oklch. Keep in sync if those tokens change.
const LIGHT_COLORS: DiagramColors = {
  bg: "#fcfcfa",
  fg: "#070707",
  accent: "#187adc",
  surface: "#f2f2f2",
  muted: "#636363",
  border: "#ebebeb",
};

const DARK_COLORS: DiagramColors = {
  bg: "#0c0d0f",
  fg: "#f0f2f5",
  accent: "#55a7ff",
  surface: "#1e1f22",
  muted: "#9b9fa5",
  border: "#27292c",
};

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
  const { resolvedTheme } = useTheme();
  const colors = resolvedTheme === "dark" ? DARK_COLORS : LIGHT_COLORS;

  const svg = renderMermaidSVG(chart, {
    ...colors,
    font: "inherit",
    transparent: true,
  });

  return (
    <div
      className="my-6 flex justify-center"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG markup is generated locally by renderMermaidSVG from spec markdown authored in this repo, not user input.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
