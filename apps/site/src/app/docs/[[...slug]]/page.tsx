// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LLMCopyButton, ViewOptions } from "@/components/ai/page-actions.tsx";
import { getMDXComponents } from "@/components/mdx.tsx";
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
            <ViewOptions
              githubUrl={`https://github.com/PDP-Connect/pdpp/blob/main/apps/site/content/docs/${githubPath}`}
              markdownUrl={markdownUrl}
            />
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
  return {
    description: page.data.description,
    title: page.data.title,
  };
}
