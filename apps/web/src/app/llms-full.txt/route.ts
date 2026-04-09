import { getLLMText } from '@/lib/get-llm-text';
import { source } from '@/lib/docs-source';

export const revalidate = false;

export async function GET() {
  const scan = source.getPages().map(getLLMText);
  const scanned = await Promise.all(scan);

  return new Response(scanned.join('\n\n'), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
    },
  });
}
