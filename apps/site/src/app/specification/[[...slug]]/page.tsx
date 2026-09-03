// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { findNeighbour } from "fumadocs-core/page-tree";
import { DocsBody, DocsDescription, DocsPage } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LLMCopyButton, ViewOptions } from "@/components/ai/page-actions.tsx";
import { getMDXComponents } from "@/components/mdx/mdx.tsx";
import { ResponsiveSpecTable } from "@/components/mdx/responsive-table.tsx";
import { PdppGovernanceStages } from "@/components/site/governance-stages.tsx";
import { Text } from "@/components/typography/text.tsx";
import { getPageMarkdownUrl, source } from "@/lib/docs-source.ts";
import { repoBlobUrl } from "@/lib/site-facts.ts";
import { getGovernanceFrontMatter } from "@/lib/spec-front-matter.ts";
import { GOVERNANCE_SLUG, MAINTAINER_DOC_SLUGS, specDocExtension } from "@/lib/spec-nav-slugs.ts";

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

  const { body: MDX, toc } = await page.data.load();
  const markdownUrl = getPageMarkdownUrl(page).url;
  const githubPath = page.path;

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
      // The left rail lists DOCUMENTS (the spec's sibling files), not this
      // page's own headings — it has no per-page section nav. Fumadocs' own
      // right-hand TOC column supplies that, restyled in specification.css to
      // sit as its own column distinct from the rail. The popover (the
      // narrow-viewport affordance) stays: below the width the rail unmounts
      // at, it is the only way to reach the headings.
      toc={toc}
    >
      <div className="pdpp-docs-hero">
        <div className="pdpp-docs-hero__content">
          <Text as="h1" size="display">
            {page.data.title}
          </Text>
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
            table: ResponsiveSpecTable,
          })}
        />
        {/* The governance document is rendered INTO this page, at #governance,
            rather than at a standalone route: /governance now redirects here.
            One page carries the protocol and the programme that stewards it,
            which is the relationship the four-intent structure is asserting.
            Only the root slug gets it — a reader on an extension profile is
            not asking about governance. */}
        {isRootSlug && <GovernanceSection />}
      </DocsBody>
    </DocsPage>
  );
}

// GOVERNANCE.md, rendered from the same generated fumadocs collection the spec
// body comes from, so it keeps the repo-root file as its single source.
async function GovernanceSection() {
  const governancePage = source.getPage([GOVERNANCE_SLUG]);

  if (!governancePage) {
    return null;
  }

  const { body: GovernanceMDX } = await governancePage.data.load();

  return (
    <section className="mt-24 border-border border-t pt-16" id="governance">
      <div className="flex flex-col gap-3">
        <Text as="p" color="subtle" family="mono" size="stamp">
          Governance · {getGovernanceFrontMatter().status} · {getGovernanceFrontMatter().circulated}
        </Text>
        <Text as="h2" size="title">
          Who runs this, and who decides
        </Text>
        <Text as="p" className="max-w-[68ch]" size="lede" wrap="pretty">
          Two parts. Part A is how it runs from 15 October. Part B is how we propose it runs once there is an elected
          committee.
        </Text>
      </div>

      <PdppGovernanceStages className="mt-10" />

      <div className="mt-16">
        <GovernanceMDX
          components={getMDXComponents({
            a: createRelativeLink(source, governancePage),
            table: ResponsiveSpecTable,
          })}
        />
      </div>
    </section>
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
  //
  // The maintainer documents — guides, design rationale, architectural context,
  // deferred concerns, open questions and the superseded Data Query API — are
  // noindex'd so they stay reachable by URL but never rank against the
  // specification. They are listed only on /maintainers, which is itself
  // unlinked and noindex.
  //
  // Noindexing an index page while leaving the documents it links fully
  // indexable is the defect this avoids: the pages meant to be off the public
  // surface stayed crawlable and ranked, reachable from search even though
  // nothing in the rail pointed at them.
  const isInternalNotesPage = page.path === "README.md";
  const isMaintainerDoc = MAINTAINER_DOC_SLUGS.some(
    (maintainerSlug) => page.path === `${maintainerSlug}.${specDocExtension(maintainerSlug)}`
  );
  const canonicalUrl = isRootSlug ? "/specification" : page.url;

  return {
    alternates: { canonical: canonicalUrl },
    description: page.data.description,
    openGraph: { url: canonicalUrl },
    robots: isInternalNotesPage || isMaintainerDoc ? { follow: false, index: false } : undefined,
    title: page.data.title,
  };
}
