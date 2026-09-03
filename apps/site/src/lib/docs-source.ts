// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type * as PageTree from "fumadocs-core/page-tree";
import { type InferPageType, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { docs } from "../../.source/dynamic.ts";
import { docsRoute, GUIDANCE_SLUGS, PRIMARY_SLUGS } from "./spec-nav-slugs.ts";

export const source = loader({
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
  source: docs.toFumadocsSource(),
});

export function getPageMarkdownUrl(page: InferPageType<typeof source>) {
  return {
    segments: page.slugs,
    url: `${page.url}.mdx`,
  };
}

function itemsByUrl(tree: PageTree.Root): Map<string, PageTree.Item> {
  const found = new Map<string, PageTree.Item>();
  const walk = (nodes: PageTree.Node[]) => {
    for (const node of nodes) {
      if (node.type === "page") {
        found.set(node.url, node);
      } else if (node.type === "folder") {
        walk(node.children);
      }
    }
  };
  walk(tree.children);
  return found;
}

// Items are taken FROM the built tree rather than hand-written as new nodes, so
// a slug that stops existing (or gets renamed by sync-spec-docs.mjs) drops out
// of the rail instead of rendering a dead link, and each item keeps the name,
// icon and description fumadocs resolved for it.
function pick(byUrl: Map<string, PageTree.Item>, slugs: readonly string[]): PageTree.Item[] {
  return slugs
    .map((slug) => byUrl.get(`${docsRoute}/${slug}`))
    .filter((item): item is PageTree.Item => item !== undefined);
}

// The contents rail: Core's own nine sections, then the informative documents,
// then the appendix.
//
// Core's sections are IN-PAGE anchors, not sibling documents. /specification
// renders spec-core in full, so a reader clicking "5. Source declaration"
// should move down the page they are already on rather than load another one.
// They are therefore hand-declared here rather than picked out of the fumadocs
// tree, which only knows about documents.
//
// The separator names are load-bearing: components/specification/rail.tsx
// renders them as the rail's headings, and any separator it does not recognise
// degrades to a bare rule.
const CORE_SECTIONS: readonly (readonly [string, string])[] = [
  ["#introduction", "1. Introduction"],
  ["#terminology", "2. Terminology and actors"],
  ["#system-architecture", "3. System architecture"],
  ["#record-model", "4. Record model"],
  ["#source-declaration", "5. Source declaration"],
  ["#selection-request", "6. Selection request"],
  ["#grant", "7. Grant"],
  ["#resource-server-interface", "8. Resource server interface"],
  ["#conformance", "9. Conformance"],
];

export function getSpecNavTree(): PageTree.Root {
  const full = source.getPageTree();
  const byUrl = itemsByUrl(full);
  const coreItems: PageTree.Item[] = CORE_SECTIONS.map(([anchor, name]) => ({
    $id: `spec-rail-core-${anchor}`,
    name,
    type: "page",
    url: `${docsRoute}${anchor}`,
  }));

  return {
    ...full,
    children: [
      { $id: "spec-rail-primary", name: "Core protocol", type: "separator" },
      ...coreItems,
      { $id: "spec-rail-guidance", name: "Implementer guidance, informative", type: "separator" },
      ...pick(byUrl, GUIDANCE_SLUGS),
      { $id: "spec-rail-appendices", name: "Appendices", type: "separator" },
      {
        $id: "spec-rail-appendix-a",
        name: "A. Purpose registry",
        type: "page",
        url: `${docsRoute}#purpose-registry`,
      },
    ],
  };
}
