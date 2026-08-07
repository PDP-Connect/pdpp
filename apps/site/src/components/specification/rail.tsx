"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type * as PageTree from "fumadocs-core/page-tree";
import type { DocsSlots } from "fumadocs-ui/layouts/docs";
import {
  Sidebar,
  type SidebarProps,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "fumadocs-ui/layouts/docs/slots/sidebar";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PdppRailFrontMatter } from "@/components/pdpp-concept/rail-front-matter.tsx";
import { PdppRailSectionLabel } from "@/components/pdpp-concept/rail-section-label.tsx";
import { docsRoute, SUPPORTING_SLUGS } from "@/lib/spec-nav-slugs.ts";
import { useSpecRailData } from "./rail-context.tsx";

const supportingUrls = new Set(SUPPORTING_SLUGS.map((slug) => `${docsRoute}/${slug}`));

// The `slots.sidebar.root` replacement.
//
// This is composition, not a fork: fumadocs' own `Sidebar` still renders the
// column (sticky desktop placement, mobile drawer, scroll container, and the
// page tree itself). What this overrides is
//
//   banner      — the concept's front-matter block (VERSION/STATUS/DATE/EDITORS)
//                 and the "Specification" label, above the document list
//   components  — how a tree Item and Separator render, so the document links
//                 carry the concept's type and density rather than fumadocs'
//                 36px button rows
//
// The document list itself is the real page tree, filtered in docs-source.ts,
// so active state, prefetching and the drawer's auto-close still come from
// fumadocs rather than being reimplemented here.

function RailItem({ item }: { item: PageTree.Item }) {
  const pathname = usePathname();
  // The core spec answers to both /specification and /specification/spec-core
  // (the bare URL is where a visitor lands — see the route's ROOT_SLUG_TARGET),
  // so without this the first document never highlights on the page it renders.
  const active = pathname === item.url || (item.url.endsWith("/spec-core") && pathname === "/specification");
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className="pdpp-rail__doc"
      data-active={active ? "true" : undefined}
      data-supporting={supportingUrls.has(item.url) ? "true" : undefined}
      href={item.url}
    >
      {item.name}
    </Link>
  );
}

// The rail carries exactly one label ("Specification"), and the supporting
// documents sit under a hairline with NO heading — a second heading would make
// them a visual peer of the specification and put all fourteen documents back
// on equal footing, which is the thing this rail exists to undo. The tree's
// own separators are therefore rendered as the rule, not as titles.
function RailSeparator({ item }: { item: PageTree.Separator }) {
  const label = typeof item.name === "string" ? item.name : "";
  if (label === "Specification") {
    return <PdppRailSectionLabel>{label}</PdppRailSectionLabel>;
  }
  return <hr className="pdpp-rail__rule" />;
}

function RailBanner() {
  const { frontMatter } = useSpecRailData();
  return (
    <PdppRailFrontMatter
      date={frontMatter.date}
      editors={frontMatter.editors}
      status={frontMatter.status}
      version={frontMatter.version}
    />
  );
}

export function PdppSpecRail(props: SidebarProps) {
  return <Sidebar {...props} banner={<RailBanner />} components={{ Item: RailItem, Separator: RailSeparator }} />;
}

// Assembled here, in the client module, because `useSidebar` is a hook:
// naming it from the server layout would pull a client-only binding across the
// boundary. provider/trigger/useSidebar stay fumadocs' own — only `root` and
// the search trigger are ours.
export const specRailSlots = {
  searchTrigger: false,
  sidebar: { provider: SidebarProvider, root: PdppSpecRail, trigger: SidebarTrigger, useSidebar },
} as const satisfies Partial<DocsSlots>;
