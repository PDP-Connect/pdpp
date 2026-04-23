import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

export function OpenSpecMarkdownPage({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'openspec-prose max-w-none text-[0.95rem] leading-relaxed text-foreground',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
