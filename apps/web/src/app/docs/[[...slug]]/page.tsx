import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { getMDXComponents } from '@/components/mdx';
import { getPageImage, getPageMarkdownUrl, source } from '@/lib/docs-source';

type DocsPageProps = {
  params: Promise<{
    slug?: string[];
  }>;
};

export default async function Page({ params }: DocsPageProps) {
  const resolved = await params;
  const page = source.getPage(resolved.slug);

  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const githubPath = page.path;
  const sectionLabel = page.slugs[0]?.startsWith('e2e') ? 'Examples' : 'Protocol Spec';

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} className="pdpp-docs-page">
      <div className="pdpp-docs-hero">
        <div className="pdpp-eyebrow">{sectionLabel}</div>
        <DocsTitle className="pdpp-docs-title">{page.data.title}</DocsTitle>
        <DocsDescription className="pdpp-docs-description">{page.data.description}</DocsDescription>
        <div className="pdpp-docs-actions">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover
            markdownUrl={markdownUrl}
            githubUrl={`https://github.com/vana-com/pdpp/blob/main/apps/web/content/docs/${githubPath}`}
          />
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

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const resolved = await params;
  const page = source.getPage(resolved.slug);

  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      images: getPageImage(page).url,
    },
  };
}
