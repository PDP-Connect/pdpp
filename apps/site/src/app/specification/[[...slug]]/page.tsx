// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

export default async function Page({ params }: DocsPageProps) {
  const resolved = await params;
  const page = source.getPage(resolved.slug);

  if (!page) {
    notFound();
  }

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const githubPath = page.path;
  const firstSlug = page.slugs[0] || "";
  const sectionLabel = firstSlug.startsWith("reference-implementation") ? "Reference Implementation" : "Protocol Spec";

  return (
    <DocsPage className="pdpp-docs-page" full={page.data.full} toc={page.data.toc}>
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
  const page = source.getPage(resolved.slug);

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
  // MUST #1.2).
  //
  // content/docs/README.md is contributor-facing authoring notes (see
  // sync-spec-docs.mjs's comment: it and index.mdx are deliberately untouched
  // by generation), not protocol content, but fumadocs still routes it live at
  // /specification/README. noindex keeps it out of the sitemap/search results
  // without changing the docs source tree that other in-flight work depends
  // on (SEO/GEO standard MUST #1.5: robots directives must match the approved
  // access policy; this page was never meant to be a public spec page).
  const isInternalNotesPage = page.path === "README.md";

  return {
    alternates: { canonical: page.url },
    description: page.data.description,
    openGraph: { url: page.url },
    robots: isInternalNotesPage ? { follow: false, index: false } : undefined,
    title: page.data.title,
  };
}
