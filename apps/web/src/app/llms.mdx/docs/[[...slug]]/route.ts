import { notFound } from 'next/navigation';
import { getLLMText } from '@/lib/get-llm-text';
import { source } from '@/lib/docs-source';

type RouteContext = {
  params: Promise<{
    slug?: string[];
  }>;
};

export const revalidate = false;

export async function GET(_: Request, { params }: RouteContext) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  return new Response(await getLLMText(page), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
    },
  });
}

export function generateStaticParams() {
  return source.generateParams();
}
