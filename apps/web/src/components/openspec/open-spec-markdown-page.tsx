import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripLeadingDocumentTitle } from "@/lib/openspec/parse.ts";
import { cn } from "@/lib/utils.ts";

export function OpenSpecMarkdownPage({
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
    <div
      className={cn(
        "rounded-[1.1rem] border border-border/60 bg-[color-mix(in_oklab,var(--muted)_42%,white)] px-5 py-5 md:px-8 md:py-7",
        className
      )}
    >
      <div className="openspec-prose max-w-[76ch] text-[0.96rem] text-foreground leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{renderedMarkdown}</ReactMarkdown>
      </div>
    </div>
  );
}
