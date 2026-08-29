"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, type ReactNode, useContext } from "react";
import type { GovernanceFrontMatter, SpecFrontMatter } from "@/lib/spec-front-matter.ts";

// The rail's front matter is read from spec-core.md, MAINTAINERS.md and
// GOVERNANCE.md on the server (see spec-front-matter.ts). fumadocs' sidebar
// slot is a client component, so the values cross the boundary as serialized
// props through this provider rather than being re-read or hand-copied on the
// client.
//
// `null` means "this surface has no rail front matter to show" (no route uses
// this today, but the type keeps that state representable rather than forcing
// a route to fabricate a front-matter object it doesn't have).
//
// The specification and governance blocks are never the same object: the
// specification's block reports spec-core's own version, status and editors,
// and rendering "Status: Normative draft" above a document whose own callout
// says it is not normative protocol text would state the opposite of what the
// page is for. Governance gets its own block instead — see
// GOVERNANCE_FRONT_MATTER and getGovernanceFrontMatter in spec-front-matter.ts.

type RailFrontMatter = { kind: "governance"; value: GovernanceFrontMatter } | { kind: "spec"; value: SpecFrontMatter };

interface SpecRailData {
  frontMatter: RailFrontMatter | null;
}

const SpecRailContext = createContext<SpecRailData | null>(null);

export function SpecRailProvider({
  children,
  frontMatter,
}: {
  children: ReactNode;
  frontMatter: RailFrontMatter | null;
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
