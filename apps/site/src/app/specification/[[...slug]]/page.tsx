// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { findNeighbour } from "fumadocs-core/page-tree";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LLMCopyButton, ViewOptions } from "@/components/ai/page-actions.tsx";
import { getMDXComponents } from "@/components/mdx.tsx";
import { repoBlobUrl } from "@/components/pdpp-concept/site-facts.ts";
import { getPageMarkdownUrl, source } from "@/lib/docs-source.ts";

interface DocsPageProps {
  params: Promise<{
    slug?: string[];
  }>;
}

// The goal design has no separate docs-index landing page: its /specification
// equivalent (spec.html) IS the core protocol document. fumadocs' own convention
// resolves an empty slug to content/docs/index.mdx (a card-grid landing page)
// because that file's basename is "index" — but spec-core.md is generated at
// build time from the repo-root spec (see scripts/sync-spec-docs.mjs) and can't
// be renamed to take over that slot without fighting the generator. Redirecting
// the empty slug to spec-core's page data instead keeps fumadocs' own routing
// untouched and serves the document at the bare /specification URL, matching
// the goal. index.mdx itself is kept as source (still reachable by fumadocs'
// internals and any direct link) but is no longer the page a visitor lands on.
const ROOT_SLUG_TARGET = ["spec-core"];

export default async function Page({ params }: DocsPageProps) {
  const resolved = await params;
  const isRootSlug = !resolved.slug || resolved.slug.length === 0;
  const slug = isRootSlug ? ROOT_SLUG_TARGET : resolved.slug;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const githubPath = page.path;
  const firstSlug = page.slugs[0] || "";
  const sectionLabel = firstSlug.startsWith("reference-implementation") ? "Reference Implementation" : "Protocol Spec";

  // fumadocs-ui's own Footer computes previous/next by matching usePathname()
  // against the flattened tree client-side — at the root slug the browser URL
  // is "/specification" while spec-core's own tree entry is
  // "/specification/spec-core", so that lookup misses and silently renders
  // neither card. findNeighbour (the same primitive the client hook wraps)
  // computed here from page.url, not the request path, sidesteps the miss.
  const rootFooterItems = isRootSlug ? findNeighbour(source.getPageTree(), page.url) : undefined;

  return (
    <DocsPage
      className="pdpp-docs-page"
      footer={rootFooterItems ? { items: rootFooterItems } : undefined}
      full={page.data.full}
      toc={page.data.toc}
    >
      <div className="pdpp-docs-hero">
        <div className="pdpp-docs-hero__content">
          <div className="pdpp-eyebrow">{sectionLabel}</div>
          <DocsTitle className="pdpp-display pdpp-docs-title">{page.data.title}</DocsTitle>
          {page.data.description && (
            <DocsDescription className="pdpp-docs-description">{page.data.description}</DocsDescription>
          )}
          <div className="pdpp-docs-actions">
            <LLMCopyButton markdownUrl={markdownUrl} />
            <ViewOptions githubUrl={repoBlobUrl(`apps/site/content/docs/${githubPath}`)} markdownUrl={markdownUrl} />
          </div>
        </div>
      </div>
      <DocsBody className="pdpp-docs-body">
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const resolved = await params;
  const isRootSlug = !resolved.slug || resolved.slug.length === 0;
  const slug = isRootSlug ? ROOT_SLUG_TARGET : resolved.slug;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  // No openGraph.images here on purpose: docs pages inherit the site-wide card
  // from src/app/opengraph-image.tsx by route-segment inheritance. Advertising a
  // per-page /og/docs/... URL previously overrode that inherited card with a 404.
  //
  // alternates.canonical / openGraph.url use page.url (fumadocs' own resolved
  // path, already under /specification) rather than a hand-built string, so a
  // route rename can't leave this pointed at the old path (SEO/GEO standard
  // MUST #1.2) — EXCEPT at the root slug, where page.url is spec-core's own
  // file-derived "/specification/spec-core" (that URL 308-redirects to this
  // one, see next.config.mjs) and would otherwise self-canonicalize away from
  // the URL actually being served.
  //
  // content/docs/README.md is contributor-facing authoring notes (see
  // sync-spec-docs.mjs's comment: it and index.mdx are deliberately untouched
  // by generation), not protocol content, but fumadocs still routes it live at
  // /specification/README. noindex keeps it out of the sitemap/search results
  // without changing the docs source tree that other in-flight work depends
  // on (SEO/GEO standard MUST #1.5: robots directives must match the approved
  // access policy; this page was never meant to be a public spec page).
  const isInternalNotesPage = page.path === "README.md";
  const canonicalUrl = isRootSlug ? "/specification" : page.url;

  return {
    alternates: { canonical: canonicalUrl },
    description: page.data.description,
    openGraph: { url: canonicalUrl },
    robots: isInternalNotesPage ? { follow: false, index: false } : undefined,
    title: page.data.title,
  };
}
