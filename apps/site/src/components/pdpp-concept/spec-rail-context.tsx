"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, type ReactNode, useContext } from "react";
import type { SpecFrontMatter } from "@/lib/spec-front-matter.ts";

// The rail's front matter is read from spec-core.md and MAINTAINERS.md on the
// server (see spec-front-matter.ts). fumadocs' sidebar slot is a client
// component, so the values cross the boundary as serialized props through this
// provider rather than being re-read or hand-copied on the client.

interface SpecRailData {
  frontMatter: SpecFrontMatter;
}

const SpecRailContext = createContext<SpecRailData | null>(null);

export function SpecRailProvider({ children, frontMatter }: { children: ReactNode; frontMatter: SpecFrontMatter }) {
  return <SpecRailContext.Provider value={{ frontMatter }}>{children}</SpecRailContext.Provider>;
}

export function useSpecRailData(): SpecRailData {
  const value = useContext(SpecRailContext);
  if (!value) {
    throw new Error("useSpecRailData must be used inside SpecRailProvider (see app/specification/layout.tsx).");
  }
  return value;
}
