// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripLeadingDocumentTitle } from "@/lib/openspec/parse.ts";
import { cn } from "@/lib/utils.ts";
import "./prose-page.css";

// Shared reading surface: the tinted card and the markdown renderer. The two
// exported variants below each own one interpretation of the leading `# Title`
// line — strip it or keep it — so a caller states which markdown shape it's
// passing instead of negating a flag.
function ProsePageShell({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border/60 bg-card px-5 py-5 md:px-8 md:py-7", className)}>
      <div className="prose-page max-w-[76ch] text-[0.96rem] text-foreground leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}

// For markdown whose leading `# Title` line is redundant with a heading the
// page already renders elsewhere (e.g. a doc pulled into a page that has its
// own title). Strips that line before rendering.
export function ProsePage({ markdown, className }: { markdown: string; className?: string }) {
  return <ProsePageShell className={className} markdown={stripLeadingDocumentTitle(markdown)} />;
}

// For markdown that should render exactly as authored, leading title included
// (e.g. a self-contained excerpt shown as a standalone artifact).
export function VerbatimProsePage({ markdown, className }: { markdown: string; className?: string }) {
  return <ProsePageShell className={className} markdown={markdown} />;
}
