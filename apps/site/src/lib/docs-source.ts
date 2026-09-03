// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type * as PageTree from "fumadocs-core/page-tree";
import { type InferPageType, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { docs } from "../../.source/dynamic.ts";
import {
  docsRoute,
  GOVERNANCE_SLUG,
  GUIDANCE_SLUGS,
  governanceRoute,
  PRIMARY_SLUGS,
  PRINCIPLES_SLUG,
  principlesRoute,
} from "./spec-nav-slugs.ts";

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

// The programme documents are authored inside the fumadocs collection (so they
// are indexed and carry the same page furniture as a spec page) but are SERVED
// at their own top-level routes. Each tree item therefore keeps the name
// fumadocs resolved for it while pointing at the canonical URL — without this
// the rail would link to /specification/governance and
// /specification/principles, which only 308-redirect there.
//
// Governance first: it is the document that says what a status means, and the
// Principles are one thing it governs.
const PROGRAMME_DOCS = [
  { route: governanceRoute, slug: GOVERNANCE_SLUG },
  { route: principlesRoute, slug: PRINCIPLES_SLUG },
] as const;

function programmeItems(byUrl: Map<string, PageTree.Item>): PageTree.Item[] {
  return PROGRAMME_DOCS.flatMap(({ route, slug }) => pick(byUrl, [slug]).map((item) => ({ ...item, url: route })));
}

// The tree the rail renders: the specification set, then the programme
// documents. Every non-normative document (guides, rationale, deferred
// concerns, open questions) keeps its URL but is listed only on /maintainers —
// see MAINTAINER_DOC_SLUGS.
//
// The separator names are load-bearing: components/specification/rail.tsx
// renders "Specification", "Implementer guidance" and "Programme" as the
// rail's three labels, and any separator it does not recognise degrades to a
// bare rule.
//
// "Implementer guidance" exists so Discovery and Trust and the Collection
// Profile are not read as part of the normative set. Both were listed beside
// Core as companion specifications until the requirements for accepting a
// declaration moved into Core §5; both are now informative.
//
// Governance sits under its OWN heading rather than as a seventh document in
// the specification list. The six above are specifications under CSL-1.0 that
// change through the Community Specification process; governance is a
// programme document amended by a vote of Partners. One list would imply one
// amendment route where there are two.
export function getSpecNavTree(): PageTree.Root {
  const full = source.getPageTree();
  const byUrl = itemsByUrl(full);
  return {
    ...full,
    children: [
      { $id: "spec-rail-primary", name: "Specification", type: "separator" },
      ...pick(byUrl, PRIMARY_SLUGS),
      { $id: "spec-rail-guidance", name: "Implementer guidance", type: "separator" },
      ...pick(byUrl, GUIDANCE_SLUGS),
      { $id: "spec-rail-programme", name: "Programme", type: "separator" },
      ...programmeItems(byUrl),
    ],
  };
}
