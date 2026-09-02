// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Callout } from "fumadocs-ui/components/callout";
import { DocsBody, DocsDescription, DocsPage } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LLMCopyButton, ViewOptions } from "@/components/ai/page-actions.tsx";
import { getMDXComponents } from "@/components/mdx/mdx.tsx";
import { ResponsiveSpecTable } from "@/components/mdx/responsive-table.tsx";
import { Text } from "@/components/typography/text.tsx";
import { getPageMarkdownUrl, source } from "@/lib/docs-source.ts";
import { repoBlobUrl, SUPPORTER_SIGNING_INTERIM_NOTICE, SUPPORTER_SIGNING_OPEN } from "@/lib/site-facts.ts";
import { PRINCIPLES_SLUG, principlesRoute } from "@/lib/spec-nav-slugs.ts";

// The PDPP Principles, served at their own top-level route.
//
// Everything here mirrors /governance, and for the same reasons: the document
// is AUTHORED as a fumadocs page (content/docs/principles.mdx, generated from
// the repo-root PRINCIPLES.md by scripts/sync-spec-docs.mjs) because the TOC,
// the Copy Markdown affordance and search indexing all come from membership in
// that collection — /api/search indexes the fumadocs source and nothing else.
// It is SERVED here rather than at /specification/principles because it is not
// a specification. fumadocs still routes the page under /specification, which
// 308-redirects here (see next.config.mjs) so the document is not served at two
// addresses.

export default async function Page() {
  const page = source.getPage([PRINCIPLES_SLUG]);

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
            {/* The repo-root PRINCIPLES.md, NOT content/docs/principles.mdx:
                the latter is generated and gitignored, so a blob link to it
                404s on GitHub. Root is also where a reader is meant to find
                this document. */}
            <ViewOptions githubUrl={repoBlobUrl("PRINCIPLES.md")} markdownUrl={getPageMarkdownUrl(page).url} />
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
        {/* The document's last section is "Add your name", which describes
            signing in the present tense. Signing is not open yet, so ONE
            notice follows the rendered document saying what it is waiting on.
            No form: there is nowhere for a signature to go until the register
            has a host. Both the flag and the wording live in site-facts.ts, so
            opening signing is a single edit there. */}
        {SUPPORTER_SIGNING_OPEN ? null : (
          <Callout title="Not yet open" type="info">
            {SUPPORTER_SIGNING_INTERIM_NOTICE}.
          </Callout>
        )}
      </DocsBody>
    </DocsPage>
  );
}

export function generateMetadata(): Metadata {
  const page = source.getPage([PRINCIPLES_SLUG]);

  if (!page) {
    notFound();
  }

  // Canonical is this route, not page.url (which fumadocs resolves to
  // /specification/principles, the URL that redirects here).
  return {
    alternates: { canonical: principlesRoute },
    description: page.data.description,
    openGraph: { url: principlesRoute },
    title: page.data.title,
  };
}
