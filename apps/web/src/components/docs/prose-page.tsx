import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripLeadingDocumentTitle } from "@/lib/openspec/parse.ts";
import { cn } from "@/lib/utils.ts";

export function ProsePage({
  markdown,
  className,
  trimDocumentTitle = true,
}: {
  markdown: string;
  className?: string;
  trimDocumentTitle?: boolean;
}) {
  const renderedMarkdown = trimDocumentTitle ? stripLeadingDocumentTitle(markdown) : markdown;

  return (
    <div className={cn("rounded-xl border border-border/60 bg-card px-5 py-5 md:px-8 md:py-7", className)}>
      <div className="docs-prose max-w-[76ch] text-[0.96rem] text-foreground leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{renderedMarkdown}</ReactMarkdown>
      </div>
    </div>
  );
}
