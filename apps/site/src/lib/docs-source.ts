// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type * as PageTree from "fumadocs-core/page-tree";
import { type InferPageType, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { docs } from "../../.source/dynamic.ts";
import { docsRoute, PRIMARY_SLUGS } from "./spec-nav-slugs.ts";

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

// The tree the rail renders: the specification set, and nothing else. Every
// non-normative document (guides, rationale, deferred concerns, open questions)
// keeps its URL but is listed only on /maintainers — see MAINTAINER_DOC_SLUGS.
//
// The separator name is load-bearing: components/specification/rail.tsx renders
// "Specification" as the rail's one label.
export function getSpecNavTree(): PageTree.Root {
  const full = source.getPageTree();
  const byUrl = itemsByUrl(full);
  return {
    ...full,
    children: [{ $id: "spec-rail-primary", name: "Specification", type: "separator" }, ...pick(byUrl, PRIMARY_SLUGS)],
  };
}
