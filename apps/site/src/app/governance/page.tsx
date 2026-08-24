// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { DocsBody, DocsDescription, DocsPage } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LLMCopyButton, ViewOptions } from "@/components/ai/page-actions.tsx";
import { getMDXComponents } from "@/components/mdx/mdx.tsx";
import { ResponsiveSpecTable } from "@/components/mdx/responsive-table.tsx";
import { Text } from "@/components/typography/text.tsx";
import { getPageMarkdownUrl, source } from "@/lib/docs-source.ts";
import { repoBlobUrl } from "@/lib/site-facts.ts";
import { GOVERNANCE_SLUG, governanceRoute } from "@/lib/spec-nav-slugs.ts";

// The governance programme document, served at its own top-level route.
//
// It is AUTHORED as a fumadocs page (content/docs/governance.md, generated from
// the repo-root GOVERNANCE.md by scripts/sync-spec-docs.mjs) because everything
// this page needs — the TOC, the Copy Markdown affordance, and search indexing —
// comes from membership in that collection: /api/search indexes the fumadocs
// source and nothing else. It is SERVED here rather than at
// /specification/governance because it is not a specification: the six spec
// documents change through the Community Specification process under CSL-1.0,
// this one by a vote of Partners. fumadocs still routes the page under
// /specification, which 308-redirects here (see next.config.mjs) so the
// document is not served at two addresses.
//
// This mirrors the specification route's renderer rather than sharing it: that
// route is a catch-all whose slug handling, root-slug redirect target and
// per-page noindex rules are all specification concerns that do not apply to a
// single fixed programme page.

export default async function Page() {
  const page = source.getPage([GOVERNANCE_SLUG]);

  if (!page) {
    notFound();
  }

  const { body: MDX, toc } = await page.data.load();

  return (
    <DocsPage className="pdpp-docs-page" full={page.data.full} toc={toc}>
      <div className="pdpp-docs-hero">
        <div className="pdpp-docs-hero__content">
          <Text as="h1" size="display">
            {page.data.title}
          </Text>
          {page.data.description && (
            <DocsDescription className="pdpp-docs-description">{page.data.description}</DocsDescription>
          )}
          <div className="pdpp-docs-actions">
            <LLMCopyButton markdownUrl={getPageMarkdownUrl(page).url} />
            {/* The repo-root GOVERNANCE.md, NOT content/docs/governance.md:
                the latter is generated and gitignored, so a blob link to it
                404s on GitHub. Root is also where a reader is meant to find
                this document. */}
            <ViewOptions githubUrl={repoBlobUrl("GOVERNANCE.md")} markdownUrl={getPageMarkdownUrl(page).url} />
          </div>
        </div>
      </div>
      <DocsBody className="pdpp-docs-body">
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
            table: ResponsiveSpecTable,
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateMetadata(): Metadata {
  const page = source.getPage([GOVERNANCE_SLUG]);

  if (!page) {
    notFound();
  }

  // Canonical is this route, not page.url (which fumadocs resolves to
  // /specification/governance, the URL that redirects here).
  return {
    alternates: { canonical: governanceRoute },
    description: page.data.description,
    openGraph: { url: governanceRoute },
    title: page.data.title,
  };
}
