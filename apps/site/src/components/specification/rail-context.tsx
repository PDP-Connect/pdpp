"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, type ReactNode, useContext } from "react";
import type { SpecFrontMatter } from "@/lib/spec-front-matter.ts";

// The rail's front matter is read from spec-core.md and MAINTAINERS.md on the
// server (see spec-front-matter.ts). fumadocs' sidebar slot is a client
// component, so the values cross the boundary as serialized props through this
// provider rather than being re-read or hand-copied on the client.
//
// `null` means "this surface has no specification front matter to show". The
// governance route uses it: that block reports the SPECIFICATION's version,
// status and editors, and rendering "Status: Normative draft" above a document
// whose own callout says it is not normative protocol text states the opposite
// of what the page is for.

interface SpecRailData {
  frontMatter: SpecFrontMatter | null;
}

const SpecRailContext = createContext<SpecRailData | null>(null);

export function SpecRailProvider({
  children,
  frontMatter,
}: {
  children: ReactNode;
  frontMatter: SpecFrontMatter | null;
}) {
  return <SpecRailContext.Provider value={{ frontMatter }}>{children}</SpecRailContext.Provider>;
}

export function useSpecRailData(): SpecRailData {
  const value = useContext(SpecRailContext);
  if (!value) {
    throw new Error("useSpecRailData must be used inside SpecRailProvider (see components/specification/shell.tsx).");
  }
  return value;
}
